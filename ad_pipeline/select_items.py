"""List candidate HW2 items: contiguous AD cue groups whose 1.0x zh-TW TTS fits the dialogue gap."""
import json, sys, csv
sys.stdout.reconfigure(encoding="utf-8")
import app

GAP = 0.3
db = app.load()
rows = []
for vid, c in db["clips"].items():
    for ver, segs in c["versions"].items():
        i = 0
        while i < len(segs):
            j = i
            while j + 1 < len(segs) and segs[j + 1]["start"] - segs[j]["end"] < GAP:
                j += 1
            start = segs[i]["start"]
            ends = [c["duration"]] + [a for a, b, t in c["subs"] if a > start + 0.05]
            if j + 1 < len(segs):
                ends.append(segs[j + 1]["start"])
            win = min(ends) - start
            zh = "".join(s["zh"].strip() for s in segs[i:j + 1])
            en = " ".join(s["en"] for s in segs[i:j + 1])
            dur = app.duration(app.tts_rate(zh, app.VOICES[0], 1.0))
            overlap = any(a < start + dur and b > start for a, b, t in c["subs"])
            rows.append(dict(clip=vid, movie=c["movie"], ver=ver, cues=f"{i}-{j}", start=round(start, 2),
                             chars=app.cjk_count(zh), dur10=round(dur, 2), window=round(win, 2),
                             fits=dur <= win, dialogue_overlap=overlap, zh=zh, en=en))
            i = j + 1
ok = [r for r in rows if r["fits"] and not r["dialogue_overlap"] and 12 <= r["chars"] <= 30]
print(len(rows), "groups;", len(ok), "eligible")
for m in sorted({r["movie"] for r in ok}):
    print(m, sum(r["movie"] == m for r in ok))
with open("data/item_candidates.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0]))
    w.writeheader(); w.writerows(rows)
for r in ok:
    print(f"{r['movie'][:12]:12} {r['ver']} {r['cues']:>6} {r['start']:>7} {r['chars']:>3}字 {r['dur10']:>5}s/{r['window']:>5}s  {r['zh']}")
