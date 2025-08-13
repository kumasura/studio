// app/api/runs/route.ts
export const runtime = 'nodejs';
import { executeGraph } from '@/lib/runtime';

export async function POST(req: Request) {
  const payload = await req.json();
  const { session_id, graph } = payload || {};
  if (!session_id) {
    return new Response(JSON.stringify({ error: 'missing session_id' }), { status: 400 });
  }

  // Wait for full graph execution (LLM will stream via /api/llm internally)
  const finalStates = await executeGraph(session_id, graph);

  return new Response(JSON.stringify({ ok: true, finalStates }), {
    headers: { 'content-type': 'application/json' },
  });
}
