"""AD translation / TTS / speech-rate review tool.

Run:  python app.py   ->  http://127.0.0.1:8765
Edits are saved to data/segments.json (each save keeps the previous version in `history`).
TTS audio is cached in CACHE_DIR, keyed by voice + text + rate, so editing text regenerates it.
"""
import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
from datetime import datetime
from pathlib import Path

import edge_tts
from flask import Flask, abort, jsonify, request, send_file, send_from_directory

HERE = Path(__file__).parent
DATA = HERE / "data" / "segments.json"
CACHE_DIR = Path(os.environ.get("AD_CACHE", r"N:\datasets\reframed\tts_cache"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)

FFMPEG = shutil.which("ffmpeg") or str(Path(os.environ["LOCALAPPDATA"]) / r"Microsoft\WinGet\Links\ffmpeg.exe")
FFPROBE = shutil.which("ffprobe") or str(Path(os.environ["LOCALAPPDATA"]) / r"Microsoft\WinGet\Links\ffprobe.exe")
VOICES = ["zh-TW-HsiaoChenNeural", "zh-TW-YunJheNeural", "zh-TW-HsiaoYuNeural"]
TARGET_LUFS = -20.0
# Bump when the audio processing chain changes so cached files are rebuilt.
CHAIN = "v1:trim-50dB|rubberband|loudnorm2pass"

app = Flask(__name__, static_folder=None)
_lock = threading.Lock()
_gen_locks: dict[str, threading.Lock] = {}


def load():
    with open(DATA, encoding="utf-8") as f:
        return json.load(f)


def save(db):
    tmp = DATA.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=1)
    os.replace(tmp, DATA)


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise RuntimeError(p.stderr[-800:])
    return p


def duration(path):
    out = run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]).stdout
    return float(out.strip())


def key(*parts):
    return hashlib.sha1("|".join(map(str, parts)).encode("utf-8")).hexdigest()[:16]


def gen_lock(k):
    with _lock:
        return _gen_locks.setdefault(k, threading.Lock())


def tts_base(text, voice):
    """Raw TTS, leading/trailing silence trimmed. Same file feeds every rate."""
    k = key("base", voice, text, CHAIN)
    out = CACHE_DIR / f"base_{k}.wav"
    with gen_lock(out.name):
        if not out.exists():
            raw = CACHE_DIR / f"raw_{k}.mp3"
            asyncio.run(edge_tts.Communicate(text, voice).save(str(raw)))
            trim = ("silenceremove=start_periods=1:start_threshold=-50dB,areverse,"
                    "silenceremove=start_periods=1:start_threshold=-50dB,areverse")
            run([FFMPEG, "-v", "error", "-y", "-i", str(raw), "-af", trim, "-ac", "1", "-ar", "48000", str(out)])
            raw.unlink(missing_ok=True)
    return out


def tts_rate(text, voice, rate):
    """Time-stretch (pitch preserved) + 2-pass loudness normalisation. 1.0x goes through the same chain."""
    base = tts_base(text, voice)
    k = key("rate", voice, text, f"{rate:.4f}", CHAIN)
    out = CACHE_DIR / f"r_{k}.mp3"
    with gen_lock(out.name):
        if not out.exists():
            stretch = f"rubberband=tempo={rate}"
            p = run([FFMPEG, "-v", "info", "-hide_banner", "-i", str(base), "-af",
                     f"{stretch},loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"])
            m = json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", p.stderr, re.S).group(0))
            norm = (f"loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
                    f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
            run([FFMPEG, "-v", "error", "-y", "-i", str(base), "-af", f"{stretch},{norm}", "-ar", "48000",
                 "-c:a", "libmp3lame", "-q:a", "2", str(out)])
    return out


def cjk_count(s):
    return len(re.findall(r"[\u3400-\u9fff]", s))


# ---------------------------------------------------------------- routes
@app.get("/")
def index():
    return send_from_directory(HERE / "static", "index.html")


@app.get("/api/clips")
def clips():
    db = load()
    return jsonify([{"id": k, "movie": c["movie"], "duration": c["duration"],
                     "n": {v: len(s) for v, s in c["versions"].items()},
                     "reviewed": {v: sum(x["status"] != "draft" for x in s) for v, s in c["versions"].items()}}
                    for k, c in db["clips"].items()])


@app.get("/api/clip/<vid>")
def clip(vid):
    c = load()["clips"].get(vid) or abort(404)
    c = {k: v for k, v in c.items() if k != "video"}
    return jsonify(c)


@app.post("/api/segment/<vid>/<ver>/<int:idx>")
def update_segment(vid, ver, idx):
    body = request.get_json(force=True)
    with _lock:
        db = load()
        try:
            seg = db["clips"][vid]["versions"][ver][idx]
        except (KeyError, IndexError):
            abort(404)
        new = {k: body[k] for k in ("zh", "status", "note") if k in body}
        if "zh" in new:
            new["zh"] = new["zh"].strip()
        if all(seg.get(k) == v for k, v in new.items()):
            return jsonify(seg)
        seg["history"].append({k: seg.get(k) for k in ("zh", "status", "note", "updated")})
        seg.update(new)
        seg["updated"] = datetime.now().isoformat(timespec="seconds")
        save(db)
    return jsonify(seg)


@app.get("/api/tts/<vid>/<ver>/<int:idx>")
def tts(vid, ver, idx):
    """Synthesise cues idx .. idx+span-1 joined into one utterance.
    `text` (optional) overrides the saved zh of cue `edit_idx`, for auditioning unsaved edits."""
    try:
        segs = load()["clips"][vid]["versions"][ver]
        span = int(request.args.get("span", 1))
        parts = [s["zh"] for s in segs[idx:idx + span]]
        assert len(parts) == span >= 1
    except (KeyError, ValueError, AssertionError):
        abort(404)
    rate = float(request.args.get("rate", 1.0))
    voice = request.args.get("voice", VOICES[0])
    if voice not in VOICES or not (0.5 <= rate <= 4.0):
        abort(400)
    if "text" in request.args:
        e = int(request.args.get("edit_idx", idx)) - idx
        if 0 <= e < span:
            parts[e] = request.args["text"]
    text = "".join(p.strip() for p in parts)
    if not text:
        return jsonify({"error": "空白文字"}), 400
    try:
        path = tts_rate(text, voice, rate)
    except Exception as e:  # surface TTS/ffmpeg errors in the UI
        return jsonify({"error": str(e)}), 500
    dur = duration(path)
    n = cjk_count(text)
    return jsonify({"url": f"/cache/{path.name}", "duration": round(dur, 3), "rate": rate, "voice": voice, "text": text,
                    "chars": n, "syl_per_s": round(n / dur, 2) if dur else None})


@app.get("/cache/<name>")
def cache(name):
    return send_from_directory(CACHE_DIR, name)


@app.get("/video/<vid>")
def video(vid):
    c = load()["clips"].get(vid) or abort(404)
    return send_file(c["video"], mimetype="video/mp4", conditional=True)


@app.get("/api/meta")
def meta():
    return jsonify({"voices": VOICES, "target_lufs": TARGET_LUFS, "chain": CHAIN})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 8765)), threaded=True, debug=False)
