// lib/runtime.ts
import type { } from 'react'; // keep TS happy on edge
import { kv } from '@vercel/kv'; // works on Edge; safe to import even if not configured

export type Event = { type: string; node?: string; message?: string; patch?: any; metrics?: any };
export type Session = { queue: Event[] };

// --- In-memory fallback (dev) ---
const sessions = (globalThis as any).__studio_sessions as Map<string, Session> | undefined;
export const SESSIONS: Map<string, Session> = sessions || new Map<string, Session>();
(globalThis as any).__studio_sessions = SESSIONS;

// Detect KV availability
const hasKV = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;

// Key helpers
const kSession = (sid: string) => `studio:sessions:${sid}`;
const kQueue   = (sid: string) => `studio:queue:${sid}`;

// Create a session id (always OK)
export function createSession(): string {
  const id = crypto.randomUUID();
  if (!hasKV) {
    SESSIONS.set(id, { queue: [] });
  } else {
    // best effort marker; queue is the real transport
    kv.set(kSession(id), '1', { ex: 60 * 60 }); // 1h TTL
  }
  return id;
}

// Enqueue event (KV or memory)
export async function enqueue(sessionId: string, evt: Event) {
  if (hasKV) {
    await kv.rpush(kQueue(sessionId), JSON.stringify(evt));
    // keep session marker alive
    await kv.expire(kSession(sessionId), 60 * 60);
  } else {
    const s = SESSIONS.get(sessionId);
    if (!s) return;
    s.queue.push(evt);
  }
}

// Dequeue up to N events (KV or memory)
export async function dequeueBatch(sessionId: string, max = 64): Promise<Event[]> {
  if (hasKV) {
    const events: Event[] = [];
    for (let i = 0; i < max; i++) {
      const raw = await kv.lpop<string>(kQueue(sessionId));
      if (!raw) break;
      events.push(JSON.parse(raw));
    }
    return events;
  } else {
    const s = SESSIONS.get(sessionId);
    if (!s) return [];
    const out = s.queue.splice(0, max);
    return out;
  }
}

// --- Your existing tool fns (unchanged) ---
function safeCalc(expr: string): number {
  if (!/^[-+*/()%.\d\s^a-zA-Z,]*$/.test(expr)) throw new Error('invalid chars');
  const f = Function(`const {sin,cos,tan,PI,abs,pow,sqrt,log,exp,min,max}=Math; return (${String(expr).replace(/\^/g,'**')});`);
  return Number(f());
}
const WEATHER: Record<string, any> = {
  Delhi: { tempC: 32, condition: 'Cloudy' },
  Mumbai: { tempC: 29, condition: 'Humid' },
  Bengaluru: { tempC: 24, condition: 'Light Rain' },
};
export async function toolCalc(params: any) {
  return { result: safeCalc(String(params?.expression ?? '0')) };
}
export async function toolWeather(params: any) {
  const city = String(params?.city ?? 'Delhi');
  return WEATHER[city] ?? { tempC: 28, condition: 'Clear' };
}
export const TOOLS: Record<string, (p: any) => Promise<any>> = {
  calc: toolCalc,
  weather: toolWeather,
};

// --- Origin helper for internal fetches ---
function getOrigin() {
  const explicit = process.env.NEXT_PUBLIC_APP_ORIGIN;
  if (explicit) return explicit.replace(/\/$/, '');
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/$/, '')}`;
  return 'http://localhost:3000';
}

// --- Graph executor (same logic as before; unchanged) ---
export async function executeGraph(sessionId: string, graph: any) {
  const nodes: Record<string, any> = Object.fromEntries((graph?.nodes || []).map((n: any) => [n.id, n]));
  const edges: any[] = graph?.edges || [];

  const incoming: Record<string, number> = {};
  Object.keys(nodes).forEach((k) => (incoming[k] = 0));
  edges.forEach((e) => (incoming[e.target] = (incoming[e.target] ?? 0) + 1));

  const frontier = Object.keys(nodes).filter((nid) => (incoming[nid] ?? 0) === 0);
  const nexts = (id: string) => edges.filter((e) => e.source === id).map((e) => e.target);

  while (frontier.length) {
    const nid = frontier.shift()!;
    const node = nodes[nid];
    const label = (node?.data?.label ?? '').toString();
    const subtitle = node?.data?.subtitle ?? '';
    await enqueue(sessionId, { type: 'node_enter', node: nid, message: `${label} ${subtitle}` });

    const tool = node?.data?.tool as string | undefined;
    const params = node?.data?.params ?? {};
    const isLLM = label.toLowerCase() === 'llm' || tool === 'llm';

    if (isLLM) {
      const userQuery = (node?.data?.state?.query as string) ?? 'Plan the next steps and call tools if needed.';
      const messages = [
        { role: 'system', content: 'You are a helpful planner that may call tools if needed.' },
        { role: 'user', content: userQuery },
      ];

      await enqueue(sessionId, { type: 'state_patch', node: nid, patch: { status: 'planning' } });

      const origin = getOrigin();
      await fetch(`${origin}/api/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, node_id: nid, messages }),
      });
    } else if (tool && TOOLS[tool]) {
      await enqueue(sessionId, { type: 'state_patch', node: nid, patch: { status: 'running', tool } });
      try {
        const result = await TOOLS[tool](params);
        await enqueue(sessionId, { type: 'state_patch', node: nid, patch: { status: 'done', result } });
      } catch (e: any) {
        await enqueue(sessionId, {
          type: 'state_patch',
          node: nid,
          patch: { status: 'error', error: String(e?.message || e) },
        });
      }
    } else {
      await enqueue(sessionId, { type: 'state_patch', node: nid, patch: { status: 'skipped' } });
    }

    for (const t of nexts(nid)) {
      incoming[t] -= 1;
      if (incoming[t] === 0) frontier.push(t);
    }
  }

  await enqueue(sessionId, { type: 'done', metrics: { tokens: 0, cost: 0 } });
}
