// Minimal runtime/shared state for API routes
// NOTE: In-memory Map is ephemeral in serverless. Replace with Redis for production.
export type Event = { type: string; node?: string; message?: string; patch?: any; metrics?: any }
export type Session = { queue: Event[] }

const sessions = (globalThis as any).__studio_sessions as Map<string, Session> | undefined
export const SESSIONS: Map<string, Session> = sessions || new Map<string, Session>()
;(globalThis as any).__studio_sessions = SESSIONS

export function createSession(): string {
  const id = crypto.randomUUID()
  SESSIONS.set(id, { queue: [] })
  return id
}

export async function enqueue(sessionId: string, evt: Event) {
  const s = SESSIONS.get(sessionId)
  if (!s) return
  s.queue.push(evt)
}

// --- Tool registry ---
function safeCalc(expr: string): number {
  // extremely tiny safe parser (no eval) — for demo only
  // You can swap with a proper expression parser (like "expr-eval") if allowed.
  // Here we fallback to Function but guard characters. Use at your own risk in demos.
  if (!/^[-+*/()%\.\d\s^a-zA-Z,]*$/.test(expr)) throw new Error('invalid chars')
  const f = Function(`const {sin,cos,tan,pi,PI,abs,pow,sqrt,log,exp,min,max} = Math; return (${expr.replace(/\^/g,'**')});`)
  return Number(f())
}

export async function toolCalc(params: any) {
  const expr = String(params?.expression ?? '0')
  const result = safeCalc(expr)
  return { result }
}

const WEATHER: Record<string, any> = {
  Delhi: { tempC: 32, condition: 'Cloudy' },
  Mumbai: { tempC: 29, condition: 'Humid' },
  Bengaluru: { tempC: 24, condition: 'Light Rain' },
}
export async function toolWeather(params: any) {
  const city = String(params?.city ?? 'Delhi')
  return WEATHER[city] ?? { tempC: 28, condition: 'Clear' }
}

export const TOOLS: Record<string, (p: any) => Promise<any>> = {
  calc: toolCalc,
  weather: toolWeather,
}

// Put this helper near the top of lib/runtime.ts
function getOrigin() {
  // Prefer explicit origin if you set it
  const explicit = process.env.NEXT_PUBLIC_APP_ORIGIN;
  if (explicit) return explicit.replace(/\/$/, "");
  // Vercel provides VERCEL_URL without protocol
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;
  // Fallback for local dev
  return "http://localhost:3000";
}

// Replace your executeGraph with this:
export async function executeGraph(sessionId: string, graph: any) {
  const nodes: Record<string, any> = Object.fromEntries(
    (graph?.nodes || []).map((n: any) => [n.id, n])
  );
  const edges: any[] = graph?.edges || [];

  const incoming: Record<string, number> = {};
  Object.keys(nodes).forEach((k) => (incoming[k] = 0));
  edges.forEach((e) => (incoming[e.target] = (incoming[e.target] ?? 0) + 1));

  const frontier = Object.keys(nodes).filter((nid) => (incoming[nid] ?? 0) === 0);
  const nexts = (id: string) => edges.filter((e) => e.source === id).map((e) => e.target);

  while (frontier.length) {
    const nid = frontier.shift()!;
    const node = nodes[nid];
    const label = (node?.data?.label ?? "").toString();
    const subtitle = node?.data?.subtitle ?? "";
    await enqueue(sessionId, { type: "node_enter", node: nid, message: `${label} ${subtitle}` });

    const tool = node?.data?.tool as string | undefined;
    const params = node?.data?.params ?? {};
    const isLLM = label.toLowerCase() === "llm";

    if (isLLM) {
      // Build a minimal message list; adapt if you maintain a chat transcript
      const userQuery =
        (node?.data?.state?.query as string) ||
        "Plan the next steps and call tools if needed.";
      const messages = [
        { role: "system", content: "You are a helpful planner that may call tools if needed." },
        { role: "user", content: userQuery },
      ];

      // Let the UI know we’re starting
      await enqueue(sessionId, {
        type: "state_patch",
        node: nid,
        patch: { status: "planning" },
      });

      // Call our LLM route (which performs planning, tool calls, and streaming final answer)
      const origin = getOrigin();
      await fetch(`${origin}/api/llm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, node_id: nid, messages }),
      });

      // Note: /api/llm will push intermediate and final events via enqueue(), so no more work here.

    } else if (tool && TOOLS[tool]) {
      // Run a concrete tool node
      await enqueue(sessionId, { type: "state_patch", node: nid, patch: { status: "running", tool } });
      try {
        const result = await TOOLS[tool](params);
        await enqueue(sessionId, { type: "state_patch", node: nid, patch: { status: "done", result } });
      } catch (e: any) {
        await enqueue(sessionId, {
          type: "state_patch",
          node: nid,
          patch: { status: "error", error: String(e?.message || e) },
        });
      }
    } else {
      // Plain node; nothing to execute
      await enqueue(sessionId, {
        type: "state_patch",
        node: nid,
        patch: { status: "skipped" },
      });
    }

    // advance graph
    for (const t of nexts(nid)) {
      incoming[t] -= 1;
      if (incoming[t] === 0) frontier.push(t);
    }
  }

  await enqueue(sessionId, { type: "done", metrics: { tokens: 0, cost: 0 } });
}
