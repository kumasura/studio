export const runtime = 'edge'
import { SESSIONS, Event } from '@/lib/runtime'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const sessionId = searchParams.get('session_id') || ''
  if (!SESSIONS.has(sessionId)) return new Response(JSON.stringify({ error: 'invalid session' }), { status: 400 })

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))

      const poll = async () => {
        const s = SESSIONS.get(sessionId)
        if (!s) return controller.close()
        while (s.queue.length) {
          const evt = s.queue.shift()!
          send(evt)
          if (evt?.type === 'done') return controller.close()
        }
        setTimeout(poll, 200)
      }
      poll()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  })
}
