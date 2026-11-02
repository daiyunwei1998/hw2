// POST one participant event. Idempotent: (pid, seq) always maps to the same blob, so client retries never duplicate.
import { put } from '@vercel/blob';
import { json, PID_RE } from './_lib.js';

const TYPES = new Set(['session', 'consent', 'demo', 'volume', 'hp_check', 'instructions', 'trial', 'adjust', 'final', 'finish', 'client_error']);

export async function POST(request) {
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  if (!PID_RE.test(b.pid || '')) return json({ ok: false, error: 'bad_pid' }, 400);
  const seq = Number(b.seq);
  if (!Number.isInteger(seq) || seq < 0 || seq > 9999) return json({ ok: false, error: 'bad_seq' }, 400);
  if (!TYPES.has(b.type)) return json({ ok: false, error: 'bad_type' }, 400);
  const { code, ...rest } = b; // sessions started before the access code was removed still send it
  const body = JSON.stringify({ ...rest, server_ts: new Date().toISOString(), ua: request.headers.get('user-agent') || '' });
  if (body.length > 200_000) return json({ ok: false, error: 'too_large' }, 413);
  const pathname = `data/${b.pid}/${String(seq).padStart(4, '0')}_${b.type}.json`;
  try {
    await put(pathname, body, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  } catch (e) {
    return json({ ok: false, error: 'store_failed', detail: String(e?.message || e) }, 503);
  }
  return json({ ok: true, seq });
}
