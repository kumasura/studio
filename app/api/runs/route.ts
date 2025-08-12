export const runtime = 'edge'
import { executeGraph } from '@/lib/runtime'

export async function POST(req: Request) {
  const payload = await req.json()
  const { session_id, graph } = payload || {}
  if (!session_id) return new Response(JSON.stringify({ error: 'missing session_id' }), { status: 400 })

  // Fire-and-forget execution (no background worker here; quick graphs only)
  // For bigger runs, use a queue (Redis/Upstash) and process via cron or middleware.
  executeGraph(session_id, graph)
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
}
