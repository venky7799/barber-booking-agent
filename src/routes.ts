import { Router } from "express";
import { z } from "zod";
import {
  createShop,
  getShopById,
  listShops,
  updateShop,
  updateShopConfig,
} from "./shops.js";
import { shopConfigSchema, upsertShopSchema } from "./schemas.js";
import { listBookings, getAvailableSlots, upcomingDateChoices } from "./slots.js";
import { handleTurn } from "./orchestrator.js";
import { extractWhatsAppInbound, sendWhatsAppReply } from "./channels/whatsapp.js";
import { buildVoiceTwimlSafe } from "./channels/voice.js";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({ ok: true, service: "barber-booking-agent" });
});

apiRouter.get("/shops", (_req, res) => {
  res.json({ shops: listShops() });
});

apiRouter.get("/shops/:id", (req, res) => {
  const shop = getShopById(req.params.id);
  if (!shop) return res.status(404).json({ error: "Not found" });
  return res.json({ shop });
});

apiRouter.post("/shops", (req, res) => {
  try {
    const shop = createShop(upsertShopSchema.parse(req.body));
    res.status(201).json({ shop });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid payload" });
  }
});

apiRouter.put("/shops/:id/config", (req, res) => {
  try {
    const config = shopConfigSchema.parse(req.body);
    const shop = updateShopConfig(req.params.id, config);
    res.json({ shop });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid config" });
  }
});

apiRouter.patch("/shops/:id", (req, res) => {
  try {
    const shop = updateShop(req.params.id, req.body);
    res.json({ shop });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid patch" });
  }
});

apiRouter.get("/shops/:id/bookings", (req, res) => {
  const shop = getShopById(req.params.id);
  if (!shop) return res.status(404).json({ error: "Not found" });
  return res.json({ bookings: listBookings(shop.id) });
});

apiRouter.get("/shops/:id/slots", (req, res) => {
  const shop = getShopById(req.params.id);
  if (!shop) return res.status(404).json({ error: "Not found" });
  const date = String(req.query.date || "");
  const serviceId = String(req.query.serviceId || shop.config.services[0]?.id || "");
  const barberId = req.query.barberId ? String(req.query.barberId) : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date=YYYY-MM-DD required" });
  }
  return res.json({
    dates: upcomingDateChoices(shop.config),
    slots: getAvailableSlots(shop, date, serviceId, barberId),
  });
});

/** Simulate a booking turn without WhatsApp/Twilio (great for local testing). */
apiRouter.post("/simulate", async (req, res) => {
  const schema = z.object({
    channel: z.enum(["whatsapp", "voice", "api"]).default("api"),
    externalId: z.string().min(3),
    text: z.string().default(""),
    dtmf: z.string().optional(),
    toNumber: z.string().optional(),
  });
  try {
    const body = schema.parse(req.body);
    const result = await handleTurn(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Bad request" });
  }
});

// --- WhatsApp webhooks ---
apiRouter.get("/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(String(challenge || ""));
  }
  return res.sendStatus(403);
});

apiRouter.post("/webhooks/whatsapp", async (req, res) => {
  res.sendStatus(200);
  const messages = extractWhatsAppInbound(req.body);
  for (const msg of messages) {
    try {
      const { reply } = await handleTurn({
        channel: "whatsapp",
        externalId: msg.from,
        text: msg.text,
        toNumber: msg.to,
      });
      await sendWhatsAppReply(msg.from, reply);
    } catch (err) {
      console.error("[whatsapp] turn failed", err);
    }
  }
});

// --- Twilio Voice ---
apiRouter.post("/webhooks/voice", async (req, res) => {
  const from = String(req.body.From || "unknown");
  const to = String(req.body.To || "");
  const digits = req.body.Digits ? String(req.body.Digits) : undefined;
  const speech = req.body.SpeechResult ? String(req.body.SpeechResult) : "";
  const text = speech || digits || "";

  // First ring with empty body → greeting
  const { reply } = await handleTurn({
    channel: "voice",
    externalId: from,
    text,
    dtmf: digits,
    toNumber: to,
  });

  const twiml = buildVoiceTwimlSafe(reply, "/webhooks/voice");
  res.type("text/xml").send(twiml);
});
