/**
 * LangChain fallback — only when matchChoice / keywords miss.
 * Maps user text onto the current choice ids. Never invents booking steps.
 */
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const choiceSchema = z.object({
  choiceId: z
    .string()
    .nullable()
    .describe("Exact id from the provided list, or null if unclear"),
});

function model(): ChatOpenAI | null {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;
  const baseURL = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  return new ChatOpenAI({
    model: process.env.LLM_MODEL || "gpt-4o-mini",
    apiKey,
    temperature: 0,
    timeout: 4000,
    maxRetries: 0,
    configuration: { baseURL },
  });
}

export async function interpretFuzzyChoice(params: {
  userText: string;
  prompt: string;
  choices: Array<{ id: string; title: string }>;
}): Promise<string | null> {
  if (params.choices.length === 0) return null;
  const llm = model();
  if (!llm) return null;

  const compact = params.choices.map((c) => `${c.id}:${c.title}`).join(" | ");
  const allowed = new Set(params.choices.map((c) => c.id));

  try {
    const structured = llm.withStructuredOutput(choiceSchema);
    const out = await structured.invoke([
      {
        role: "system",
        content:
          "You map a user reply to exactly one booking-menu choice. Use only an id from the list. If unsure, return choiceId null. Do not invent steps, times, or ids.",
      },
      {
        role: "user",
        content: `Prompt: ${params.prompt}\nChoices: ${compact}\nUser: ${params.userText}`,
      },
    ]);
    const id = out.choiceId?.trim() || "";
    if (!id || id.toUpperCase() === "NONE") return null;
    return allowed.has(id) ? id : null;
  } catch (err) {
    console.warn("[llm] fallback skipped", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function interpretDate(params: {
  userText: string;
  today: string;
  validDates: string[];
}): Promise<string | null> {
  return interpretFuzzyChoice({
    userText: params.userText,
    prompt: `Convert to a date. Today is ${params.today}.`,
    choices: params.validDates.map((id) => ({ id, title: id })),
  });
}
