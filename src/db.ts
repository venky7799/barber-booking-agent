import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv();

const dbPath = process.env.DATABASE_PATH || "./data/barber.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shops (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      whatsapp_number TEXT,
      twilio_number TEXT,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      shop_id TEXT,
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      step TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      last_prompt TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(channel, external_id),
      FOREIGN KEY (shop_id) REFERENCES shops(id)
    );

    CREATE TABLE IF NOT EXISTS slot_locks (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      barber_id TEXT,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      session_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (shop_id) REFERENCES shops(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      customer_external_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      service_id TEXT NOT NULL,
      barber_id TEXT,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (shop_id) REFERENCES shops(id)
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_shop_starts ON bookings(shop_id, starts_at);
    CREATE INDEX IF NOT EXISTS idx_locks_shop_starts ON slot_locks(shop_id, starts_at);
  `);
}
