"""Render HW2 stimuli (stratified-random speech-rate design) and write web/public/design.json.

    python build_design.py            # render missing files, write manifest
    python build_design.py --check    # only report durations / gap fit, render nothing

Stimulus = original clip audio excerpt [t0-PRE, t0+dur(k=0)+POST] (same length for every rate of an item),
loudness-normalised to BG_LUFS, ducked by DUCK_DB while the narration plays, narration (-20 LUFS, from app.tts_rate)
starting PRE seconds into the excerpt. Mono 44.1 kHz MP3. File names are content hashes (no condition info).
"""
import hashlib
import json
import math
import re
import sys
from pathlib import Path

import app  # TTS + rate chain shared with the review tool

HERE = Path(__file__).parent
ITEMS = json.load(open(HERE / "data" / "design_items.json", encoding="utf-8"))
OUT_DIR = Path(r"N:\datasets\reframed\stimuli_v2")
BG_DIR = OUT_DIR / "_bg"
WEB_DESIGN = HERE / "web" / "design.json"  # uploaded to Blob by upload_stimuli.py, served by /api/design

N_RATES, R_MAX, N_BINS = 24, 3.0, 6
RATES = [round(R_MAX ** (k / (N_RATES - 1)), 4) for k in range(N_RATES)]
PRE, POST, FADE = 3.0, 2.0, 0.2
BG_LUFS, DUCK_DB, RAMP_IN, RAMP_OUT = -26.0, -10.0, 0.2, 0.3
MIX_CHAIN = f"mix-v1|pre{PRE}|post{POST}|bg{BG_LUFS}|duck{DUCK_DB}|{RAMP_IN}/{RAMP_OUT}|mp3-96k-mono|{app.CHAIN}"
VOICE = app.VOICES[0]

db = app.load()


def item_text(it):
    segs = db["clips"][it["clip"]]["versions"][it["ver"]]
    a, b = it["cues"]
    return it.get("narration_override") or "".join(s["zh"].strip() for s in segs[a:b + 1])


def item_onset_window(it):
    c = db["clips"][it["clip"]]
    segs = c["versions"][it["ver"]]
    a, b = it["cues"]
    t0 = segs[a]["start"]
    ends = [c["duration"]] + [s for s, e, _ in c["subs"] if s > t0 + 0.05]
    if b + 1 < len(segs):
        ends.append(segs[b + 1]["start"])
    return t0, min(ends) - t0


def bg_excerpt(it, t_start, length):
    """Loudness-normalised mono excerpt of the clip soundtrack (cached)."""
    video = db["clips"][it["clip"]]["video"]
    k = app.key("bg", it["clip"], f"{t_start:.3f}", f"{length:.3f}", BG_LUFS)
    out = BG_DIR / f"bg_{k}.wav"
    if out.exists():
        return out
    BG_DIR.mkdir(parents=True, exist_ok=True)
    raw = BG_DIR / f"raw_{k}.wav"
    app.run([app.FFMPEG, "-v", "error", "-y", "-ss", f"{t_start:.3f}", "-t", f"{length:.3f}", "-i", video,
             "-vn", "-ac", "1", "-ar", "44100", str(raw)])
    p = app.run([app.FFMPEG, "-v", "info", "-hide_banner", "-i", str(raw), "-af",
                 f"loudnorm=I={BG_LUFS}:TP=-2:LRA=20:print_format=json", "-f", "null", "-"])
    m = json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", p.stderr, re.S).group(0))
    if m["input_i"] in ("-inf", "inf") or float(m["input_i"]) < -70:  # (near-)silent excerpt: leave as is
        raw.rename(out)
        return out
    norm = (f"loudnorm=I={BG_LUFS}:TP=-2:LRA=20:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
            f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    app.run([app.FFMPEG, "-v", "error", "-y", "-i", str(raw), "-af", norm, "-ar", "44100", str(out)])
    raw.unlink(missing_ok=True)
    return out


def render(it, k, text, length, check=False):
    rate = RATES[k]
    narr = app.tts_rate(text, VOICE, rate)
    dur = app.duration(narr)
    name = "s_" + hashlib.sha1(f"{it['id']}|{k}|{text}|{length:.3f}|{MIX_CHAIN}".encode()).hexdigest()[:12] + ".mp3"
    out = OUT_DIR / name
    if not check and not out.exists():
        t0, _ = item_onset_window(it)
        bg = bg_excerpt(it, t0 - PRE, length)
        g = 10 ** (DUCK_DB / 20)
        a, b = PRE - RAMP_IN, PRE + dur
        duck = (f"volume='1-(1-{g:.5f})*max(0,min(1,min((t-{a:.3f})/{RAMP_IN},({b + RAMP_OUT:.3f}-t)/{RAMP_OUT})))'"
                f":eval=frame")
        fc = (f"[0:a]{duck}[bg];[1:a]aresample=44100,adelay={int(PRE * 1000)}:all=1[n];"
              f"[bg][n]amix=inputs=2:duration=first:normalize=0,"
              f"afade=t=in:d={FADE},afade=t=out:st={length - FADE:.3f}:d={FADE}[o]")
        app.run([app.FFMPEG, "-v", "error", "-y", "-i", str(bg), "-i", str(narr), "-filter_complex", fc,
                 "-map", "[o]", "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "96k", str(out)])
    n = app.cjk_count(text)
    return {"k": k, "rate": rate, "file": name, "narr_dur": round(dur, 3), "syl_per_s": round(n / dur, 3)}


def build_item(it, ks, check):
    text = item_text(it)
    t0, window = item_onset_window(it)
    base = app.duration(app.tts_rate(text, VOICE, 1.0))
    length = round(PRE + base + POST, 3)
    files = [render(it, k, text, length, check) for k in ks]
    fits = base <= window + 1e-6
    print(f"{it['id']:3} {text[:22]:22} chars={app.cjk_count(text):2} t0={t0:7.2f} dur1.0={base:5.2f} "
          f"window={window:5.2f} {'OK' if fits else 'DOES NOT FIT'}", flush=True)
    rec = {k: it[k] for k in ("id", "clip", "ver", "cues") if k in it}
    rec.update({"text": text, "chars": app.cjk_count(text), "onset_in_clip": t0, "window": round(window, 3),
                "excerpt_len": length, "narr_onset": PRE, "fits_gap_at_1x": fits, "stimuli": files})
    for f in ("q", "options", "answer"):
        if f in it:
            rec[f] = it[f]
    return rec


def main():
    check = "--check" in sys.argv
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    allk = list(range(N_RATES))
    main_items = [build_item(it, allk, check) for it in ITEMS["main"]]
    adjust = [build_item(it, allk, check) for it in ITEMS["adjust"]]
    practice = build_item(ITEMS["practice"], [ITEMS["practice"]["k"]], check)
    attention = build_item(ITEMS["attention"], [ITEMS["attention"]["k"]], check)
    # Latin-square groups: round-robin over the film-ordered item list so every group mixes films.
    groups = [[] for _ in range(N_BINS)]
    for i, it in enumerate(main_items):
        groups[i % N_BINS].append(it["id"])
    design = {
        "version": ITEMS["version"],
        "chain": MIX_CHAIN,
        "voice": VOICE,
        "rates": RATES,
        "n_bins": N_BINS,
        "bin_of_k": [k * N_BINS // N_RATES for k in range(N_RATES)],
        "groups": groups,  # list L assigns group g -> bin (g + L) % n_bins
        "n_lists": N_BINS,
        "main": main_items,
        "adjust": adjust,
        "practice": practice,
        "attention": attention,
        "source": "REFRAMED (Sterner et al., 2026) AD text, CC BY-NC 4.0; zh-TW translation by the study team",
    }
    if check:
        print("check only; manifest not written")
        return
    WEB_DESIGN.parent.mkdir(parents=True, exist_ok=True)
    json.dump(design, open(WEB_DESIGN, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    names = {s["file"] for it in main_items + adjust + [practice, attention] for s in it["stimuli"]}
    missing = [n for n in names if not (OUT_DIR / n).exists()]
    size = sum((OUT_DIR / n).stat().st_size for n in names if (OUT_DIR / n).exists())
    print(f"wrote {WEB_DESIGN}; {len(names)} stimuli, {size / 1e6:.1f} MB, missing={len(missing)}")
    print("groups:", groups)


if __name__ == "__main__":
    main()
