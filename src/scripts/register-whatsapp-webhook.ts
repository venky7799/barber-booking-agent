/**
 * Register Meta WhatsApp webhook for a public HTTPS base URL.
 * Usage: PUBLIC_BASE_URL=https://your-host npx tsx src/scripts/register-whatsapp-webhook.ts
 */
import { config as loadEnv } from "dotenv";
import { registerWhatsAppWebhook } from "../whatsapp-bind.js";

loadEnv();

const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
if (!base.startsWith("https://")) {
  console.error("Set PUBLIC_BASE_URL to a public https:// URL (tunnel or deployed host).");
  process.exit(1);
}

const ok = await registerWhatsAppWebhook(`${base}/webhooks/whatsapp`);
process.exit(ok ? 0 : 1);
