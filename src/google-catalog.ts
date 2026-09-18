import { google } from "googleapis";
import { googleAuth, parseSheetId } from "./google-sync.js";
import { createShop, getShopByCode, updateShop } from "./shops.js";
import type { ShopConfig, ShopQuestion, Weekday } from "./types.js";

const DAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const TAB = {
  shop: process.env.GOOGLE_TAB_SHOP || "Shop",
  services: process.env.GOOGLE_TAB_SERVICES || "Services",
  barbers: process.env.GOOGLE_TAB_BARBERS || "Barbers",
  hours: process.env.GOOGLE_TAB_HOURS || "Hours",
  questions: process.env.GOOGLE_TAB_QUESTIONS || "Questions",
};

function cell(row: string[] | undefined, i: number): string {
  return String(row?.[i] ?? "").trim();
}

function headerIndex(header: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  header.forEach((h, i) => {
    map[h.trim().toLowerCase().replace(/\s+/g, "")] = i;
  });
  return map;
}

function col(map: Record<string, number>, row: string[], ...names: string[]): string {
  for (const n of names) {
    const i = map[n.toLowerCase().replace(/\s+/g, "")];
    if (i !== undefined) return cell(row, i);
  }
  return "";
}

function priceToCents(raw: string, currency: string, headerHint: string): number {
  const n = Number(raw.replace(/[₹$,]/g, "").trim());
  if (!Number.isFinite(n) || n < 0) return 0;
  if (/cent|paise/i.test(headerHint)) return Math.round(n);
  return Math.round(n * 100);
}

function dayKey(raw: string): Weekday | null {
  const t = raw.trim().toLowerCase().slice(0, 3);
  return (DAYS as string[]).includes(t) ? (t as Weekday) : null;
}

async function values(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tab: string
): Promise<string[][]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tab}'!A1:Z100`,
  });
  return (res.data.values || []).map((row) => row.map((c) => String(c ?? "")));
}

async function ensureCatalogTabs(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string
): Promise<void> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const titles = new Set((meta.data.sheets || []).map((s) => s.properties?.title).filter(Boolean) as string[]);
  const add: string[] = [];
  for (const t of Object.values(TAB)) {
    if (!titles.has(t)) add.push(t);
  }
  if (add.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: add.map((title) => ({ addSheet: { properties: { title } } })),
      },
    });
  }

  const seed: Record<string, string[][]> = {
    [TAB.shop]: [
      ["key", "value"],
      ["name", "Fade Room"],
      ["code", "FADE01"],
      ["greeting", "Welcome to Fade Room — cuts, fades, and beards. Prices in rupees."],
      ["confirmation", "You are booked at Fade Room. See you soon!"],
      ["timezone", "Asia/Kolkata"],
      ["currency", "INR"],
      ["bufferMinutes", "5"],
      ["sameDayCutoffMinutes", "30"],
    ],
    [TAB.services]: [
      ["id", "name", "durationMinutes", "price"],
      ["haircut", "Haircut", "30", "350"],
      ["fade", "Skin Fade", "45", "500"],
      ["beard", "Beard Trim", "20", "200"],
    ],
    [TAB.barbers]: [
      ["id", "name"],
      ["rahul", "Rahul"],
      ["arjun", "Arjun"],
    ],
    [TAB.hours]: [
      ["day", "open", "close"],
      ["mon", "10:00", "20:00"],
      ["tue", "10:00", "20:00"],
      ["wed", "10:00", "20:00"],
      ["thu", "10:00", "20:00"],
      ["fri", "10:00", "21:00"],
      ["sat", "10:00", "21:00"],
      ["sun", "11:00", "18:00"],
    ],
    [TAB.questions]: [
      ["id", "prompt", "type", "options", "required"],
      ["fade_style", "What fade do you want?", "single_choice", "low, mid, high", "TRUE"],
      ["beard_add_on", "Add a beard lineup?", "yes_no", "", "TRUE"],
    ],
  };

  for (const title of add) {
    const rows = seed[title];
    if (!rows) continue;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${title}'!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });
    console.log(`[google] created catalog tab ${title}`);
  }
}

function parseShopTab(rows: string[][]): Record<string, string> {
  const out: Record<string, string> = {};
  if (rows.length < 2) return out;
  const h = headerIndex(rows[0] || []);
  const keyI = h.key ?? 0;
  const valI = h.value ?? 1;
  for (const row of rows.slice(1)) {
    const k = cell(row, keyI).toLowerCase();
    if (k) out[k] = cell(row, valI);
  }
  return out;
}

/** Pull shop menu from Google Sheets tabs. Not a Google Doc — Docs are unstructured. */
export async function syncShopCatalogFromGoogle(): Promise<boolean> {
  const spreadsheetId = parseSheetId(process.env.GOOGLE_SHEET_ID || "");
  const client = googleAuth();
  if (!spreadsheetId || !client) {
    console.log("[google] catalog skipped (need GOOGLE_SHEET_ID + credentials)");
    return false;
  }
  const sheets = google.sheets({ version: "v4", auth: client });
  await ensureCatalogTabs(sheets, spreadsheetId);

  const [shopRows, serviceRows, barberRows, hourRows, questionRows] = await Promise.all([
    values(sheets, spreadsheetId, TAB.shop),
    values(sheets, spreadsheetId, TAB.services),
    values(sheets, spreadsheetId, TAB.barbers),
    values(sheets, spreadsheetId, TAB.hours),
    values(sheets, spreadsheetId, TAB.questions),
  ]);

  const settings = parseShopTab(shopRows);
  const currency = (settings.currency || "INR").toUpperCase();
  const code = (settings.code || "FADE01").toUpperCase();

  const svcHeader = serviceRows[0] || [];
  const svcMap = headerIndex(svcHeader);
  const priceHeader = Object.keys(svcMap).find((k) => k.includes("price")) || "price";
  const services = serviceRows.slice(1).flatMap((row) => {
    const name = col(svcMap, row, "name", "service");
    if (!name) return [];
    const id = col(svcMap, row, "id") || name.toLowerCase().replace(/\s+/g, "_");
    const durationMinutes = Math.max(5, Number(col(svcMap, row, "durationminutes", "duration")) || 30);
    const priceRaw = col(svcMap, row, "pricecents", "priceinr", "price", "rupees");
    return [
      {
        id,
        name,
        durationMinutes,
        priceCents: priceToCents(priceRaw, currency, priceHeader),
      },
    ];
  });

  const barMap = headerIndex(barberRows[0] || []);
  const barbers = barberRows.slice(1).flatMap((row) => {
    const name = col(barMap, row, "name", "barber");
    if (!name) return [];
    const id = col(barMap, row, "id") || name.toLowerCase().replace(/\s+/g, "_");
    return [{ id, name }];
  });

  const hrMap = headerIndex(hourRows[0] || []);
  const hours: ShopConfig["hours"] = {};
  for (const row of hourRows.slice(1)) {
    const day = dayKey(col(hrMap, row, "day", "weekday"));
    const open = col(hrMap, row, "open", "start");
    const close = col(hrMap, row, "close", "end");
    if (day && /^\d{2}:\d{2}$/.test(open) && /^\d{2}:\d{2}$/.test(close)) {
      hours[day] = { open, close };
    }
  }

  const qMap = headerIndex(questionRows[0] || []);
  const questions: ShopQuestion[] = questionRows.slice(1).flatMap((row) => {
    const prompt = col(qMap, row, "prompt", "question");
    if (!prompt) return [];
    const id = col(qMap, row, "id") || prompt.toLowerCase().replace(/\s+/g, "_").slice(0, 32);
    const typeRaw = col(qMap, row, "type") || "short_text";
    const type = (["single_choice", "multi_choice", "yes_no", "short_text"].includes(typeRaw)
      ? typeRaw
      : "short_text") as ShopQuestion["type"];
    const options = col(qMap, row, "options")
      .split(/[,|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const required = !/^(false|0|no)$/i.test(col(qMap, row, "required") || "true");
    return [{ id, prompt, type, options: options.length ? options : undefined, required }];
  });

  if (!services.length) {
    console.warn("[google] catalog: Services tab is empty; leaving shop unchanged");
    return false;
  }

  const config: ShopConfig = {
    greeting: settings.greeting || "Welcome. Reply Book to start.",
    confirmation: settings.confirmation || "You're booked. See you soon!",
    timezone: settings.timezone || "Asia/Kolkata",
    currency,
    bufferMinutes: Number(settings.bufferminutes) || 0,
    sameDayCutoffMinutes: Number(settings.samedaycutoffminutes) || 30,
    services,
    barbers,
    hours,
    questions,
  };

  const name = settings.name || "Fade Room";
  const existing = getShopByCode(code);
  if (!existing) {
    createShop({ name, code, config });
    console.log(`[google] catalog created shop ${code}`);
  } else {
    updateShop(existing.id, { name, config });
    console.log(`[google] catalog updated ${code} (${services.length} services)`);
  }
  return true;
}

export function startCatalogPoll(): void {
  const sec = Number(process.env.GOOGLE_CATALOG_SYNC_SECONDS || 120);
  if (!sec || sec < 30) return;
  setInterval(() => {
    void syncShopCatalogFromGoogle().catch((err) =>
      console.error("[google] catalog poll failed", err instanceof Error ? err.message : err)
    );
  }, sec * 1000);
}
