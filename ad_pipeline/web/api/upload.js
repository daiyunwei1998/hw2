// PUT /api/upload?key=ADMIN_KEY&f=s_<hash>.mp3  (body = mp3 bytes) -> stores stim/<f> in the private Blob store.
// Used by upload_stimuli.py so the Blob token never leaves Vercel.
import { put, head } from '@vercel/blob';
import { json, adminOk } from './_lib.js';

const NAME_RE = /^s_[0-9a-f]{12}\.mp3$/;
// f=design.json uploads the experiment manifest (served by /api/design).
const target = (f) => (f === 'design.json' ? { path: 'design/design.json', type: 'application/json' }
  : NAME_RE.test(f) ? { path: `stim/${f}`, type: 'audio/mpeg' } : null);

export async function PUT(request) {
  const u = new URL(request.url);
  if (!adminOk(u.searchParams.get('key') || '')) return json({ ok: false, error: 'forbidden' }, 403);
  const t = target(u.searchParams.get('f') || '');
  if (!t) return json({ ok: false, error: 'bad_name' }, 400);
  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length < 100 || buf.length > 3_000_000) return json({ ok: false, error: 'bad_size', size: buf.length }, 400);
  if (t.type === 'application/json') { try { JSON.parse(buf.toString('utf8')); } catch { return json({ ok: false, error: 'bad_json' }, 400); } }
  await put(t.path, buf, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: t.type });
  return json({ ok: true, path: t.path, size: buf.length });
}

// GET /api/upload?key=...&f=... -> {exists, size}; lets the uploader skip files already stored.
export async function GET(request) {
  const u = new URL(request.url);
  if (!adminOk(u.searchParams.get('key') || '')) return json({ ok: false, error: 'forbidden' }, 403);
  const t = target(u.searchParams.get('f') || '');
  if (!t) return json({ ok: false, error: 'bad_name' }, 400);
  try { const h = await head(t.path); return json({ ok: true, exists: true, size: h.size }); }
  catch { return json({ ok: true, exists: false }); }
}
