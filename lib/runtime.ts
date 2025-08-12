// lib/runtime.ts
import type { } from 'react'; // keep TS happy on edge
import { kv } from '@vercel/kv'; // works on Edge; safe to import even if not configured
import { calcTool, weatherTool } from './llm';

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

const TOOL_SCHEMAS: Record<string, any> = {
  calc: calcTool,
  weather: weatherTool,
};

// --- Origin helper for internal fetches ---
function getOrigin() {
  const explicit = process.env.NEXT_PUBLIC_APP_ORIGIN;
  if (explicit) return explicit.replace(/\/$/, '');
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/$/, '')}`;
  return 'http://localhost:3000';
}

export async function executeGraph(sessionId: string, graph: any) {
  await enqueue(sessionId, { type: 'state_patch', node: 'sys', patch: { startedAt: Date.now() } });

  const nodes: Record<string, any> = Object.fromEntries((graph?.nodes || []).map((n: any) => [n.id, n]));
  const edges: any[] = graph?.edges || [];

  const incoming: Record<string, number> = {};
  Object.keys(nodes).forEach((k) => (incoming[k] = 0));
  edges.forEach((e) => (incoming[e.target] = (incoming[e.target] ?? 0) + 1));

  const frontier = Object.keys(nodes).filter((nid) => (incoming[nid] ?? 0) === 0);
  const nexts = (id: string) => edges.filter((e) => e.source === id).map((e) => e.target);

  const finalStates: Record<string, any> = {};

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
      // Gather messages from incoming nodes
      const upstream = edges.filter((e) => e.target === nid).map((e) => e.source);
      const messages: any[] = [
        { role: 'system', content: 'You are a helpful planner that may call tools if needed.' },
      ];
      for (const uid of upstream) {
        const uNode = nodes[uid];
        const uState = finalStates[uid] || uNode?.data?.state || {};
        const label = (uNode?.data?.label || '').toString().toLowerCase();
        if (label === 'input') {
          const q = uState.query || uNode?.data?.state?.query;
          if (q) messages.push({ role: 'user', content: String(q) });
        } else if (label === 'tool') {
          const result = uState.result || uNode?.data?.state?.result;
          if (result)
            messages.push({
              role: 'system',
              content: `Tool ${uNode.data?.tool}: ${JSON.stringify(result)}`,
            });
        }
      }

      // Determine which tools to bind (neighbors that are tool nodes)
      const connectedTools = Array.from(
        new Set(
          edges
            .filter((e) => e.source === nid || e.target === nid)
            .map((e) => (e.source === nid ? nodes[e.target] : nodes[e.source]))
            .filter((n) => (n?.data?.label || '').toLowerCase() === 'tool')
            .map((n) => n?.data?.tool as string)
            .filter(Boolean)
        )
      );

      await enqueue(sessionId, {
        type: 'state_patch',
        node: nid,
        patch: { status: 'planning' },
      });

      const origin = getOrigin();

      // Abort after N seconds if the LLM proxy gets stuck
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort('llm-timeout'), 90_000);
      
      try {
        await fetch(`${origin}/api/llm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, node_id: nid, messages }),
          signal: abort.signal,
        });
      } catch (e) {
        await enqueue(sessionId, { type: 'state_patch', node: nid, patch: { status: 'error', error: String((e as any)?.message || e) } });
      } finally {
        clearTimeout(timeout);
      }
      
      finalStates[nid] = { status: 'started' }; // executor continues; stream will have posted the final answer or the error

    } else if (tool && TOOLS[tool]) {
      // Regular tool: run synchronously and patch immediately
      await enqueue(sessionId, { type: 'state_patch', node: nid, patch: { status: 'running', tool } });
      try {
        const result = await TOOLS[tool](params);
        const patch = { status: 'done', result };
        await enqueue(sessionId, { type: 'state_patch', node: nid, patch });
        finalStates[nid] = patch;
      } catch (e: any) {
        const patch = { status: 'error', error: String(e?.message || e) };
        await enqueue(sessionId, { type: 'state_patch', node: nid, patch });
        finalStates[nid] = patch;
      }
    } else {
      const patch = { status: 'skipped' };
      await enqueue(sessionId, { type: 'state_patch', node: nid, patch });
      finalStates[nid] = patch;
    }

    // advance graph
    for (const t of nexts(nid)) {
      incoming[t] -= 1;
      if (incoming[t] === 0) frontier.push(t);
    }
  }

  await enqueue(sessionId, { type: 'done', metrics: { tokens: 0, cost: 0 } });
  return finalStates; // <- used by /api/runs when no LLM stream is open
}
