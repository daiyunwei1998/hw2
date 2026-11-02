# AD 旁白審稿工具（REFRAMED → 中文 → TTS → 語速）

## 執行
```
python app.py        # http://127.0.0.1:8765
```
需要：NAS `N:` 已連線、`pip install flask edge-tts cryptography`、ffmpeg（含 rubberband）。

## 資料流
1. **來源**：REFRAMED validation split（`N:\datasets\reframed\validation.jsonl`，CC BY-NC 4.0）。AD 時間戳相對於片段起點。
2. **影片**：用 REFRAMED 提供的方法下載 Rotten Tomatoes 片段（`videos_encrypted.sh` 解密後的 ffmpeg 指令），存在 `N:\datasets\reframed\clips\`，不放進 Dropbox、不公開。
3. **翻譯**：`data/translations_draft.json` 是 Claude 的 zh-TW 初稿（每個 AD cue 一行，譯名表在 `glossary`）。
4. **審稿資料**：`build_data.py` 產生 `data/segments.json`。網頁上的修改直接寫回這個檔案，每次儲存都把舊版本存進 `history`。
   `python build_data.py --force` 會用初稿重建，**會清掉所有修改**。
5. **TTS**：edge-tts（預設 zh-TW-HsiaoChenNeural）→ 去頭尾靜音 → rubberband 變速（保持音高，1.0x 也經過同一流程）→ 兩階段 loudnorm（−20 LUFS）。快取在 `N:\datasets\reframed\tts_cache\`，以「聲音＋文字＋語速＋處理流程版本」為 key，改字就會重新產生。

## 名詞
- **句組**：REFRAMED 常把一句話切成好幾個相連的 cue（間隔 < 0.3 s）。句組會把它們合成一句念，可用空檔也以整組計算。
- **可用空檔**：從 cue 開始，到下一句對白字幕、下一個 AD cue（同版本）或片尾，取最早者。

## 樣本片段
| video_id | 電影 | US cues | UK cues |
|---|---|---|---|
| UMBOdTivgjBj | Liar Liar | 46 | 26 |
| CQEeb6wSS97K | The Girl with the Dragon Tattoo（無對白字幕） | 44 | 25 |
| T9bfm2XbXjx_ | The Thing (2011) | 52 | 45 |
