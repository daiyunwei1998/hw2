"""Build data/segments.json from REFRAMED (validation split) + draft zh-TW translations.

Usage:  python build_data.py            # refuses to overwrite an existing segments.json
        python build_data.py --force    # rebuild (your edits in segments.json would be lost)
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
REFRAMED = Path(r"N:\datasets\reframed")
CLIPS_DIR = REFRAMED / "clips"
SAMPLE = ["UMBOdTivgjBj", "CQEeb6wSS97K", "T9bfm2XbXjx_"]
OUT = HERE / "data" / "segments.json"


def parse_srt(s):
    def t(x):
        h, m, sec = x.replace(",", ".").split(":")
        return round(int(h) * 3600 + int(m) * 60 + float(sec), 3)

    cues = []
    for block in re.split(r"\n\s*\n", (s or "").strip()):
        lines = block.strip().split("\n")
        if len(lines) >= 3 and "-->" in lines[1]:
            a, b = lines[1].split(" --> ")
            cues.append([t(a), t(b), " ".join(l.strip() for l in lines[2:])])
    return cues


def main():
    if OUT.exists() and "--force" not in sys.argv:
        sys.exit(f"{OUT} exists; pass --force to rebuild (this discards edits).")
    rows = {}
    with open(REFRAMED / "validation.jsonl", encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            rows[r["video_id"]] = r
    tr = json.load(open(HERE / "data" / "translations_draft.json", encoding="utf-8"))

    clips = {}
    for vid in SAMPLE:
        r = rows[vid]
        versions = {}
        for ver in ("us", "uk"):
            cues = parse_srt(r[f"audio_description_{ver}"])
            zh = tr["segments"][vid][ver]
            assert len(zh) == len(cues), (vid, ver, len(zh), len(cues))
            versions[ver] = [
                {"start": a, "end": b, "en": en, "zh_draft": z, "zh": z,
                 "status": "draft", "note": "", "updated": None, "history": []}
                for (a, b, en), z in zip(cues, zh)
            ]
        clips[vid] = {
            "movie": r["rottentomatoes_id"],
            "imdb_id": r["imdb_id"],
            "duration": float(r["video_duration"]),
            "video": str(CLIPS_DIR / f"{vid}.mp4"),
            "subs": parse_srt(r["subtitles"]),
            "glossary": tr["glossary"].get(vid, {}),
            "versions": versions,
        }
    OUT.parent.mkdir(exist_ok=True)
    json.dump({"source": "REFRAMED validation split (CC BY-NC 4.0)", "clips": clips},
              open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("wrote", OUT, {v: {k: len(x) for k, x in c["versions"].items()} for v, c in clips.items()})


if __name__ == "__main__":
    main()
