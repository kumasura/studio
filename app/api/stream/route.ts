export const runtime = 'nodejs';

import { dequeueBatch } from '@/lib/runtime';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('session_id') || '';
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'invalid session' }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const signal = (req as any).signal as AbortSignal | undefined;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const stream = new ReadableStream({
    start(controller) {
      // initial ping helps some proxies “lock in” SSE mode
      controller.enqueue(encoder.encode(': ok\n\n'));

      (async () => {
        try {
          let lastHeartbeat = Date.now();

          while (!signal?.aborted) {
            // drain a batch from KV/memory
            const batch = await dequeueBatch(sessionId, 64);

            for (const evt of batch) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
              if (evt?.type === 'done') {
                controller.close();
                return;
              }
            }

            // heartbeat every ~15s so Vercel doesn’t idle-close
            const now = Date.now();
            if (now - lastHeartbeat > 15000) {
              controller.enqueue(encoder.encode(': keep-alive\n\n'));
              lastHeartbeat = now;
            }

            await sleep(batch.length ? 10 : 150);
          }

          // client disconnected
          try { controller.close(); } catch {}
        } catch (err) {
          try { controller.error(err as any); } catch {}
        }
      })();
    },
    cancel() {
      // client closed connection
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
