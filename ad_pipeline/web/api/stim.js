// GET /api/stim?f=s_<hash>.mp3 -> stream a stimulus from the private Blob store.
// File names are content hashes, so responses are immutable and cached by the CDN after the first request.
import { get } from '@vercel/blob';

const NAME_RE = /^s_[0-9a-f]{12}\.mp3$/;

export async function GET(request) {
  const f = new URL(request.url).searchParams.get('f') || '';
  if (!NAME_RE.test(f)) return new Response('bad name', { status: 400 });
  const r = await get(`stim/${f}`, { access: 'private' });
  if (!r || r.statusCode !== 200) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  return new Response(r.stream, {
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'public, max-age=31536000, s-maxage=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}
