export const runtime = "edge";

import { toolSchemas, chat } from "@/lib/llm";
import { SESSIONS, enqueue } from "@/lib/runtime";
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

export async function POST(req: Request) {
  const { session_id, messages, node_id } = await req.json();

  if (!session_id || !SESSIONS.has(session_id)) {
    return new Response(JSON.stringify({ error: "invalid session" }), { status: 400 });
  }

  // SSE stream out to the client via the existing /api/stream
  // Here we only enqueue events so the UI sees them in the ReactFlow panel.
  const encoder = new TextEncoder();

  // Wrap the model with tools enabled
  const modelWithTools = chat.bindTools(
    toolSchemas.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchema(t.schema, t.name) as any,
      },
    }))
  );

  // Stream tokens into node.state
  const chunks: string[] = [];
  const stream = await modelWithTools.stream(messages, {
    callbacks: [
      {
        handleLLMNewToken: async (token: string) => {
          chunks.push(token);
          await enqueue(session_id, {
            type: "state_patch",
            node: node_id,
            patch: { status: "generating", partial: chunks.join("") },
          });
        },
      },
    ],
  });

  // Read the final message with potential tool-calls
  const plan = await modelWithTools.invoke(messages);
  // If the model decided to call tools, LangChain exposes them in `tool_calls`
  const toolCalls = (final?.tool_calls ?? []) as Array<{
    name: string;
    args: Record<string, any>;
  }>;

  // Execute each tool and append results to the transcript, then ask the model to produce a final answer
  if (toolCalls.length) {
    await enqueue(session_id, {
      type: "state_patch",
      node: node_id,
      patch: { status: "tool_calling", toolCalls },
    });

    const toolResults: Array<{ name: string; result: any }> = [];
    for (const call of toolCalls) {
      let result: any;
      if (call.name === "calc") {
        result = { result: safeCalc(call.args?.expression ?? "0") };
      } else if (call.name === "weather") {
        const city = String(call.args?.city ?? "Delhi");
        result = WEATHER[city] ?? { tempC: 28, condition: "Clear" };
      } else {
        result = { error: `Unknown tool ${call.name}` };
      }
      toolResults.push({ name: call.name, result });
    }

    await enqueue(session_id, {
      type: "state_patch",
      node: node_id,
      patch: { status: "tool_results", toolResults },
    });

    // Now let the model “see” tool results and produce a final message
    const toolMessages = toolResults.map((t) => ({
      role: "tool" as const,
      name: t.name,
      content: JSON.stringify(t.result),
    }));

    const finalStream = await chat.stream([...messages, final, ...toolMessages], {
      callbacks: [
        {
          handleLLMNewToken: async (token: string) => {
            chunks.push(token);
            await enqueue(session_id, {
              type: "state_patch",
              node: node_id,
              patch: { status: "answering", partial: chunks.join("") },
            });
          },
        },
      ],
    });

    const last = await finalStream.finalMessage();
    await enqueue(session_id, {
      type: "state_patch",
      node: node_id,
      patch: { status: "done", answer: last?.content ?? chunks.join("") },
    });
  } else {
    // No tool calls; just return the streamed text
    await enqueue(session_id, {
      type: "state_patch",
      node: node_id,
      patch: { status: "done", answer: final?.content ?? chunks.join("") },
    });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
}
