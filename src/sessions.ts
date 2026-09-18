import { v4 as uuid } from "uuid";
import { db } from "./db.js";
import type { BookingDraft, BookingStep, Channel, Session } from "./types.js";

function rowToSession(row: {
  id: string;
  shop_id: string | null;
  channel: Channel;
  external_id: string;
  step: BookingStep;
  draft_json: string;
  last_prompt: string | null;
  created_at: string;
  updated_at: string;
}): Session {
  return {
    id: row.id,
    shopId: row.shop_id,
    channel: row.channel,
    externalId: row.external_id,
    step: row.step,
    draft: JSON.parse(row.draft_json) as BookingDraft,
    lastPrompt: row.last_prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function emptyDraft(): BookingDraft {
  return { answers: {}, questionIndex: 0 };
}

export function getOrCreateSession(channel: Channel, externalId: string): Session {
  const existing = db
    .prepare("SELECT * FROM sessions WHERE channel = ? AND external_id = ?")
    .get(channel, externalId) as Parameters<typeof rowToSession>[0] | undefined;
  if (existing) return rowToSession(existing);

  const now = new Date().toISOString();
  const session: Session = {
    id: uuid(),
    shopId: null,
    channel,
    externalId,
    step: "idle",
    draft: emptyDraft(),
    lastPrompt: null,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO sessions (id, shop_id, channel, external_id, step, draft_json, last_prompt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.shopId,
    session.channel,
    session.externalId,
    session.step,
    JSON.stringify(session.draft),
    session.lastPrompt,
    session.createdAt,
    session.updatedAt
  );

  return session;
}

export function saveSession(session: Session): Session {
  const now = new Date().toISOString();
  session.updatedAt = now;
  db.prepare(
    `UPDATE sessions SET shop_id = ?, step = ?, draft_json = ?, last_prompt = ?, updated_at = ? WHERE id = ?`
  ).run(
    session.shopId,
    session.step,
    JSON.stringify(session.draft),
    session.lastPrompt,
    session.updatedAt,
    session.id
  );
  return session;
}

export function resetSession(session: Session, shopId: string | null = session.shopId): Session {
  session.shopId = shopId;
  session.step = shopId ? "await_intent" : "idle";
  session.draft = emptyDraft();
  session.lastPrompt = null;
  return saveSession(session);
}
