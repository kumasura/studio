export const runtime = "edge";

import { calcTool, weatherTool, chat } from "@/lib/llm";
import { enqueue } from "@/lib/runtime";
import { zodToJsonSchema } from "zod-to-json-schema";

// Very small safe evaluators (same as your runtime tools)
function safeCalc(expression: string) {
  if (!/^[-+*/()%.\d\s^a-zA-Z,]*$/.test(expression)) throw new Error("invalid chars");
  const f = Function(
    `const {sin,cos,tan,PI,abs,pow,sqrt,log,exp,min,max} = Math; return (${expression.replace(/\^/g,"**")});`
  );
  return Number(f());
}
const WEATHER: Record<string, any> = {
  Delhi: { tempC: 32, condition: "Cloudy" },
  Mumbai: { tempC: 29, condition: "Humid" },
  Bengaluru: { tempC: 24, condition: "Light Rain" },
};

const TOOL_SCHEMAS: Record<string, any> = {
  calc: calcTool,
  weather: weatherTool,
};

// ... imports and setup unchanged ...

export async function POST(req: Request) {
  const { session_id, messages, node_id } = await req.json();
  if (!session_id) {
    return new Response(JSON.stringify({ error: 'invalid session' }), { status: 400 });
  }
  const toolDefs = tools
    .map((name: string) => TOOL_SCHEMAS[name])
    .filter((t: any) => t);
  const modelWithTools = chat.bindTools(
    toolDefs.map((t: any) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchema(t.schema, t.name) as any,
      },
    }))
  );

  try {
    // PHASE 1: plan (non-streaming)
    const plan = await modelWithTools.invoke(messages);
    const toolCalls = (plan?.tool_calls ?? []) as Array<{ name: string; args: Record<string, any> }>;

    // Represent plan as plain assistant content (avoid passing LC message instance back in)
    const assistantPlan = {
      role: 'assistant' as const,
      content: typeof plan?.content === 'string' ? plan.content : JSON.stringify(plan?.content ?? ''),
    };

    if (toolCalls.length) {
      await enqueue(session_id, { type: 'state_patch', node: node_id, patch: { status: 'tool_calling', toolCalls } });

      const toolResults: Array<{ name: string; result: any }> = [];
      for (const call of toolCalls) {
        let result: any;
        if (call.name === 'calc') {
          result = { result: safeCalc(String(call.args?.expression ?? '0')) };
        } else if (call.name === 'weather') {
          const city = String(call.args?.city ?? 'Delhi');
          result = WEATHER[city] ?? { tempC: 28, condition: 'Clear' };
        } else {
          result = { error: `Unknown tool ${call.name}` };
        }
        toolResults.push({ name: call.name, result });
      }

      await enqueue(session_id, { type: 'state_patch', node: node_id, patch: { status: 'tool_results', toolResults } });

      const toolMessages = toolResults.map((t) => ({
        role: 'tool' as const,
        name: t.name,
        content: JSON.stringify(t.result),
      }));

      // PHASE 2: final streaming answer
      const chunks: string[] = [];
      const finalStream = await chat.stream([...messages, assistantPlan, ...toolMessages], {
        callbacks: [
          {
            handleLLMNewToken: async (token: string) => {
              chunks.push(token);
              await enqueue(session_id, {
                type: 'state_patch',
                node: node_id,
                patch: { status: 'answering', partial: chunks.join('') },
              });
            },
          },
        ],
      });

      for await (const _ of finalStream) {} // drain
      await enqueue(session_id, { type: 'state_patch', node: node_id, patch: { status: 'done', answer: chunks.join('') } });
    } else {
      // No tools → stream direct answer
      const chunks: string[] = [];
      const stream = await chat.stream([...messages, assistantPlan], {
        callbacks: [
          {
            handleLLMNewToken: async (token: string) => {
              chunks.push(token);
              await enqueue(session_id, {
                type: 'state_patch',
                node: node_id,
                patch: { status: 'generating', partial: chunks.join('') },
              });
            },
          },
        ],
      });

      for await (const _ of stream) {} // drain
      await enqueue(session_id, { type: 'state_patch', node: node_id, patch: { status: 'done', answer: chunks.join('') } });
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  } catch (err: any) {
    await enqueue(session_id, { type: 'state_patch', node: node_id, patch: { status: 'error', error: String(err?.message || err) } });
    return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), { status: 500 });
  }
}

