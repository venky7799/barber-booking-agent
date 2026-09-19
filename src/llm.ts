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

export type BookingNudge = {
  action: "confirm" | "cancel" | "change_barber" | "change_time" | "none";
  barberId: string | null;
  timeHint: string | null;
};

const nudgeSchema = z.object({
  action: z
    .enum(["confirm", "cancel", "change_barber", "change_time", "none"])
    .describe("What the user wants. change_barber if they name a preferred stylist. none if unclear."),
  barberId: z
    .string()
    .nullable()
    .describe("Exact barber id from the list of who they WANT, not who they reject. Null if unused."),
  timeHint: z
    .string()
    .nullable()
    .describe("24-hour HH:MM if they asked for a clock time, else null"),
});

export type BookingExtract = {
  intent: "book" | "cancel" | "reschedule" | "none";
  serviceId: string | null;
  barberId: string | null;
  dateId: string | null;
  timeHint: string | null;
};

const extractSchema = z.object({
  intent: z
    .enum(["book", "cancel", "reschedule", "none"])
    .describe("book if they want an appointment, even in a long sentence."),
  serviceId: z.string().nullable().describe("Exact service id from the list, else null."),
  barberId: z.string().nullable().describe("Exact barber id they WANT from the list, else null."),
  dateId: z.string().nullable().describe("Exact YYYY-MM-DD from the valid dates list, else null."),
  timeHint: z.string().nullable().describe("24-hour HH:MM if they named a clock time, else null."),
});

export async function interpretBookingExtract(params: {
  userText: string;
  today: string;
  services: Array<{ id: string; name: string }>;
  barbers: Array<{ id: string; name: string }>;
  validDates: Array<{ id: string; title: string }>;
}): Promise<BookingExtract> {
  const none: BookingExtract = {
    intent: "none",
    serviceId: null,
    barberId: null,
    dateId: null,
    timeHint: null,
  };
  const llm = model();
  if (!llm) return none;
  const allowedServices = new Set(params.services.map((s) => s.id));
  const allowedBarbers = new Set(params.barbers.map((b) => b.id));
  const allowedDates = new Set(params.validDates.map((d) => d.id));
  const serviceLine = params.services.map((s) => `${s.id}:${s.name}`).join(" | ") || "(none)";
  const barberLine = params.barbers.map((b) => `${b.id}:${b.name}`).join(" | ") || "(none)";
  const dateLine = params.validDates.map((d) => `${d.id}:${d.title}`).join(" | ") || "(none)";
  try {
    const structured = llm.withStructuredOutput(extractSchema);
    const out = await structured.invoke([
      {
        role: "system",
        content:
          "Extract a booking request. Use only ids from the lists. Never invent barbers, services, or dates. Map relative days (today, tomorrow) onto valid date ids. If they name a stylist they want, set that barberId. If they want an appointment, intent is book.",
      },
      {
        role: "user",
        content: `Today: ${params.today}\nServices: ${serviceLine}\nBarbers: ${barberLine}\nDates: ${dateLine}\nUser: ${params.userText}`,
      },
    ]);
    const serviceId = out.serviceId?.trim() && allowedServices.has(out.serviceId.trim()) ? out.serviceId.trim() : null;
    const barberId = out.barberId?.trim() && allowedBarbers.has(out.barberId.trim()) ? out.barberId.trim() : null;
    const dateId = out.dateId?.trim() && allowedDates.has(out.dateId.trim()) ? out.dateId.trim() : null;
    let timeHint = out.timeHint?.trim() || null;
    if (timeHint && !/^\d{2}:\d{2}$/.test(timeHint)) timeHint = null;
    const intent = out.intent;
    return { intent, serviceId, barberId, dateId, timeHint };
  } catch (err) {
    console.warn("[llm] extract skipped", err instanceof Error ? err.message : err);
    return none;
  }
}

export async function interpretBookingNudge(params: {
  userText: string;
  barbers: Array<{ id: string; name: string }>;
  openSlotLabels: string[];
}): Promise<BookingNudge> {
  const none: BookingNudge = { action: "none", barberId: null, timeHint: null };
  const llm = model();
  if (!llm) return none;
  const allowedBarbers = new Set(params.barbers.map((b) => b.id));
  const barberLine = params.barbers.map((b) => `${b.id}:${b.name}`).join(" | ") || "(none)";
  const slotsLine = params.openSlotLabels.slice(0, 40).join(" | ") || "(none)";
  try {
    const structured = llm.withStructuredOutput(nudgeSchema);
    const out = await structured.invoke([
      {
        role: "system",
        content:
          "You interpret a booking-chat message. Use only barber ids from the list. If they want one named stylist and reject another, set action change_barber to the id of the one they want. Never invent ids. confirm or cancel only for agreement or abort. change_time plus timeHint HH:MM if they ask for a clock time. If unclear, action none.",
      },
      {
        role: "user",
        content: `Barbers: ${barberLine}\nOpen slots: ${slotsLine}\nUser: ${params.userText}`,
      },
    ]);
    const action = out.action;
    let barberId = out.barberId?.trim() || null;
    if (barberId && !allowedBarbers.has(barberId)) barberId = null;
    let timeHint = out.timeHint?.trim() || null;
    if (timeHint && !/^\d{2}:\d{2}$/.test(timeHint)) timeHint = null;
    if (action === "change_barber" && !barberId) return none;
    if (action === "change_time" && !timeHint) return none;
    return { action, barberId, timeHint };
  } catch (err) {
    console.warn("[llm] nudge skipped", err instanceof Error ? err.message : err);
    return none;
  }
}
