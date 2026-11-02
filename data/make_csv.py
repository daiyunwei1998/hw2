"""Turn the raw HW2 export (raw/all_events.json) into tidy CSVs. Run: python make_csv.py"""
import csv, json
from pathlib import Path
HERE = Path(__file__).parent
ev = json.load(open(HERE / "raw" / "all_events.json", encoding="utf-8"))["events"]
ev.sort(key=lambda e: (e["pid"], e["seq"]))
TEST_PIDS = {"TEST"}

P = {}
for e in ev:
    p = P.setdefault(e["pid"], {"pid": e["pid"], "is_test": e["pid"] in TEST_PIDS, "n_events": 0, "n_main": 0, "n_adjust": 0,
                                "hp_attempts": 0, "hp_best_correct": None, "hp_pass": None, "attention_effort": None,
                                "attention_content_correct": None, "attention_pass": None, "finished": False,
                                "n_client_errors": 0, "first_ts": e["server_ts"]})
    p["n_events"] += 1; p["last_ts"] = e["server_ts"]
    x = e.get("payload") or {}
    t = e["type"]
    if t == "session":
        p.update(list=x.get("list"), mode=x.get("mode"), design_version=e.get("design_version"), lang=x.get("lang"),
                 tz=x.get("tz"), device="iPhone" if "iPhone" in x.get("ua", "") else ("Windows" if "Windows" in x.get("ua", "") else x.get("ua", "")[:40]),
                 screen="x".join(map(str, x.get("screen") or [])))
    elif t == "demo":
        for k in ("age", "gender", "native", "hearing", "english", "speed", "speed_x", "sr", "phones"):
            p[f"demo_{k}"] = x.get(k)
        p["demo_seen"] = "; ".join(x.get("seen") or [])
    elif t == "hp_check":
        p["hp_attempts"] += 1
        p["hp_best_correct"] = max(p["hp_best_correct"] or 0, x.get("correct", 0))
        p["hp_pass"] = bool(p["hp_pass"]) or bool(x.get("pass"))
    elif t == "trial":
        if x.get("kind") == "main": p["n_main"] += 1
        if x.get("kind") == "attention":
            p["attention_effort"] = x.get("effort"); p["attention_content_correct"] = x.get("content_correct")
            p["attention_pass"] = x.get("effort") == 1
    elif t == "adjust": p["n_adjust"] += 1
    elif t == "final": p["final_tech_issue"] = x.get("tech"); p["final_comment"] = x.get("comment")
    elif t == "finish": p["finished"] = True; p["resumes"] = x.get("resumes")
    elif t == "client_error": p["n_client_errors"] += 1
for p in P.values():
    p["include"] = p["finished"] and not p["is_test"]

PCOLS = ["pid", "include", "is_test", "finished", "list", "mode", "design_version", "device", "screen", "lang", "tz",
         "demo_age", "demo_gender", "demo_native", "demo_hearing", "demo_english", "demo_speed", "demo_speed_x", "demo_sr",
         "demo_phones", "demo_seen", "hp_attempts", "hp_best_correct", "hp_pass", "attention_effort",
         "attention_content_correct", "attention_pass", "n_main", "n_adjust", "n_events", "n_client_errors", "resumes",
         "final_tech_issue", "final_comment", "first_ts", "last_ts"]
TCOLS = ["pid", "include", "list", "trial_no", "kind", "item", "clip", "ver", "k", "bin", "rate", "syl_per_s", "narr_dur",
         "file", "status", "content_choice", "content_choice_text", "content_correct", "content_rt_ms", "accept",
         "accept_rt_ms", "effort", "effort_rt_ms", "jar", "jar_rt_ms", "audio_played_ms", "hidden_during_audio",
         "audio_error", "opt_order", "play_started", "client_ts", "server_ts", "seq"]
ACOLS = ["pid", "include", "list", "adj_no", "item", "start_k", "final_k", "final_rate", "final_syl_per_s", "n_plays",
         "path", "total_ms", "client_ts", "server_ts", "seq"]

def rows(kind):
    for e in ev:
        if e["type"] != kind: continue
        x = dict(e["payload"]); p = P[e["pid"]]
        x.update(pid=e["pid"], include=p["include"], list=p.get("list"), seq=e["seq"], client_ts=e["client_ts"], server_ts=e["server_ts"])
        if kind == "trial": x["audio_played_ms"] = (x.get("audio") or {}).get("played_ms")
        yield x

def write(name, cols, rs):
    enc = lambda v: "" if v is None else (json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v)
    with open(HERE / name, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f); w.writerow(cols); n = 0
        for r in rs: w.writerow([enc(r.get(c)) for c in cols]); n += 1
    print(name, n, "rows")

write("participants.csv", PCOLS, sorted(P.values(), key=lambda p: p["first_ts"]))
write("trials.csv", TCOLS, rows("trial"))
write("adjust.csv", ACOLS, rows("adjust"))
