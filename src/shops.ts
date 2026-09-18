import { v4 as uuid } from "uuid";
import { db } from "./db.js";
import type { Shop, ShopConfig } from "./types.js";
import { shopConfigSchema, upsertShopSchema } from "./schemas.js";
import { z } from "zod";

function rowToShop(row: {
  id: string;
  name: string;
  code: string;
  whatsapp_number: string | null;
  twilio_number: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
}): Shop {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    whatsappNumber: row.whatsapp_number,
    twilioNumber: row.twilio_number,
    config: JSON.parse(row.config_json) as ShopConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listShops(): Shop[] {
  const rows = db.prepare("SELECT * FROM shops ORDER BY name").all() as Array<Parameters<typeof rowToShop>[0]>;
  return rows.map(rowToShop);
}

export function getShopById(id: string): Shop | null {
  const row = db.prepare("SELECT * FROM shops WHERE id = ?").get(id) as Parameters<typeof rowToShop>[0] | undefined;
  return row ? rowToShop(row) : null;
}

export function getShopByCode(code: string): Shop | null {
  const row = db
    .prepare("SELECT * FROM shops WHERE lower(code) = lower(?)")
    .get(code) as Parameters<typeof rowToShop>[0] | undefined;
  return row ? rowToShop(row) : null;
}

export function getShopByWhatsappNumber(number: string): Shop | null {
  const normalized = number.replace(/\D/g, "");
  const rows = listShops();
  return (
    rows.find((s) => s.whatsappNumber && s.whatsappNumber.replace(/\D/g, "") === normalized) || null
  );
}

export function getShopByTwilioNumber(number: string): Shop | null {
  const normalized = number.replace(/\D/g, "");
  const rows = listShops();
  return (
    rows.find((s) => s.twilioNumber && s.twilioNumber.replace(/\D/g, "") === normalized) || null
  );
}

export function createShop(input: z.infer<typeof upsertShopSchema>): Shop {
  const parsed = upsertShopSchema.parse(input);
  const now = new Date().toISOString();
  const shop: Shop = {
    id: uuid(),
    name: parsed.name,
    code: parsed.code.toUpperCase(),
    whatsappNumber: parsed.whatsappNumber ?? null,
    twilioNumber: parsed.twilioNumber ?? null,
    config: shopConfigSchema.parse(parsed.config),
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO shops (id, name, code, whatsapp_number, twilio_number, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    shop.id,
    shop.name,
    shop.code,
    shop.whatsappNumber,
    shop.twilioNumber,
    JSON.stringify(shop.config),
    shop.createdAt,
    shop.updatedAt
  );

  return shop;
}

export function updateShopConfig(id: string, config: ShopConfig): Shop {
  const shop = getShopById(id);
  if (!shop) throw new Error("Shop not found");
  const parsed = shopConfigSchema.parse(config);
  const now = new Date().toISOString();
  db.prepare("UPDATE shops SET config_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(parsed),
    now,
    id
  );
  return getShopById(id)!;
}

export function updateShop(
  id: string,
  patch: Partial<Pick<Shop, "name" | "code" | "whatsappNumber" | "twilioNumber">> & {
    config?: ShopConfig;
  }
): Shop {
  const shop = getShopById(id);
  if (!shop) throw new Error("Shop not found");
  const now = new Date().toISOString();
  const next = {
    name: patch.name ?? shop.name,
    code: (patch.code ?? shop.code).toUpperCase(),
    whatsappNumber: patch.whatsappNumber === undefined ? shop.whatsappNumber : patch.whatsappNumber,
    twilioNumber: patch.twilioNumber === undefined ? shop.twilioNumber : patch.twilioNumber,
    config: patch.config ? shopConfigSchema.parse(patch.config) : shop.config,
  };
  db.prepare(
    `UPDATE shops SET name = ?, code = ?, whatsapp_number = ?, twilio_number = ?, config_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    next.name,
    next.code,
    next.whatsappNumber,
    next.twilioNumber,
    JSON.stringify(next.config),
    now,
    id
  );
  return getShopById(id)!;
}
