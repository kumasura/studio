export const runtime = 'edge';

import { dequeueBatch, SESSIONS } from '@/lib/runtime';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('session_id') || '';
  // Don’t hard-fail on SESSIONS.has when using KV (instance may be fresh)
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'invalid session' }), { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      let done = false;

      const tick = async () => {
        if (done) return;
        const batch = await dequeueBatch(sessionId, 64);
        for (const evt of batch) {
          send(evt);
          if (evt?.type === 'done') {
            done = true;
            controller.close();
            return;
          }
        }
        setTimeout(tick, batch.length ? 10 : 150);
      };
      tick();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
