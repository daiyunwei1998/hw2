// GET which event seqs the server holds for a participant, so the client can re-send anything missing.
import { json, PID_RE, listAll } from './_lib.js';

export async function GET(request) {
  const u = new URL(request.url);
  const pid = u.searchParams.get('pid') || '';
  if (!PID_RE.test(pid)) return json({ ok: false, error: 'bad_pid' }, 400);
  try {
    const blobs = await listAll(`data/${pid}/`);
    const seqs = blobs.map((b) => parseInt(b.pathname.split('/').pop(), 10)).filter(Number.isInteger).sort((a, b) => a - b);
    return json({ ok: true, seqs });
  } catch (e) {
    return json({ ok: false, error: 'store_failed', detail: String(e?.message || e) }, 503);
  }
}
