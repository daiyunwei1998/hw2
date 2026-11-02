// POST {pid, mode, n_lists} -> {list}. Returns the existing list for a known pid (resume), otherwise the
// least-used Latin-square list. The list is encoded in the pathname so counting needs no blob reads.
import { put } from '@vercel/blob';
import { json, PID_RE, listAll } from './_lib.js';

export async function POST(request) {
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  if (!PID_RE.test(b.pid || '')) return json({ ok: false, error: 'bad_pid' }, 400);
  const n = Number(b.n_lists);
  if (!Number.isInteger(n) || n < 1 || n > 24) return json({ ok: false, error: 'bad_n_lists' }, 400);
  try {
    const blobs = await listAll('sessions/');
    const mine = blobs.find((x) => x.pathname.endsWith(`/${b.pid}.json`));
    if (mine) return json({ ok: true, list: parseInt(mine.pathname.split('/')[1].slice(1), 10), resumed: true });
    const counts = Array(n).fill(0);
    for (const x of blobs) {
      const l = parseInt(x.pathname.split('/')[1].slice(1), 10);
      if (l >= 0 && l < n) counts[l]++;
    }
    const min = Math.min(...counts);
    const cands = counts.map((c, i) => (c === min ? i : -1)).filter((i) => i >= 0);
    const list = cands[Math.floor(Math.random() * cands.length)];
    await put(`sessions/L${list}/${b.pid}.json`,
      JSON.stringify({ pid: b.pid, list, mode: b.mode || null, ts: new Date().toISOString() }),
      { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
    return json({ ok: true, list, resumed: false });
  } catch (e) {
    return json({ ok: false, error: 'store_failed', detail: String(e?.message || e) }, 503);
  }
}
