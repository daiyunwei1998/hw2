"""HW2 analysis (follows the pre-specified plan in report/hw2_report.tex, Results section).

    python hw2_analysis.py [--set main|strict|all]

Reads ../data/{trials,adjust,participants}.csv. Writes results_<set>.json and figs/fig_psy_<set>.pdf.
Sample sets:
  all    : every finished, non-test participant
  main   : all, minus attention-check failures (attention = content question of item AC answered correctly; see report)
  strict : main, minus headphone-check failures (pre-specified primary set)
"""
import argparse, csv, json, math
from pathlib import Path
import numpy as np
from scipy.optimize import minimize
from scipy.stats import spearmanr

HERE = Path(__file__).parent
DATA = HERE.parent / "data" if (HERE.parent / "data").exists() else HERE / "data"
ap = argparse.ArgumentParser(); ap.add_argument("--set", default="main"); ap.add_argument("--boot", type=int, default=2000); ap.add_argument("--plot-only", action="store_true")
args = ap.parse_args()
rd = lambda n: list(csv.DictReader(open(DATA / n, encoding="utf-8-sig")))
P = {r["pid"]: r for r in rd("participants.csv") if r["include"] == "True"}
keep = {p for p, r in P.items()
        if (args.set == "all")
        or (args.set == "main" and r["attention_content_correct"] == "1")
        or (args.set == "strict" and r["attention_content_correct"] == "1" and r["hp_pass"] == "True")}
PIDS = sorted(keep)
T = [r for r in rd("trials.csv") if r["pid"] in keep]
A = [r for r in rd("adjust.csv") if r["pid"] in keep]
main = [r for r in T if r["kind"] == "main" and r["status"] == "ok"]
X1 = 4.6  # mean syl/s at 1.0x (report)
GAMMA = 0.25

def arr(rows):
    x = np.log(np.array([float(r["syl_per_s"]) for r in rows]))
    c = np.array([int(r["content_correct"]) for r in rows])
    a = np.array([int(r["accept"]) for r in rows])
    j = np.array([int(r["jar"]) if r["jar"] != "" else 0 for r in rows])
    e = np.array([float(r["effort"]) if r["effort"] not in ("", "no_narration") else np.nan for r in rows])
    b = np.array([int(r["bin"]) for r in rows])
    return dict(x=x, c=c, a=a, j=j, e=e, b=b)

D = {p: arr([r for r in main if r["pid"] == p]) for p in PIDS}
F = lambda x, a, s: 1 / (1 + np.exp(-(x - a) / s))

def nll(p_fn, theta, x, y):
    p = np.clip(p_fn(theta, x), 1e-6, 1 - 1e-6)
    return -np.sum(y * np.log(p) + (1 - y) * np.log(1 - p))

def fit(p_fn, x, y, x0, bounds):
    best = None
    for a0 in np.log([6, 9, 12, 15]):
        r = minimize(lambda t: nll(p_fn, t, x, y), [a0] + x0[1:], bounds=bounds, method="L-BFGS-B")
        if best is None or r.fun < best.fun: best = r
    return best.x

PI = lambda t, x: GAMMA + (1 - GAMMA - t[2]) * (1 - F(x, t[0], t[1]))
PA = lambda t, x: (1 - t[2]) * (1 - F(x, t[0], t[1]))
DEC = lambda t, x: 1 - F(x, t[0], t[1])   # P_S: slow-side judgments, decreasing
INC = lambda t, x: F(x, t[0], t[1])       # P_F: fast-side judgments, increasing
AB = (math.log(3), math.log(40)); SB = (0.02, 1.5)

def analyse(pids):
    x = np.concatenate([D[p]["x"] for p in pids]); c = np.concatenate([D[p]["c"] for p in pids])
    a = np.concatenate([D[p]["a"] for p in pids]); j = np.concatenate([D[p]["j"] for p in pids])
    ti = fit(PI, x, c, [0, 0.2, 0.02], [AB, SB, (0, .06)])
    m = ~((a == 0) & (j < 0))                     # drop slow-side rejections from the acceptability fit
    ta = fit(PA, x[m], a[m], [0, 0.2, 0.02], [AB, SB, (0, .06)])
    ps = fit(DEC, x, (j < 0).astype(int), [0, 0.2], [AB, SB])
    pf = fit(INC, x, (j > 0).astype(int), [0, 0.2], [AB, SB])
    g = np.linspace(math.log(3), math.log(20), 2000)
    d = DEC(ps, g) - INC(pf, g); xp = math.exp(g[np.argmin(np.abs(d))])
    U = np.exp(g) * (PI(ti, g) - GAMMA) / (1 - GAMMA); xs = math.exp(g[np.argmax(U)])
    return dict(TI=math.exp(ti[0]), TA=math.exp(ta[0]), delta=ti[0] - ta[0], sI=ti[1], lamI=ti[2], sA=ta[1], lamA=ta[2],
                xP=xp, xstar=xs, n_slow_rej=int((~m).sum()), theta=dict(I=ti.tolist(), A=ta.tolist(), S=ps.tolist(), F=pf.tolist()))

def mar(p):
    v = [float(r["final_syl_per_s"]) for r in A if r["pid"] == p]
    return math.exp(np.mean(np.log(v)))

def summ(pids):
    """per-bin mean of participant means"""
    out = {}
    for b in range(6):
        pm = lambda k: [np.nanmean(D[p][k][D[p]["b"] == b]) for p in pids]
        out[b] = dict(c=np.mean(pm("c")), a=np.mean(pm("a")), e=np.mean(pm("e")),
                      jr=np.mean([np.mean(D[p]["j"][D[p]["b"] == b] == 0) for p in pids]))
    return out

if args.plot_only:  # re-draw the figure from a saved results file (skips the 2000-sample bootstrap)
    res = json.loads((HERE / f"results_{args.set}.json").read_text(encoding="utf-8"))
    est = dict(res["estimates"], theta=res["theta"])
    bins = {int(b): {kk: v[k][0] for k, kk in zip("caej", ("c", "a", "e", "jr"))} for b, v in res["bins"].items()}
    res["bins"] = {int(b): v for b, v in res["bins"].items()}
    rng = np.random.default_rng(1)
else:
    est = analyse(PIDS); est["MAR"] = math.exp(np.mean([math.log(mar(p)) for p in PIDS]))
    est["MAR_over_TA"] = est["MAR"] / est["TA"]; est["xP_over_x1"] = est["xP"] / X1; est["TA_over_xP"] = est["TA"] / est["xP"]
    bins = summ(PIDS)
    rng = np.random.default_rng(1)
    keys = ["TI", "TA", "delta", "xP", "xstar", "MAR", "MAR_over_TA", "xP_over_x1", "TA_over_xP"]
    boot = {k: [] for k in keys}; bboot = {b: {k: [] for k in "caej"} for b in range(6)}; rho_boot = []
    rho = {p: spearmanr(np.exp(D[p]["x"]), D[p]["e"], nan_policy="omit")[0] for p in PIDS}
    for _ in range(args.boot):
        s = list(rng.choice(PIDS, len(PIDS), replace=True))
        if len(set(s)) < 2: continue
        r = analyse(s); r["MAR"] = math.exp(np.mean([math.log(mar(p)) for p in s]))
        r["MAR_over_TA"] = r["MAR"] / r["TA"]; r["xP_over_x1"] = r["xP"] / X1; r["TA_over_xP"] = r["TA"] / r["xP"]
        for k in keys: boot[k].append(r[k])
        bs = summ(s)
        for b in range(6):
            for k, kk in zip("caej", ("c", "a", "e", "jr")): bboot[b][k].append(bs[b][kk])
        rho_boot.append(np.mean([rho[p] for p in s]))
    ci = lambda v: [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))]

    # retest and adjustment-start effect
    ret = []
    for p in PIDS:
        rt = [r for r in T if r["pid"] == p and r["kind"] == "retest"]
        for r in rt:
            o = [m for m in main if m["pid"] == p and m["item"] == r["item"]][0]
            ret.append(dict(pid=p, item=r["item"], d_effort=abs(float(r["effort"]) - float(o["effort"])),
                            d_jar=abs(int(r["jar"]) - int(o["jar"])), same_accept=r["accept"] == o["accept"]))
    adj = [dict(pid=r["pid"], start="slow" if int(r["start_k"]) < 12 else "fast", syl=float(r["final_syl_per_s"])) for r in A]
    slow = [d["syl"] for d in adj if d["start"] == "slow"]; fast = [d["syl"] for d in adj if d["start"] == "fast"]

    rows = [r for r in main]
    x_all = np.array([float(r["syl_per_s"]) for r in rows]); b_all = np.array([int(r["bin"]) for r in rows])
    res = dict(set=args.set, pids=PIDS, N=len(PIDS), n_trials=len(main),
               estimates={k: float(est[k]) for k in keys + ["sI", "lamI", "sA", "lamA"]}, n_slow_rejections=est["n_slow_rej"],
               ci95={k: ci(boot[k]) for k in keys}, theta=est["theta"],
               H2_supported=ci(boot["delta"])[0] > 0,
               rho={p: float(v) for p, v in rho.items()}, rho_mean=float(np.mean(list(rho.values()))), rho_mean_ci=ci(rho_boot),
               n_rho_negative=int(sum(v < 0 for v in rho.values())),
               MAR_per_pid={p: mar(p) for p in PIDS},
               bins={b: dict(syl=[float(x_all[b_all == b].min()), float(x_all[b_all == b].max())], n=int((b_all == b).sum()),
                             **{k: [float(bins[b][kk])] + ci(bboot[b][k]) for k, kk in zip("caej", ("c", "a", "e", "jr"))})
                     for b in range(6)},
               retest=ret, adjust_start=dict(slow_gm=math.exp(np.mean(np.log(slow))) if slow else None,
                                             fast_gm=math.exp(np.mean(np.log(fast))) if fast else None, n_slow=len(slow), n_fast=len(fast)),
               fast_effort_rt=sum(int(r["effort_rt_ms"]) < 300 for r in main),
               no_narration=sum(r["effort"] == "no_narration" for r in main))
    (HERE / f"results_{args.set}.json").write_text(json.dumps(res, indent=1, ensure_ascii=False), encoding="utf-8")


# ---------------------------------------------------------------- figure
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
plt.rcParams.update({"font.family": "serif", "font.serif": ["Times New Roman", "DejaVu Serif"], "font.size": 8,
                     "axes.linewidth": 0.6, "pdf.fonttype": 42})
g = np.linspace(math.log(4), math.log(16.5), 300); xx = np.exp(g)
th = est["theta"]
fig, ax = plt.subplots(1, 2, figsize=(7.0, 2.5), constrained_layout=True)
band = lambda key, fn: np.percentile([fn(t, g) for t in BT[key]], [2.5, 97.5], axis=0)
# bootstrap curves for bands (re-fit a subset to keep it fast)
BT = {"I": [], "A": [], "S": [], "F": []}
for _ in range(300):
    s = list(rng.choice(PIDS, len(PIDS), replace=True))
    if len(set(s)) < 2: continue
    r = analyse(s)
    for k in BT: BT[k].append(np.array(r["theta"][k]))
bx = [np.exp(np.mean([np.mean(D[p]["x"][D[p]["b"] == b]) for p in PIDS])) for b in range(6)]
for key, fn, col, lab, data in (("I", PI, "#1D4ED8", "P(correct)", "c"), ("A", PA, "#C2410C", "P(accept)", "a")):
    lo, hi = band(key, fn); ax[0].fill_between(xx, lo, hi, color=col, alpha=.15, lw=0)
    ax[0].plot(xx, fn(np.array(th[key]), g), color=col, lw=1.2, label=lab)
    ax[0].plot(bx, [bins[b][data] for b in range(6)], "o", color=col, ms=3.5)
ax[0].axhline(GAMMA, color="#999", lw=.6, ls=":"); ax[0].text(16.3, GAMMA + .02, "chance", color="#777", fontsize=7, ha="right")
ax[0].axvline(est["TA"], color="#C2410C", lw=.7, ls="--")
ax[0].text(est["TA"] * 1.02, .05, f"$T_A$={est['TA']:.1f}", color="#C2410C", fontsize=7)
if est["TI"] < 16.5:
    ax[0].axvline(est["TI"], color="#1D4ED8", lw=.7, ls="--")
    ax[0].text(est["TI"] / 1.02, .12, f"$T_I$={est['TI']:.1f}", color="#1D4ED8", fontsize=7, ha="right")
ax[0].set(xscale="log", ylim=(0, 1.02), xlabel="narration rate (syllables/s, log)", ylabel="proportion",
          title="(a) Intelligibility vs. acceptability")
ax[0].legend(frameon=False, loc="lower left", bbox_to_anchor=(0, .32))
for key, fn, col, lab in (("S", DEC, "#0F766E", "P(too slow side)"), ("F", INC, "#B91C1C", "P(too fast side)")):
    lo, hi = band(key, fn); ax[1].fill_between(xx, lo, hi, color=col, alpha=.12, lw=0)
    ax[1].plot(xx, fn(np.array(th[key]), g), color=col, lw=1.2, label=lab)
ax[1].plot(bx, [bins[b]["jr"] for b in range(6)], "s-", color="#555", ms=3, lw=.8, label="P(just right), per bin")
ax[1].axvline(est["xP"], color="#555", lw=.7, ls="--"); ax[1].text(est["xP"] * 1.02, .93, f"$x_P$={est['xP']:.1f}", fontsize=7)
ax2 = ax[1].twinx()
ax2.errorbar(bx, [bins[b]["e"] for b in range(6)], yerr=np.abs(np.array([res["bins"][b]["e"][1:] for b in range(6)]).T - [bins[b]["e"] for b in range(6)]),
             fmt="^", color="#7C3AED", ms=3.5, lw=.7, capsize=1.5, label="effort score")
ax2.set_ylim(1, 5.1); ax2.set_ylabel("effort score (5 = no effort)", color="#7C3AED")
ax[1].set(xscale="log", ylim=(0, 1.02), xlabel="narration rate (syllables/s, log)", ylabel="proportion",
          title="(b) Speed judgments and listening effort")
h1, l1 = ax[1].get_legend_handles_labels(); h2, l2 = ax2.get_legend_handles_labels()
ax[1].legend(h1 + h2, l1 + l2, frameon=False, fontsize=6.5, loc="center left")
for a_ in ax:
    a_.set_xticks([4, 5, 6, 8, 10, 12, 16]); a_.set_xticklabels(["4", "5", "6", "8", "10", "12", "16"]); a_.minorticks_off()
(HERE / "figs").mkdir(exist_ok=True)
fig.savefig(HERE / "figs" / f"fig_psy_{args.set}.pdf"); fig.savefig(HERE / "figs" / f"fig_psy_{args.set}.png", dpi=200)
if not args.plot_only: print(json.dumps({k: res[k] for k in ("set", "N", "pids", "estimates", "ci95", "H2_supported", "rho", "rho_mean_ci",
                                       "n_rho_negative", "MAR_per_pid", "n_slow_rejections", "adjust_start", "retest",
                                       "fast_effort_rt", "no_narration")}, indent=1))
