import {
  getShopByCode,
  getShopById,
  getShopByTwilioNumber,
  getShopByWhatsappNumber,
} from "./shops.js";
import { emptyDraft, getOrCreateSession, resetSession, saveSession } from "./sessions.js";
import {
  atBookingCap,
  cancelBooking,
  confirmBooking,
  countActiveBookings,
  formatDate,
  getAvailableSlots,
  lockSlot,
  MAX_ACTIVE_BOOKINGS_PER_NUMBER,
  releaseSessionLocks,
  upcomingDateChoices,
} from "./slots.js";
import { interpretBookingExtract, interpretBookingNudge, interpretFuzzyChoice } from "./llm.js";
import { syncBookingToGoogle } from "./google-sync.js";
import type {
  Channel,
  OrchestratorReply,
  Session,
  Shop,
  ShopQuestion,
  Weekday,
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

function parseClockHint(text: string): { hours: number; minutes: number } | null {
  const t = normalize(text);
  const ampm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/);
  if (ampm) {
    let hours = Number(ampm[1]);
    const minutes = Number(ampm[2] || 0);
    const mer = ampm[3].replace(/\./g, "")[0];
    if (mer === "p" && hours < 12) hours += 12;
    if (mer === "a" && hours === 12) hours = 0;
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) return { hours, minutes };
  }
  const hm = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (hm) return { hours: Number(hm[1]), minutes: Number(hm[2]) };
  return null;
}

function hoursLine(shop: Shop, dateId: string): string {
  const parts = dateId.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return "";
  const [y, m, d] = parts;
  const dt = new Date(y, m - 1, d);
  const keys: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const key = keys[dt.getDay()];
  const hours = shop.config.hours[key];
  if (!hours) return "";
  return `Shop hours ${names[dt.getDay()]} ${hours.open}–${hours.close} (from the shop sheet).\n`;
}

const MORE_TIMES_ID = "__more";
const SLOT_PAGE_SIZE = 9;

function stashAndListSlots(
  shop: Shop,
  session: Session,
  dateId: string,
  channel: Channel,
  resetPage = true
): OrchestratorReply {
  const slots = getAvailableSlots(
    shop,
    dateId,
    session.draft.serviceId!,
    session.draft.barberId || null
  );
  if (slots.length === 0) {
    session.step = "await_date";
    delete session.draft.answers.__slotPage;
    return {
      text: "No openings that day. Pick another date.",
      step: "await_date",
      choices: upcomingDateChoices(shop.config),
      choiceMode: channel === "voice" ? "dtmf" : "list",
    };
  }
  session.draft.answers.__slots = slots.map((s) => `${s.start}|${s.end}|${s.barberId || ""}`);
  if (resetPage) session.draft.answers.__slotPage = "0";
  session.step = "await_time";

  if (channel === "voice") {
    const shown = slots.slice(0, 9);
    const choices = shown.map((s, i) => ({ id: String(i + 1), title: s.label }));
    const numbered = choices.map((c) => `${c.id}. ${c.title}`).join("\n");
    return {
      text: `${hoursLine(shop, dateId)}Open slots (booked times are hidden):\n${numbered}\n\nPress a number.`,
      step: "await_time",
      choices,
      choiceMode: "dtmf",
    };
  }

  const page = Math.max(0, Number(session.draft.answers.__slotPage) || 0);
  let startIdx = page * SLOT_PAGE_SIZE;
  if (startIdx >= slots.length) {
    session.draft.answers.__slotPage = "0";
    startIdx = 0;
  }
  const leftover = slots.length - startIdx;
  const take = leftover > 10 ? SLOT_PAGE_SIZE : leftover;
  const slice = slots.slice(startIdx, startIdx + take);
  const choices = slice.map((s, i) => ({ id: String(startIdx + i + 1), title: s.label }));
  if (startIdx + slice.length < slots.length) {
    choices.push({ id: MORE_TIMES_ID, title: "More times" });
  }
  const from = startIdx + 1;
  const to = startIdx + slice.length;
  return {
    text: `${hoursLine(shop, dateId)}Open slots ${from}–${to} of ${slots.length} (booked times are hidden). Tap Choose to pick a time, tap More times for later slots, or reply with a number 1–${slots.length}.`,
    step: "await_time",
    choices,
    choiceMode: "list",
  };
}

function slotTakenRefresh(shop: Shop, session: Session, dateId: string, channel: Channel): OrchestratorReply {
  const inner = stashAndListSlots(shop, session, dateId, channel);
  if (inner.step !== "await_time") return inner;
  return { ...inner, text: `That time was just booked. Pick another.\n\n${inner.text}` };
}

function slotStillOpen(
  shop: Shop,
  dateId: string,
  start: string,
  end: string,
  barberId: string | null,
  serviceId: string
): boolean {
  return getAvailableSlots(shop, dateId, serviceId, barberId).some(
    (s) => s.start === start && s.end === end && (s.barberId || "") === (barberId || "")
  );
}

const confirmButtons = [
  { id: "yes", title: "Confirm" },
  { id: "no", title: "Cancel" },
];

function retargetClock(
  shop: Shop,
  session: Session,
  channel: Channel,
  hours: number,
  minutes: number
): OrchestratorReply {
  const dateId = session.draft.date;
  if (!dateId || !session.draft.serviceId) {
    return {
      text: "Tap Confirm, Cancel, or say who or when you want.",
      step: "await_confirm",
      choices: confirmButtons,
      choiceMode: channel === "voice" ? "dtmf" : "buttons",
    };
  }
  releaseSessionLocks(session.id);
  const live = getAvailableSlots(
    shop,
    dateId,
    session.draft.serviceId,
    session.draft.barberId || null
  );
  const hit = live.find((s) => {
    const d = new Date(s.start);
    return d.getHours() === hours && d.getMinutes() === minutes;
  });
  const want = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  if (!hit) {
    const reply = slotTakenRefresh(shop, session, dateId, channel);
    reply.text = `${want} is not free. Pick another time.\n\n${reply.text.replace(/^That time was just booked\. Pick another\.\n\n/, "")}`;
    return reply;
  }
  try {
    const lockId = lockSlot({
      shopId: shop.id,
      sessionId: session.id,
      startsAt: hit.start,
      endsAt: hit.end,
      barberId: hit.barberId,
    });
    session.draft.lockId = lockId;
    if (hit.barberId) session.draft.barberId = hit.barberId;
    const startDate = new Date(hit.start);
    session.draft.time = `${String(startDate.getHours()).padStart(2, "0")}:${String(startDate.getMinutes()).padStart(2, "0")}`;
    session.draft.answers.__start = hit.start;
    session.draft.answers.__end = hit.end;
    session.step = "await_confirm";
    return {
      text: summaryText(shop, session),
      step: "await_confirm",
      choices: confirmButtons,
      choiceMode: channel === "voice" ? "dtmf" : "buttons",
    };
  } catch {
    return slotTakenRefresh(shop, session, dateId, channel);
  }
}

async function applyBookingNudge(
  shop: Shop,
  session: Session,
  channel: Channel,
  userText: string
): Promise<OrchestratorReply | "confirm" | "cancel" | null> {
  const labels =
    session.draft.date && session.draft.serviceId
      ? getAvailableSlots(shop, session.draft.date, session.draft.serviceId, null).map((s) => s.label)
      : [];
  const nudge = await interpretBookingNudge({
    userText,
    barbers: shop.config.barbers,
    openSlotLabels: labels,
  });
  if (nudge.action === "none") return null;
  if (nudge.action === "confirm") return "confirm";
  if (nudge.action === "cancel") return "cancel";
  if (nudge.action === "change_barber" && nudge.barberId) {
    releaseSessionLocks(session.id);
    session.draft.barberId = nudge.barberId;
    const name = shop.config.barbers.find((b) => b.id === nudge.barberId)?.name || "that barber";
    if (nudge.timeHint) {
      const [hh, mm] = nudge.timeHint.split(":").map(Number);
      if (Number.isInteger(hh) && Number.isInteger(mm)) {
        const clocked = retargetClock(shop, session, channel, hh, mm);
        if (clocked.step === "await_confirm") {
          return { ...clocked, text: `Switched to ${name}.\n\n${clocked.text}` };
        }
        return clocked;
      }
    }
    if (session.draft.date && session.draft.serviceId) {
      const inner = stashAndListSlots(shop, session, session.draft.date, channel);
      if (inner.step !== "await_time") return inner;
      return { ...inner, text: `Switching to ${name}. Pick a time.\n\n${inner.text}` };
    }
    session.step = "await_date";
    return {
      text: `Switching to ${name}. Which day works?`,
      step: "await_date",
      choices: upcomingDateChoices(shop.config),
      choiceMode: channel === "voice" ? "dtmf" : "list",
    };
  }
  if (nudge.action === "change_time" && nudge.timeHint) {
    const [hh, mm] = nudge.timeHint.split(":").map(Number);
    if (Number.isInteger(hh) && Number.isInteger(mm)) {
      return retargetClock(shop, session, channel, hh, mm);
    }
  }
  return null;
}

function money(cents: number, currency = "USD"): string {
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat(code === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: code === "INR" ? 0 : 2,
    }).format(cents / 100);
  } catch {
    return `${code} ${(cents / 100).toFixed(2)}`;
  }
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
      const id = normalize(c.id);
      const title = normalize(c.title);
      if (title === t) return c.id;
      if (id.length <= 3) continue;
      if (title.startsWith(t) || t.startsWith(id)) return c.id;
      const titleWords = title.replace(/\$[\d.]+/g, "").replace(/\(\d+m\)/g, "");
      if (titleWords.includes(t) || t.includes(id)) return c.id;
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

function matchNameFromList(
  items: Array<{ id: string; name: string }>,
  text: string
): string | null {
  const t = normalize(text);
  for (const item of items) {
    const name = normalize(item.name);
    if (name.length < 3) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(t)) return item.id;
  }
  return null;
}

function applyScheduleFallbacks(shop: Shop, session: Session, userText: string): void {
  const dates = upcomingDateChoices(shop.config);
  const dateIds = new Set(dates.map((d) => d.id));
  if (!session.draft.barberId) {
    const id = matchNameFromList(shop.config.barbers, userText);
    if (id) session.draft.barberId = id;
  }
  if (!session.draft.serviceId) {
    const id = matchNameFromList(
      shop.config.services.map((s) => ({ id: s.id, name: s.name })),
      userText
    );
    if (id) session.draft.serviceId = id;
  }
  if (!session.draft.answers.__timeHint) {
    const clock = parseClockHint(userText);
    if (clock) {
      session.draft.answers.__timeHint = `${String(clock.hours).padStart(2, "0")}:${String(clock.minutes).padStart(2, "0")}`;
    }
  }
  if (!session.draft.date) {
    const tl = normalize(userText);
    const today = formatDate(new Date());
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = formatDate(tomorrowDate);
    if (/\btomorrow\b/.test(tl) && dateIds.has(tomorrow)) session.draft.date = tomorrow;
    else if (/\btoday\b/.test(tl) && dateIds.has(today)) session.draft.date = today;
  }
}

function applyBookingExtract(
  shop: Shop,
  session: Session,
  extract: Awaited<ReturnType<typeof interpretBookingExtract>>,
  userText: string
): void {
  if (extract.serviceId) session.draft.serviceId = extract.serviceId;
  if (extract.barberId) session.draft.barberId = extract.barberId;
  if (extract.dateId) session.draft.date = extract.dateId;
  if (extract.timeHint) session.draft.answers.__timeHint = extract.timeHint;
  applyScheduleFallbacks(shop, session, userText);
}

function notedPrefix(shop: Shop, session: Session): string {
  const bits: string[] = [];
  if (session.draft.barberId && session.draft.barberId !== "any") {
    const name = shop.config.barbers.find((b) => b.id === session.draft.barberId)?.name;
    if (name) bits.push(name);
  }
  if (session.draft.date) bits.push(session.draft.date);
  const hint = session.draft.answers.__timeHint;
  if (typeof hint === "string" && hint) bits.push(hint);
  if (!bits.length) return "";
  return `Noted ${bits.join(" · ")}. `;
}

function proceedBooking(shop: Shop, session: Session, channel: Channel): OrchestratorReply {
  if (!session.draft.serviceId) {
    session.step = "await_service";
    return {
      text: `${notedPrefix(shop, session)}Which service would you like?`,
      step: "await_service",
      choices: serviceChoices(shop),
      choiceMode: channel === "voice" ? "dtmf" : "list",
    };
  }
  if (shop.config.barbers.length > 0 && !session.draft.barberId) {
    session.step = "await_barber";
    return {
      text: `${notedPrefix(shop, session)}Any preferred barber?`,
      step: "await_barber",
      choices: barberChoices(shop),
      choiceMode: channel === "voice" ? "dtmf" : "list",
    };
  }
  if (!session.draft.date) {
    session.step = "await_date";
    return {
      text: `${notedPrefix(shop, session)}Which day works for you?`,
      step: "await_date",
      choices: upcomingDateChoices(shop.config),
      choiceMode: channel === "voice" ? "dtmf" : "list",
    };
  }
  const listed = stashAndListSlots(shop, session, session.draft.date, channel);
  const hint = session.draft.answers.__timeHint;
  delete session.draft.answers.__timeHint;
  if (typeof hint === "string" && /^\d{2}:\d{2}$/.test(hint) && listed.step === "await_time") {
    const [hh, mm] = hint.split(":").map(Number);
    if (Number.isInteger(hh) && Number.isInteger(mm)) {
      return retargetClock(shop, session, channel, hh, mm);
    }
  }
  return listed;
}

function bookingCapReply(channel: Channel, customerExternalId: string): OrchestratorReply {
  const n = countActiveBookings(customerExternalId);
  return {
    text: `This number already has ${n} upcoming booking${n === 1 ? "" : "s"} (max ${MAX_ACTIVE_BOOKINGS_PER_NUMBER}). Cancel one or wait until a visit is done, then you can book again.`,
    step: "await_intent",
    choices: intentChoices(),
    choiceMode: channel === "voice" ? "dtmf" : "buttons",
  };
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
    title: `${s.name} (${s.durationMinutes}m · ${money(s.priceCents, shop.config.currency || "USD")})`,
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
    `Service: ${service?.name}${service ? ` (${money(service.priceCents, shop.config.currency || "USD")})` : ""}`,
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
    const intentExact = matchChoice(text, intentChoices(), params.dtmf) || matchClosedKeywords(text, intentChoices());
    const dates = upcomingDateChoices(shop.config);
    const extract =
      intentExact && normalize(text).length <= 12
        ? {
            intent: "none" as const,
            serviceId: null,
            barberId: null,
            dateId: null,
            timeHint: null,
          }
        : await interpretBookingExtract({
            userText: text,
            today: formatDate(new Date()),
            services: shop.config.services.map((s) => ({ id: s.id, name: s.name })),
            barbers: shop.config.barbers,
            validDates: dates,
          });
    const intent =
      intentExact ||
      (extract.intent !== "none" ? extract.intent : null) ||
      (extract.barberId || extract.dateId || extract.timeHint ? "book" : null);
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
    if (atBookingCap(params.externalId)) {
      const reply = bookingCapReply(params.channel, params.externalId);
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    session.draft = emptyDraft();
    applyBookingExtract(shop, session, extract, text);
    const reply = proceedBooking(shop, session, params.channel);
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
    const reply = proceedBooking(shop, session, params.channel);
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
    const reply = proceedBooking(shop, session, params.channel);
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
    const reply = proceedBooking(shop, session, params.channel);
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
    if (matchChoice(text, [{ id: MORE_TIMES_ID, title: "More times" }], params.dtmf) === MORE_TIMES_ID) {
      session.draft.answers.__slotPage = String((Number(session.draft.answers.__slotPage) || 0) + 1);
      const dateId = session.draft.date;
      if (!dateId || !session.draft.serviceId) {
        session.step = "await_date";
        const reply: OrchestratorReply = {
          text: "Which day works for you?",
          step: "await_date",
          choices: upcomingDateChoices(shop.config),
          choiceMode: params.channel === "voice" ? "dtmf" : "list",
        };
        session.lastPrompt = reply.text;
        saveSession(session);
        return { reply, session, shop };
      }
      const reply = stashAndListSlots(shop, session, dateId, params.channel, false);
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    const picked = matchChoice(text, choices, params.dtmf);
    if (!picked) {
      const nudged = await applyBookingNudge(shop, session, params.channel, text);
      if (nudged === "cancel") {
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
      if (nudged && nudged !== "confirm") {
        session.lastPrompt = nudged.text;
        saveSession(session);
        return { reply: nudged, session, shop };
      }
      const dateId = session.draft.date;
      let reply: OrchestratorReply;
      if (dateId) {
        reply = stashAndListSlots(shop, session, dateId, params.channel, false);
        if (reply.step === "await_time") {
          reply = {
            ...reply,
            text: `Please pick a time, tap More times, or say who you want.\n\n${reply.text}`,
          };
        }
      } else {
        reply = {
          text: "Please pick a time from the list, or say who you want (for example a barber by name).",
          step: "await_time",
          choices,
          choiceMode: params.channel === "voice" ? "dtmf" : "list",
        };
      }
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    const line = slotLines[Number(picked) - 1];
    const [start, end, barberId] = line.split("|");
    const dateId = session.draft.date || formatDate(new Date(start));
    if (
      !session.draft.serviceId ||
      !slotStillOpen(shop, dateId, start, end, barberId || null, session.draft.serviceId)
    ) {
      const reply = slotTakenRefresh(shop, session, dateId, params.channel);
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
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
      const reply = slotTakenRefresh(shop, session, dateId, params.channel);
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
    const clock = parseClockHint(text);
    if (clock && session.draft.date && session.draft.serviceId) {
      const reply = retargetClock(shop, session, params.channel, clock.hours, clock.minutes);
      session.lastPrompt = reply.text;
      saveSession(session);
      return { reply, session, shop };
    }
    const decision = matchChoice(text, yesNo, params.dtmf) || matchClosedKeywords(text, yesNo);
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
      const nudged = await applyBookingNudge(shop, session, params.channel, text);
      if (nudged === "confirm") {
        /* fall through to confirmBooking below */
      } else if (nudged === "cancel") {
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
      } else if (nudged) {
        session.lastPrompt = nudged.text;
        saveSession(session);
        return { reply: nudged, session, shop };
      } else {
        const reply: OrchestratorReply = {
          text: "Tap Confirm or Cancel, or say who you want or a different time.",
          step: "await_confirm",
          choices: yesNo,
          choiceMode: params.channel === "voice" ? "dtmf" : "buttons",
        };
        session.lastPrompt = reply.text;
        saveSession(session);
        return { reply, session, shop };
      }
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
      if (atBookingCap(params.externalId)) {
        releaseSessionLocks(session.id);
        resetSession(session, shop.id);
        const reply = bookingCapReply(params.channel, params.externalId);
        session.lastPrompt = reply.text;
        saveSession(session);
        return { reply, session, shop };
      }
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
    } catch (err) {
      releaseSessionLocks(session.id);
      if (err instanceof Error && err.message === "Booking cap") {
        resetSession(session, shop.id);
        const reply = bookingCapReply(params.channel, params.externalId);
        session.lastPrompt = reply.text;
        saveSession(session);
        return { reply, session, shop };
      }
      const dateId = session.draft.date;
      if (dateId && session.draft.serviceId) {
        const reply = slotTakenRefresh(shop, session, dateId, params.channel);
        session.lastPrompt = reply.text;
        saveSession(session);
        return { reply, session, shop };
      }
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
