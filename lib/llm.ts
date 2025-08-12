// lib/llm.ts
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

// --- Model ---
// Use a small, fast model for tool-routing; swap for your preferred one.
export const chat = new ChatOpenAI({
    apiKey: "sk-anything", // not used but required by interface
    baseURL: "https://suraj-kumar-2013--chatbot-fastapi-app.modal.run/v1/",
    model: "local-llama",
    temperature: 0.7
});

// --- Tool definitions (JS/TS) ---
export const calcTool = {
  name: "calc",
  description: "Safely evaluate a simple math expression.",
  schema: z.object({ expression: z.string().describe("math expression, e.g. '2+2*3'") }),
  // You run the tool yourself; this is only the schema passed to the model.
};

export const weatherTool = {
  name: "weather",
  description: "Return a fake weather snapshot for a city.",
  schema: z.object({ city: z.string() }),
};

// Tools array for `bindTools`
export const toolSchemas = [calcTool, weatherTool];
