import { Router, type Request, type Response } from "express";
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

const simulateSchema = z.object({
  channel: z.enum(["whatsapp", "voice", "api"]).default("api"),
  externalId: z.string().min(3),
  text: z.string().default(""),
  dtmf: z.string().optional(),
  toNumber: z.string().optional(),
});

async function runSimulate(req: Request, res: Response) {
  const raw = {
    ...(req.query && typeof req.query === "object" ? req.query : {}),
    ...(req.body && typeof req.body === "object" ? req.body : {}),
  };
  try {
    const body = simulateSchema.parse(raw);
    const result = await handleTurn(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Bad request" });
  }
}

/** Browser GET or POST JSON — booking turns without WhatsApp/Twilio. */
apiRouter.get("/simulate", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  if (!q.externalId && !q.text) {
    return res.json({
      ok: true,
      method: "GET or POST",
      usage: {
        POST: { externalId: "user-1", text: "FADE01", channel: "api" },
        GET: "/simulate?externalId=user-1&text=FADE01",
      },
      next: "Open /simulate?externalId=user-1&text=FADE01 then send book, 1, 1, … in later requests with the same externalId.",
    });
  }
  return runSimulate(req, res);
});

apiRouter.post("/simulate", async (req, res) => {
  await runSimulate(req, res);
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

// --- Twilio Voice (POST is the default; GET works in the browser and if the number is set to GET) ---
async function handleVoiceWebhook(req: Request, res: Response) {
  const src = {
    ...(typeof req.query === "object" && req.query ? req.query : {}),
    ...(typeof req.body === "object" && req.body ? req.body : {}),
  } as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = src[k];
      if (v != null && String(v).length) return String(v);
    }
    return "";
  };
  const from = pick("From", "from") || "unknown";
  const to = pick("To", "to");
  const digits = pick("Digits", "digits") || undefined;
  const speech = pick("SpeechResult", "speechResult");
  const text = speech || digits || "";

  const { reply } = await handleTurn({
    channel: "voice",
    externalId: from,
    text,
    dtmf: digits,
    toNumber: to,
  });

  const twiml = buildVoiceTwimlSafe(reply, "/webhooks/voice");
  res.type("text/xml").send(twiml);
}

apiRouter.get("/webhooks/voice", handleVoiceWebhook);
apiRouter.post("/webhooks/voice", handleVoiceWebhook);
