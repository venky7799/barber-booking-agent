import { v4 as uuid } from "uuid";
import { db } from "./db.js";
import { getShopById } from "./shops.js";
import type { Booking, Channel, Shop, ShopConfig, Slot, Weekday } from "./types.js";

const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Confirmed visits still in the future. Cancelled and past starts do not count. */
export const MAX_ACTIVE_BOOKINGS_PER_NUMBER = 4;

export function normalizeCustomerId(raw: string): string {
  return raw.replace(/\D/g, "") || raw.trim();
}

export function countActiveBookings(customerExternalId: string): number {
  const id = normalizeCustomerId(customerExternalId);
  const now = new Date().toISOString();
  const rows = db
    .prepare(`SELECT customer_external_id FROM bookings WHERE status = 'confirmed' AND starts_at > ?`)
    .all(now) as Array<{ customer_external_id: string }>;
  return rows.filter((r) => normalizeCustomerId(r.customer_external_id) === id).length;
}

export function atBookingCap(customerExternalId: string): boolean {
  return countActiveBookings(customerExternalId) >= MAX_ACTIVE_BOOKINGS_PER_NUMBER;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseLocalDateTime(date: string, time: string): Date {
  const [y, m, day] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y, m - 1, day, hh, mm, 0, 0);
}

function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

function weekdayKey(d: Date): Weekday {
  return WEEKDAYS[d.getDay()];
}

function purgeExpiredLocks(): void {
  db.prepare("DELETE FROM slot_locks WHERE expires_at < ?").run(new Date().toISOString());
}

function overlaps(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function busyIntervals(shopId: string, dayStart: string, dayEnd: string, barberId: string | null) {
  purgeExpiredLocks();
  const bookings = db
    .prepare(
      `SELECT starts_at, ends_at, barber_id FROM bookings
       WHERE shop_id = ? AND status = 'confirmed' AND starts_at < ? AND ends_at > ?`
    )
    .all(shopId, dayEnd, dayStart) as Array<{ starts_at: string; ends_at: string; barber_id: string | null }>;

  const locks = db
    .prepare(
      `SELECT starts_at, ends_at, barber_id FROM slot_locks
       WHERE shop_id = ? AND starts_at < ? AND ends_at > ? AND expires_at >= ?`
    )
    .all(shopId, dayEnd, dayStart, new Date().toISOString()) as Array<{
    starts_at: string;
    ends_at: string;
    barber_id: string | null;
  }>;

  return [...bookings, ...locks].filter((row) => {
    if (!barberId) return true;
    if (!row.barber_id) return true;
    return row.barber_id === barberId;
  });
}

export function getAvailableSlots(
  shop: Shop,
  date: string,
  serviceId: string,
  barberId: string | null = null
): Slot[] {
  const service = shop.config.services.find((s) => s.id === serviceId);
  if (!service) return [];

  const day = parseLocalDateTime(date, "00:00");
  const hours = shop.config.hours[weekdayKey(day)];
  if (!hours) return [];

  const open = parseLocalDateTime(date, hours.open);
  const close = parseLocalDateTime(date, hours.close);
  const now = new Date();
  const cutoff = addMinutes(now, shop.config.sameDayCutoffMinutes);
  const duration = service.durationMinutes + shop.config.bufferMinutes;

  const barbers =
    barberId
      ? shop.config.barbers.filter((b) => b.id === barberId)
      : shop.config.barbers.length
        ? shop.config.barbers
        : [{ id: "any", name: "Any" }];

  const slots: Slot[] = [];
  for (const barber of barbers) {
    const busy = busyIntervals(
      shop.id,
      open.toISOString(),
      close.toISOString(),
      barber.id === "any" ? null : barber.id
    );
    for (let cursor = open; addMinutes(cursor, service.durationMinutes) <= close; cursor = addMinutes(cursor, 15)) {
      const end = addMinutes(cursor, service.durationMinutes);
      const blockEnd = addMinutes(cursor, duration);
      if (cursor < cutoff) continue;
      const startIso = cursor.toISOString();
      const endIso = end.toISOString();
      const conflict = busy.some((b) => overlaps(startIso, blockEnd.toISOString(), b.starts_at, b.ends_at));
      if (conflict) continue;
      slots.push({
        start: startIso,
        end: endIso,
        barberId: barber.id === "any" ? null : barber.id,
        label: `${pad(cursor.getHours())}:${pad(cursor.getMinutes())}${
          barber.id === "any" ? "" : ` · ${barber.name}`
        }`,
      });
    }
  }

  return slots.slice(0, 80);
}

export function lockSlot(params: {
  shopId: string;
  sessionId: string;
  startsAt: string;
  endsAt: string;
  barberId: string | null;
  ttlMinutes?: number;
}): string {
  purgeExpiredLocks();
  const shop = getShopById(params.shopId);
  if (!shop) throw new Error("Shop not found");

  const busy = busyIntervals(params.shopId, params.startsAt, params.endsAt, params.barberId);
  if (busy.some((b) => overlaps(params.startsAt, params.endsAt, b.starts_at, b.ends_at))) {
    throw new Error("Slot unavailable");
  }

  // release prior locks for session
  db.prepare("DELETE FROM slot_locks WHERE session_id = ?").run(params.sessionId);

  const id = uuid();
  const now = new Date();
  const expires = addMinutes(now, params.ttlMinutes ?? 10);
  db.prepare(
    `INSERT INTO slot_locks (id, shop_id, barber_id, starts_at, ends_at, session_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.shopId,
    params.barberId,
    params.startsAt,
    params.endsAt,
    params.sessionId,
    expires.toISOString(),
    now.toISOString()
  );
  return id;
}

export function releaseSessionLocks(sessionId: string): void {
  db.prepare("DELETE FROM slot_locks WHERE session_id = ?").run(sessionId);
}

function makeReference(): string {
  return `BRB-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

export function confirmBooking(params: {
  shopId: string;
  sessionId: string;
  customerExternalId: string;
  channel: Channel;
  serviceId: string;
  barberId: string | null;
  startsAt: string;
  endsAt: string;
  answers: Record<string, string | string[]>;
}): Booking {
  purgeExpiredLocks();
  const busy = busyIntervals(params.shopId, params.startsAt, params.endsAt, params.barberId).filter(
    (b) => !("session_id" in b)
  );
  // re-check bookings only; locks for this session are ok
  const bookingConflicts = db
    .prepare(
      `SELECT starts_at, ends_at, barber_id FROM bookings
       WHERE shop_id = ? AND status = 'confirmed' AND starts_at < ? AND ends_at > ?`
    )
    .all(params.shopId, params.endsAt, params.startsAt) as Array<{
    starts_at: string;
    ends_at: string;
    barber_id: string | null;
  }>;

  const conflict = bookingConflicts.some((b) => {
    if (params.barberId && b.barber_id && b.barber_id !== params.barberId) return false;
    return overlaps(params.startsAt, params.endsAt, b.starts_at, b.ends_at);
  });
  if (conflict) throw new Error("Slot unavailable");

  const customerId = normalizeCustomerId(params.customerExternalId);
  if (atBookingCap(customerId)) {
    throw new Error("Booking cap");
  }

  const booking: Booking = {
    id: uuid(),
    shopId: params.shopId,
    reference: makeReference(),
    customerExternalId: customerId,
    channel: params.channel,
    serviceId: params.serviceId,
    barberId: params.barberId,
    startsAt: params.startsAt,
    endsAt: params.endsAt,
    answersJson: JSON.stringify(params.answers),
    status: "confirmed",
    createdAt: new Date().toISOString(),
  };

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO bookings
       (id, shop_id, reference, customer_external_id, channel, service_id, barber_id, starts_at, ends_at, answers_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      booking.id,
      booking.shopId,
      booking.reference,
      booking.customerExternalId,
      booking.channel,
      booking.serviceId,
      booking.barberId,
      booking.startsAt,
      booking.endsAt,
      booking.answersJson,
      booking.status,
      booking.createdAt
    );
    db.prepare("DELETE FROM slot_locks WHERE session_id = ?").run(params.sessionId);
  });
  tx();
  return booking;
}

export function cancelBooking(reference: string, customerExternalId: string): Booking | null {
  const id = normalizeCustomerId(customerExternalId);
  const row = db
    .prepare("SELECT * FROM bookings WHERE reference = ?")
    .get(reference) as
    | {
        id: string;
        shop_id: string;
        reference: string;
        customer_external_id: string;
        channel: Channel;
        service_id: string;
        barber_id: string | null;
        starts_at: string;
        ends_at: string;
        answers_json: string;
        status: "confirmed" | "cancelled";
        created_at: string;
      }
    | undefined;
  if (!row || normalizeCustomerId(row.customer_external_id) !== id) return null;
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(row.id);
  return {
    id: row.id,
    shopId: row.shop_id,
    reference: row.reference,
    customerExternalId: row.customer_external_id,
    channel: row.channel,
    serviceId: row.service_id,
    barberId: row.barber_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    answersJson: row.answers_json,
    status: "cancelled",
    createdAt: row.created_at,
  };
}

export function listBookings(shopId: string): Booking[] {
  const rows = db
    .prepare("SELECT * FROM bookings WHERE shop_id = ? ORDER BY starts_at DESC")
    .all(shopId) as Array<{
    id: string;
    shop_id: string;
    reference: string;
    customer_external_id: string;
    channel: Channel;
    service_id: string;
    barber_id: string | null;
    starts_at: string;
    ends_at: string;
    answers_json: string;
    status: "confirmed" | "cancelled";
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    shopId: row.shop_id,
    reference: row.reference,
    customerExternalId: row.customer_external_id,
    channel: row.channel,
    serviceId: row.service_id,
    barberId: row.barber_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    answersJson: row.answers_json,
    status: row.status,
    createdAt: row.created_at,
  }));
}

export function upcomingDateChoices(config: ShopConfig, days = 7): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = [];
  const now = new Date();
  for (let i = 0; i < 14 && out.length < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const key = weekdayKey(d);
    if (!config.hours[key]) continue;
    const id = formatDate(d);
    const title = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    out.push({ id, title });
  }
  return out;
}
