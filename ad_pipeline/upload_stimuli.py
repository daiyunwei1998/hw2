"""Upload rendered stimuli + design.json to the deployed experiment via the admin-gated /api/upload route.

    python upload_stimuli.py https://ad-rate-study.vercel.app

Reads ADMIN_KEY from web/.secrets.local.json. Skips files already stored with the same size; retries failures.
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).parent
STIM_DIR = Path(r"N:\datasets\reframed\stimuli_v2")
DESIGN = HERE / "web" / "design.json"


def call(method, url, data=None, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, method=method,
                                         headers={"content-type": "application/octet-stream"} if data else {})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500 and e.code != 429:
                raise RuntimeError(f"{e.code} {e.read()[:200]!r}")
        except Exception:
            pass
        time.sleep(1.5 * 2 ** i)
    raise RuntimeError(f"failed after {tries} tries: {method} {url.split('?')[0]}")


def main():
    base = sys.argv[1].rstrip("/")
    key = json.load(open(HERE / "web" / ".secrets.local.json"))["ADMIN_KEY"]
    design = json.load(open(DESIGN, encoding="utf-8"))
    names = sorted({s["file"] for grp in ("main", "adjust") for it in design[grp] for s in it["stimuli"]}
                   | {s["file"] for it in (design["practice"], design["attention"]) for s in it["stimuli"]})
    q = lambda f: f"{base}/api/upload?" + urllib.parse.urlencode({"key": key, "f": f})

    def one(f):
        p = STIM_DIR / f
        h = call("GET", q(f))
        if h.get("exists") and h.get("size") == p.stat().st_size:
            return "skip"
        call("PUT", q(f), p.read_bytes())
        return "up"

    with ThreadPoolExecutor(6) as ex:
        res = list(ex.map(one, names))
    print(f"stimuli: {res.count('up')} uploaded, {res.count('skip')} already there, {len(names)} total")
    call("PUT", q("design.json"), DESIGN.read_bytes())
    print("design.json uploaded, version", design["version"])


if __name__ == "__main__":
    main()
