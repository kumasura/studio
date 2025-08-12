// app/api/runs/route.ts
export const runtime = 'edge';
import { executeGraph } from '@/lib/runtime';

export async function POST(req: Request) {
  const payload = await req.json();
  const { session_id, graph } = payload || {};
  if (!session_id) {
    return new Response(JSON.stringify({ error: 'missing session_id' }), { status: 400 });
  }

  // IMPORTANT: await the graph execution so the worker stays alive
  await executeGraph(session_id, graph);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' },
  });
}
