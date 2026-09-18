import express from "express";
import { config as loadEnv } from "dotenv";
import { migrate } from "./db.js";
import { seedDemoShops } from "./seed.js";
import { apiRouter } from "./routes.js";

loadEnv();
migrate();
seedDemoShops();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(apiRouter);

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>Barber Booking Agent</title>
<style>
  body{font-family:Georgia,serif;max-width:720px;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a;background:linear-gradient(#f7f3e0,#efe8dc)}
  code{background:#efe8dc;padding:.1rem .35rem}
  a{color:#0b5}
</style></head>
<body>
  <h1>Barber Booking Agent</h1>
  <p>Cost-optimized multi-shop booking over <strong>WhatsApp</strong> and <strong>phone calls</strong>.</p>
  <ul>
    <li><a href="/health">/health</a></li>
    <li><a href="/shops">/shops</a> — demo tenants with personalized questions</li>
    <li><a href="/simulate">/simulate</a> — local booking turns (GET in the browser, or POST JSON)</li>
    <li>WhatsApp webhook <code>/webhooks/whatsapp</code></li>
    <li><a href="/webhooks/voice">/webhooks/voice</a> — Twilio Voice (GET or POST TwiML)</li>
  </ul>
</body></html>`);
});

const port = Number(process.env.PORT || 3000);
app.listen(port, "127.0.0.1", () => {
  console.log(`Barber booking agent listening on http://localhost:${port}`);
});
