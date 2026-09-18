import {
  getShopByCode,
  getShopById,
  getShopByTwilioNumber,
  getShopByWhatsappNumber,
} from "./shops.js";
import { emptyDraft, getOrCreateSession, resetSession, saveSession } from "./sessions.js";
import {
  cancelBooking,
  confirmBooking,
  formatDate,
  getAvailableSlots,
  lockSlot,
  releaseSessionLocks,
  upcomingDateChoices,
} from "./slots.js";
import { interpretFuzzyChoice } from "./llm.js";
import { syncBookingToGoogle } from "./google-sync.js";
import type {
  Channel,
  OrchestratorReply,
  Session,
  Shop,
  ShopQuestion,
} from "./types.js";

function isGreeting(text: string): boolean {
  return /^(hi+|hii+|hello|hey+|heya|yo|hola|sup|good (morning|afternoon|evening)|thanks|thank you|namaste)\.?$/.test(
    normalize(text)
  );
}

function wantsAvailability(text: string): boolean {
  return /\b(list\s+of\s+)?slots?\b|\btimings?\b|\bavailable(\s+(times?|slots?))?\b|\bopenings?\b|\bwhat times?\b/i.test(
    text
  );
}

function stashAndListSlots(shop: Shop, session: Session, dateId: string, channel: Channel): OrchestratorReply {
  const slots = getAvailableSlots(
    shop,
    dateId,
    session.draft.serviceId!,
    session.draft.barberId || null
  );
  if (slots.length === 0) {
    session.step = "await_date";
    return {
      text: "No openings that day. Pick another date.",
      step: "await_date",
      choices: upcomingDateChoices(shop.config),
      choiceMode: channel === "voice" ? "dtmf" : "list",
    };
  }
  const shown = slots.slice(0, 10);
  session.draft.answers.__slots = shown.map((s) => `${s.start}|${s.end}|${s.barberId || ""}`);
  session.step = "await_time";
  const choices = shown.map((s, i) => ({ id: String(i + 1), title: s.label }));
  const numbered = choices.map((c) => `${c.id}. ${c.title}`).join("\n");
  return {
    text: `Open slots:\n${numbered}\n\nReply with a number or tap Choose.`,
    step: "await_time",
    choices,
    choiceMode: channel === "voice" ? "dtmf" : "list",
  };
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function matchChoice(
  text: string,
  choices: Array<{ id: string; title: string }>,
  dtmf?: string
): string | null {
  if (dtmf) {
    const n = Number(dtmf);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].id;
  }
  const t = normalize(text);
  if (!t) return null;

  // Prefer keypad-style numeric replies before fuzzy title matching
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n >= 1 && n <= choices.length) return choices[n - 1].id;
  }

  for (const c of choices) {
    if (normalize(c.id) === t || normalize(c.title) === t) return c.id;
  }

  // Whole-word / substantive fuzzy match only for longer text
  if (t.length >= 3) {
    for (const c of choices) {
      const title = normalize(c.title);
      if (title === t || title.startsWith(t) || t.startsWith(normalize(c.id))) return c.id;
      // match option words without matching digits inside prices
      const titleWords = title.replace(/\$[\d.]+/g, "").replace(/\(\d+m\)/g, "");
      if (titleWords.includes(t) || t.includes(normalize(c.id))) return c.id;
    }
  }
  return null;
}

function matchClosedKeywords(
  text: string,
  choices: Array<{ id: string; title: string }>
): string | null {
  const t = normalize(text);
  if (!t) return null;
  const ids = new Set(choices.map((c) => c.id));

  const yes = new Set(["yes", "y", "yeah", "yep", "ok", "okay", "sure"]);
  const no = new Set(["no", "n", "nope", "nah"]);
  if (ids.has("yes") && yes.has(t)) return "yes";
  if (ids.has("no") && no.has(t)) return "no";

  const book = new Set(["book", "booking", "appointment", "appoint"]);
  const cancel = new Set(["cancel", "cancelled", "canceled"]);
  const reschedule = new Set(["reschedule", "change", "move"]);
  if (ids.has("book") && book.has(t)) return "book";
  if (ids.has("cancel") && cancel.has(t)) return "cancel";
  if (ids.has("reschedule") && reschedule.has(t)) return "reschedule";

  const today = formatDate(new Date());
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = formatDate(tomorrowDate);
  if (t === "today" && ids.has(today)) return today;
  if (t === "tomorrow" && ids.has(tomorrow)) return tomorrow;

  const weekday = t.slice(0, 3);
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  if (days.includes(weekday) && t.length >= 3) {
    const hit = choices.find((c) => normalize(c.title).startsWith(weekday) || normalize(c.id).includes(weekday));
    if (hit) return hit.id;
  }
  return null;
}

async function resolveChoice(
  text: string,
  prompt: string,
  choices: Array<{ id: string; title: string }>,
  dtmf?: string
): Promise<string | null> {
  const direct = matchChoice(text, choices, dtmf);
  if (direct) return direct;
  const closed = matchClosedKeywords(text, choices);
  if (closed) return closed;
  if (!text.trim() || isGreeting(text)) return null;
  return interpretFuzzyChoice({ userText: text, prompt, choices });
}

function intentChoices(): Array<{ id: string; title: string }> {
  return [
    { id: "book", title: "Book" },
    { id: "cancel", title: "Cancel" },
    { id: "reschedule", title: "Reschedule" },
  ];
}

function serviceChoices(shop: Shop) {
  return shop.config.services.map((s) => ({
    id: s.id,
    title: `${s.name} (${s.durationMinutes}m · ${money(s.priceCents)})`,
  }));
}

function barberChoices(shop: Shop) {
  return [
    { id: "any", title: "Any barber" },
    ...shop.config.barbers.map((b) => ({ id: b.id, title: b.name })),
  ];
}

function questionChoices(q: ShopQuestion): Array<{ id: string; title: string }> | undefined {
  if (q.type === "yes_no") return [
    { id: "yes", title: "Yes" },
    { id: "no", title: "No" },
  ];
  if (q.type === "single_choice" || q.type === "multi_choice") {
    return (q.options || []).map((o) => ({ id: o, title: o }));
  }
  return undefined;
}

function promptForQuestion(q: ShopQuestion): string {
  if (q.type === "yes_no") return `${q.prompt} (Yes/No)`;
  if (q.options?.length) return `${q.prompt}\nOptions: ${q.options.join(", ")}`;
  return q.prompt;
}

function summaryText(shop: Shop, session: Session): string {
  const service = shop.config.services.find((s) => s.id === session.draft.serviceId);
  const barber =
    session.draft.barberId && session.draft.barberId !== "any"
      ? shop.config.barbers.find((b) => b.id === session.draft.barberId)?.name
      : "Any";
  const answers = Object.entries(session.draft.answers)
    .filter(([k]) => !k.startsWith("__") && k !== "_action")
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("; ");
  return [
    `Please confirm your booking at ${shop.name}:`,
    `Service: ${service?.name}`,
    `Barber: ${barber}`,
    `When: ${session.draft.date} at ${session.draft.time}`,
    answers ? `Notes: ${answers}` : null,
    `Reply YES to confirm or NO to cancel.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function greeting(shop: Shop | null, channel: Channel): OrchestratorReply {
  if (!shop) {
    return {
      text:
        channel === "voice"
          ? "Welcome to Barber Booking. Enter your shop code using the keypad, followed by pound."
          : "Welcome to Barber Booking. Reply with your shop code to get started (e.g. FADE01).",
      step: "await_shop_code",
      gatherSpeech: false,
    };
  }
  return {
    text: `${shop.config.greeting}\nReply BOOK, CANCEL, or RESCHEDULE.`,
    step: "await_intent",
    choices: intentChoices(),
    choiceMode: channel === "voice" ? "dtmf" : "buttons",
  };
}

export async function handleTurn(params: {
  channel: Channel;
  externalId: string;
  text: string;
  dtmf?: string;
  toNumber?: string;
}): Promise<{ reply: OrchestratorReply; session: Session; shop: Shop | null }> {
  const session = getOrCreateSession(params.channel, params.externalId);
  let shop = session.shopId ? getShopById(session.shopId) : null;

  // Resolve shop from dialed/WhatsApp business number if not set
  if (!shop && params.toNumber) {
    shop =
      params.channel === "whatsapp"
        ? getShopByWhatsappNumber(params.toNumber)
        : getShopByTwilioNumber(params.toNumber);
    if (shop) {
      session.shopId = shop.id;
      session.step = "await_intent";
      saveSession(session);
    }
  }

  const text = params.text || "";
  const lower = normalize(text);

  // Global restart / greetings with an assigned shop
  if (["restart", "start over", "menu"].includes(lower) || isGreeting(text)) {
    releaseSessionLocks(session.id);
    resetSession(session, session.shopId);
    shop = session.shopId ? getShopById(session.shopId) : null;
    const reply = greeting(shop, params.channel);
    session.step = reply.step;
    session.lastPrompt = reply.text;
    saveSession(session);
    return { reply, session, shop };
  }

  if (session.step === "idle") {
    session.step = shop ? "await_intent" : "await_shop_code";
    saveSession(session);
  }

  if (session.step === "await_shop_code") {
    const code = (params.dtmf || text).replace(/[^a-zA-Z0-9]/g, "");
    if (!code) {
      const reply = greeting(null, params.channel);
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop: null };
    }
    const found = getShopByCode(code);
    if (!found) {
      const reply: OrchestratorReply = {
        text: "Shop code not found. Please try again.",
        step: "await_shop_code",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop: null };
    }
    shop = found;
    resetSession(session, found.id);
    const reply = greeting(found, params.channel);
    session.step = reply.step;
    session.lastPrompt = reply.text;
    saveSession(session);
    return { reply, session, shop };
  }

  if (!shop) {
    session.step = "await_shop_code";
    const reply = greeting(null, params.channel);
    session.lastPrompt = reply.text;
    saveSession(session);
    return { reply, session, shop: null };
  }

  if (wantsAvailability(text) && shop) {
    if (session.draft.serviceId && session.draft.date) {
      const reply = stashAndListSlots(shop, session, session.draft.date, params.channel);
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    if (session.draft.serviceId) {
      session.step = "await_date";
      const dates = upcomingDateChoices(shop.config);
      const reply: OrchestratorReply = {
        text: "Pick a day and I'll list open slots.",
        step: "await_date",
        choices: dates,
        choiceMode: params.channel === "voice" ? "dtmf" : "list",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    session.draft = emptyDraft();
    session.step = "await_service";
    const reply: OrchestratorReply = {
      text: "Pick a service first — then a day — and I'll list open slots.",
      step: "await_service",
      choices: serviceChoices(shop),
      choiceMode: params.channel === "voice" ? "dtmf" : "list",
    };
    session.lastPrompt = reply.text;
    saveSession(session);
    return { reply, session, shop };
  }

  // Intent
  if (session.step === "await_intent") {
    const intent = await resolveChoice(text, "Choose an action", intentChoices(), params.dtmf);
    if (intent === "cancel") {
      session.step = "await_confirm";
      session.draft = { ...emptyDraft(), answers: { _action: "cancel" } };
      const reply: OrchestratorReply = {
        text: "Send your booking reference to cancel (e.g. BRB-ABC123).",
        step: "await_confirm",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    if (intent === "reschedule") {
      const reply: OrchestratorReply = {
        text: "To reschedule, cancel your current booking then book a new slot. Reply BOOK to continue.",
        step: "await_intent",
        choices: intentChoices(),
        choiceMode: params.channel === "voice" ? "dtmf" : "buttons",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    if (intent !== "book") {
      const reply: OrchestratorReply = {
        text: "Please choose BOOK, CANCEL, or RESCHEDULE.",
        step: "await_intent",
        choices: intentChoices(),
        choiceMode: params.channel === "voice" ? "dtmf" : "buttons",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    session.draft = emptyDraft();
    session.step = "await_service";
    const choices = serviceChoices(shop);
    const reply: OrchestratorReply = {
      text: "Which service would you like?",
      step: "await_service",
      choices,
      choiceMode: params.channel === "voice" ? "dtmf" : "list",
    };
    session.lastPrompt = reply.text;
    saveSession(session);
    return { reply, session, shop };
  }

  // Cancel via reference stored under await_confirm with _action
  if (session.step === "await_confirm" && session.draft.answers._action === "cancel") {
    const ref = text.trim().toUpperCase();
    const cancelled = cancelBooking(ref, params.externalId);
    if (!cancelled) {
      const reply: OrchestratorReply = {
        text: "Booking not found for your number. Check the reference and try again, or reply MENU.",
        step: "await_confirm",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    resetSession(session, shop.id);
    const reply: OrchestratorReply = {
      text: `Cancelled ${cancelled.reference}. Reply BOOK for a new appointment.`,
      step: "await_intent",
      choices: intentChoices(),
      choiceMode: params.channel === "voice" ? "dtmf" : "buttons",
      endSession: params.channel === "voice",
    };
    session.lastPrompt = reply.text;
    saveSession(session);
    return { reply, session, shop };
  }

  if (session.step === "await_service") {
    const choices = serviceChoices(shop);
    const id = await resolveChoice(text, "Pick a service", choices, params.dtmf);
    if (!id) {
      const reply: OrchestratorReply = {
        text: "Please pick a service from the list.",
        step: "await_service",
        choices,
        choiceMode: params.channel === "voice" ? "dtmf" : "list",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    session.draft.serviceId = id;
    if (shop.config.barbers.length > 0) {
      session.step = "await_barber";
      const bChoices = barberChoices(shop);
      const reply: OrchestratorReply = {
        text: "Any preferred barber?",
        step: "await_barber",
        choices: bChoices,
        choiceMode: params.channel === "voice" ? "dtmf" : "list",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    session.step = "await_date";
    const dates = upcomingDateChoices(shop.config);
    const reply: OrchestratorReply = {
      text: "Which day works for you?",
      step: "await_date",
      choices: dates,
      choiceMode: params.channel === "voice" ? "dtmf" : "list",
    };
    session.lastPrompt = reply.text;
    saveSession(session);
    return { reply, session, shop };
  }

  if (session.step === "await_barber") {
    const choices = barberChoices(shop);
    const id = await resolveChoice(text, "Pick a barber", choices, params.dtmf);
    if (!id) {
      const reply: OrchestratorReply = {
        text: "Please choose a barber.",
        step: "await_barber",
        choices,
        choiceMode: params.channel === "voice" ? "dtmf" : "list",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    session.draft.barberId = id === "any" ? undefined : id;
    session.step = "await_date";
    const dates = upcomingDateChoices(shop.config);
    const reply: OrchestratorReply = {
      text: "Which day works for you?",
      step: "await_date",
      choices: dates,
      choiceMode: params.channel === "voice" ? "dtmf" : "list",
    };
    session.lastPrompt = reply.text;
    saveSession(session);
    return { reply, session, shop };
  }

  if (session.step === "await_date") {
    const dates = upcomingDateChoices(shop.config);
    let dateId = await resolveChoice(text, "Pick a date", dates, params.dtmf);
    if (!dateId) {
      const reply: OrchestratorReply = {
        text: "Please choose a date from the list.",
        step: "await_date",
        choices: dates,
        choiceMode: params.channel === "voice" ? "dtmf" : "list",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    session.draft.date = dateId;
    const reply = stashAndListSlots(shop, session, dateId, params.channel);
    session.lastPrompt = reply.text;
    saveSession(session);
    return { reply, session, shop };
  }

  if (session.step === "await_time") {
    const rawSlots = session.draft.answers.__slots;
    const slotLines = Array.isArray(rawSlots) ? rawSlots : typeof rawSlots === "string" ? [rawSlots] : [];
    const choices = slotLines.map((line, i) => {
      const [start] = line.split("|");
      const d = new Date(start);
      const label = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      return { id: String(i + 1), title: label };
    });
    const picked = await resolveChoice(text, "Pick a time", choices, params.dtmf);
    if (!picked) {
      const reply: OrchestratorReply = {
        text: "Please pick a time from the list.",
        step: "await_time",
        choices,
        choiceMode: params.channel === "voice" ? "dtmf" : "list",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    const line = slotLines[Number(picked) - 1];
    const [start, end, barberId] = line.split("|");
    try {
      const lockId = lockSlot({
        shopId: shop.id,
        sessionId: session.id,
        startsAt: start,
        endsAt: end,
        barberId: barberId || null,
      });
      session.draft.lockId = lockId;
      const startDate = new Date(start);
      session.draft.date = formatDate(startDate);
      session.draft.time = `${String(startDate.getHours()).padStart(2, "0")}:${String(startDate.getMinutes()).padStart(2, "0")}`;
      if (barberId) session.draft.barberId = barberId;
      session.draft.answers = Object.fromEntries(
        Object.entries(session.draft.answers).filter(([k]) => !k.startsWith("__"))
      );
      // stash iso times
      session.draft.answers.__start = start;
      session.draft.answers.__end = end;
    } catch {
      session.step = "await_date";
      const dates = upcomingDateChoices(shop.config);
      const reply: OrchestratorReply = {
        text: "That slot was just taken. Pick another day.",
        step: "await_date",
        choices: dates,
        choiceMode: params.channel === "voice" ? "dtmf" : "list",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }

    session.draft.questionIndex = 0;
    if (shop.config.questions.length > 0) {
      session.step = "await_question";
      const q = shop.config.questions[0];
      const reply: OrchestratorReply = {
        text: promptForQuestion(q),
        step: "await_question",
        choices: questionChoices(q),
        choiceMode: params.channel === "voice" ? "dtmf" : q.type === "yes_no" ? "buttons" : "list",
        gatherSpeech: q.type === "short_text",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    session.step = "await_confirm";
    const reply: OrchestratorReply = {
      text: summaryText(shop, session),
      step: "await_confirm",
      choices: [
        { id: "yes", title: "Confirm" },
        { id: "no", title: "Cancel" },
      ],
      choiceMode: params.channel === "voice" ? "dtmf" : "buttons",
    };
    session.lastPrompt = reply.text;
    saveSession(session);
    return { reply, session, shop };
  }

  if (session.step === "await_question") {
    const q = shop.config.questions[session.draft.questionIndex];
    if (!q) {
      session.step = "await_confirm";
    } else {
      const choices = questionChoices(q);
      let answer: string | string[] | null = null;
      if (choices) {
        answer = await resolveChoice(text, q.prompt, choices, params.dtmf);
      } else {
        answer = text.trim() || null;
      }
      if (!answer && q.required) {
        const reply: OrchestratorReply = {
          text: `I need an answer. ${promptForQuestion(q)}`,
          step: "await_question",
          choices,
          choiceMode: params.channel === "voice" ? "dtmf" : q.type === "yes_no" ? "buttons" : "list",
          gatherSpeech: q.type === "short_text",
        };
        session.lastPrompt = reply.text;
        saveSession(session);
        return { reply, session, shop };
      }
      if (answer) session.draft.answers[q.id] = answer;
      session.draft.questionIndex += 1;
      if (session.draft.questionIndex < shop.config.questions.length) {
        const next = shop.config.questions[session.draft.questionIndex];
        const reply: OrchestratorReply = {
          text: promptForQuestion(next),
          step: "await_question",
          choices: questionChoices(next),
          choiceMode:
            params.channel === "voice" ? "dtmf" : next.type === "yes_no" ? "buttons" : "list",
          gatherSpeech: next.type === "short_text",
        };
        session.lastPrompt = reply.text;
        saveSession(session);
        return { reply, session, shop };
      }
      session.step = "await_confirm";
      const reply: OrchestratorReply = {
        text: summaryText(shop, session),
        step: "await_confirm",
        choices: [
          { id: "yes", title: "Confirm" },
          { id: "no", title: "Cancel" },
        ],
        choiceMode: params.channel === "voice" ? "dtmf" : "buttons",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
  }

  if (session.step === "await_confirm") {
    const yesNo = [
      { id: "yes", title: "Confirm" },
      { id: "no", title: "Cancel" },
    ];
    const decision = await resolveChoice(text, "Confirm booking?", yesNo, params.dtmf);
    if (decision === "no") {
      releaseSessionLocks(session.id);
      resetSession(session, shop.id);
      const reply: OrchestratorReply = {
        text: "Booking cancelled. Reply BOOK to start again.",
        step: "await_intent",
        choices: intentChoices(),
        choiceMode: params.channel === "voice" ? "dtmf" : "buttons",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    if (decision !== "yes") {
      const reply: OrchestratorReply = {
        text: summaryText(shop, session),
        step: "await_confirm",
        choices: yesNo,
        choiceMode: params.channel === "voice" ? "dtmf" : "buttons",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }

    const start = String(session.draft.answers.__start || "");
    const end = String(session.draft.answers.__end || "");
    if (!start || !end || !session.draft.serviceId) {
      resetSession(session, shop.id);
      const reply: OrchestratorReply = {
        text: "Something went wrong. Let's start over. Reply BOOK.",
        step: "await_intent",
        choices: intentChoices(),
        choiceMode: params.channel === "voice" ? "dtmf" : "buttons",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }

    const answers = Object.fromEntries(
      Object.entries(session.draft.answers).filter(([k]) => !k.startsWith("__") && k !== "_action")
    );

    try {
      const booking = confirmBooking({
        shopId: shop.id,
        sessionId: session.id,
        customerExternalId: params.externalId,
        channel: params.channel,
        serviceId: session.draft.serviceId,
        barberId: session.draft.barberId || null,
        startsAt: start,
        endsAt: end,
        answers,
      });
      void syncBookingToGoogle(shop, booking);
      resetSession(session, shop.id);
      const reply: OrchestratorReply = {
        text: `${shop.config.confirmation}\nReference: ${booking.reference}\nWhen: ${new Date(
          booking.startsAt
        ).toLocaleString()}`,
        step: "completed",
        bookingReference: booking.reference,
        endSession: true,
      };
      session.lastPrompt = reply.text;
      session.step = "await_intent";
      saveSession(session);
      return { reply, session, shop };
    } catch {
      releaseSessionLocks(session.id);
      session.step = "await_date";
      session.draft = emptyDraft();
      const dates = upcomingDateChoices(shop.config);
      const reply: OrchestratorReply = {
        text: "That slot is no longer available. Pick another day.",
        step: "await_date",
        choices: dates,
        choiceMode: params.channel === "voice" ? "dtmf" : "list",
      };
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
  }

  const reply = greeting(shop, params.channel);
  session.step = reply.step;
  session.lastPrompt = reply.text;
  saveSession(session);
  return { reply, session, shop };
}
