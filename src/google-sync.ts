import { existsSync } from "node:fs";
import { google } from "googleapis";
import type { Booking, Shop } from "./types.js";

const SHEET_HEADERS = [
  "Reference",
  "Shop",
  "Service",
  "Barber",
  "Starts at",
  "Ends at",
  "Customer",
  "Channel",
  "Notes",
  "Status",
  "Created at",
];

export function parseSheetId(raw: string): string {
  const fromUrl = raw.trim().match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return fromUrl?.[1] || raw.trim();
}

export function parseCalendarId(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  try {
    const u = new URL(t);
    const cid = u.searchParams.get("cid");
    if (cid) {
      const decoded = decodeURIComponent(cid);
      if (decoded.includes("@")) return decoded;
      try {
        const fromB64 = Buffer.from(decoded, "base64").toString("utf8");
        if (fromB64.includes("@")) return fromB64;
      } catch {
        /* ignore */
      }
      return decoded;
    }
  } catch {
    /* not a URL */
  }
  if (/calendar\.google\.com/.test(t) && !t.includes("@")) return "";
  return t;
}

export function googleAuth() {
  return auth();
}

function jsonCredentials(): { private_key?: string; client_email?: string } | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw || !raw.startsWith("{")) return null;
  const parsed = JSON.parse(raw) as { private_key?: string; client_email?: string };
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}

function keyFilePath(): string | undefined {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (path && existsSync(path)) return path;
  return undefined;
}

function auth() {
  const creds = jsonCredentials();
  const keyFile = keyFilePath();
  if (!creds && !keyFile) {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
      console.warn(
        "[google] credential file is not on this host; set GOOGLE_SERVICE_ACCOUNT_JSON to the JSON contents"
      );
    }
    return null;
  }
  return new google.auth.GoogleAuth({
    ...(creds ? { credentials: creds } : { keyFile }),
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/calendar",
    ],
  });
}

function bookingLabels(shop: Shop, booking: Booking) {
  const service = shop.config.services.find((s) => s.id === booking.serviceId);
  const barber = shop.config.barbers.find((b) => b.id === booking.barberId);
  let notes = "";
  try {
    const answers = JSON.parse(booking.answersJson || "{}") as Record<string, unknown>;
    notes = Object.entries(answers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("; ");
  } catch {
    notes = booking.answersJson;
  }
  return {
    serviceName: service?.name || booking.serviceId,
    barberName: barber?.name || booking.barberId || "Any",
    notes,
  };
}

async function appendSheet(shop: Shop, booking: Booking): Promise<void> {
  const id = parseSheetId(process.env.GOOGLE_SHEET_ID || "");
  const client = auth();
  if (!id || !client) return;
  const tab = process.env.GOOGLE_SHEET_TAB || "Bookings";
  const sheets = google.sheets({ version: "v4", auth: client });
  const range = `${tab}!A1:K1`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range,
  });
  if (!existing.data.values?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [SHEET_HEADERS] },
    });
  }
  const { serviceName, barberName, notes } = bookingLabels(shop, booking);
  await sheets.spreadsheets.values.append({
    spreadsheetId: id,
    range: `${tab}!A:K`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [
        [
          booking.reference,
          shop.name,
          serviceName,
          barberName,
          booking.startsAt,
          booking.endsAt,
          booking.customerExternalId,
          booking.channel,
          notes,
          booking.status,
          booking.createdAt,
        ],
      ],
    },
  });
  console.log("[google] sheet row", booking.reference);
}

async function insertCalendar(shop: Shop, booking: Booking): Promise<void> {
  const id = parseCalendarId(process.env.GOOGLE_CALENDAR_ID || "");
  const client = auth();
  if (!id || !client) return;
  const { serviceName, barberName, notes } = bookingLabels(shop, booking);
  const tz = shop.config.timezone || "UTC";
  const calendar = google.calendar({ version: "v3", auth: client });
  await calendar.events.insert({
    calendarId: id,
    requestBody: {
      summary: `${shop.name}: ${serviceName} (${booking.reference})`,
      description: [`Barber: ${barberName}`, `Customer: ${booking.customerExternalId}`, notes && `Notes: ${notes}`]
        .filter(Boolean)
        .join("\n"),
      start: { dateTime: booking.startsAt, timeZone: tz },
      end: { dateTime: booking.endsAt, timeZone: tz },
    },
  });
  console.log("[google] calendar event", booking.reference);
}

/** Fire-and-forget: booking stays confirmed even if Google APIs fail. */
export async function syncBookingToGoogle(shop: Shop, booking: Booking): Promise<void> {
  const hasSheet = Boolean(parseSheetId(process.env.GOOGLE_SHEET_ID || ""));
  const hasCal = Boolean(parseCalendarId(process.env.GOOGLE_CALENDAR_ID || ""));
  if (!auth() || (!hasSheet && !hasCal)) {
    console.log("[google] skipped (set GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_SHEET_ID, GOOGLE_CALENDAR_ID)");
    return;
  }
  await Promise.all([
    appendSheet(shop, booking).catch((err) =>
      console.error("[google] sheets failed", err instanceof Error ? err.message : err)
    ),
    insertCalendar(shop, booking).catch((err) =>
      console.error("[google] calendar failed", err instanceof Error ? err.message : err)
    ),
  ]);
}
