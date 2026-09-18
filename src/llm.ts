/**
 * Cheap LLM helper — only used when deterministic matching fails.
 * If LLM_API_KEY is missing, returns null (caller falls back to re-prompt).
 */

export async function interpretFuzzyChoice(params: {
  userText: string;
  prompt: string;
  choices: Array<{ id: string; title: string }>;
}): Promise<string | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || params.choices.length === 0) return null;

  const baseUrl = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL || "gpt-4o-mini";

  const compact = params.choices.map((c) => `${c.id}:${c.title}`).join(" | ");
  const body = {
    model,
    temperature: 0,
    max_tokens: 40,
    messages: [
      {
        role: "system",
        content:
          "Map the user reply to exactly one choice id. Reply with ONLY the id, or NONE if unclear.",
      },
      {
        role: "user",
        content: `Prompt: ${params.prompt}\nChoices: ${compact}\nUser: ${params.userText}`,
      },
    ],
  };

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content?.trim() || "";
    const id = raw.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!id || id.toUpperCase() === "NONE") return null;
    return params.choices.some((c) => c.id === id) ? id : null;
  } catch {
    return null;
  }
}

export async function interpretDate(params: {
  userText: string;
  today: string;
  validDates: string[];
}): Promise<string | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL || "gpt-4o-mini";

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 20,
        messages: [
          {
            role: "system",
            content:
              "Convert the user phrase to YYYY-MM-DD from the valid list. Reply ONLY with the date or NONE.",
          },
          {
            role: "user",
            content: `Today: ${params.today}\nValid: ${params.validDates.join(",")}\nUser: ${params.userText}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = (data.choices?.[0]?.message?.content || "").trim();
    return params.validDates.includes(raw) ? raw : null;
  } catch {
    return null;
  }
}
