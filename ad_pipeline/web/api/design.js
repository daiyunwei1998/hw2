// GET /api/design -> the experiment manifest (design/design.json in the private Blob store).
import { get } from '@vercel/blob';

export async function GET() {
  const r = await get('design/design.json', { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200) return new Response('{"error":"no_design"}', { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(r.stream, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
