# Barber Shop Booking Agent

**First time?** Follow **[HOW_TO_START.md](HOW_TO_START.md)** (install → local demo → WhatsApp → Google → Twilio).

**Going live?** Follow **[DEPLOY.md](DEPLOY.md)**. **Shop menu in Google Sheets** (not code): **[GOOGLE_CATALOG.md](GOOGLE_CATALOG.md)**. **Free hosts:** **[FREE_DEPLOY.md](FREE_DEPLOY.md)**. Vercel is **not** a drop-in host; see **[VERCEL.md](VERCEL.md)**.

Cost-optimized, multi-tenant booking agent for barber shops over **WhatsApp** and **phone calls**. Each shop configures its own services, staff, hours, and personalized intake questions — no code changes to onboard a new shop.

## Why it stays cheap

| Approach | Cost impact |
|---|---|
| Deterministic state machine for booking | Most turns = **0 LLM calls** |
| WhatsApp list/button replies + voice DTMF | Fewer misreads / retries |
| LLM only for fuzzy text (e.g. “Saturday afternoon”) | **0–2 calls** per booking when `LLM_API_KEY` is set |
| SQLite + single Node process | Low infra |
| Shared inbound number + shop code | Cheapest multi-shop onboarding |

## Quick start

```bash
cp .env.example .env
npm install
npm run seed
npm run dev
```

Open http://localhost:3000 — demo shops **Fade Room (`FADE01`)** and **Clip Joint (`CLIP02`)** are seeded with different questions.

### Simulate a booking (no Meta/Twilio needed)

```bash
# Start session / enter shop code
curl -s localhost:3000/simulate -H 'content-type: application/json' \
  -d '{"channel":"api","externalId":"cust1","text":"FADE01"}' | jq .

curl -s localhost:3000/simulate -H 'content-type: application/json' \
  -d '{"channel":"api","externalId":"cust1","text":"book"}' | jq .

# Then follow choices: service → barber → date → time → questions → yes
```

Or run the full happy-path script:

```bash
npm run demo:book
```

## Shop personalization API

```http
PUT /shops/:id/config
Content-Type: application/json
```

Config includes `services`, `barbers`, `hours`, `questions`, greetings, `timezone`, `currency` (`USD` / `INR`), buffers, and cutoff.

`priceCents` is the minor unit: **cents** for USD, **paise** for INR (₹350 → `35000`).

Existing shops do not pick up `src/seed.ts` changes. Update live config with `PUT /shops/:id/config` (see `GET /shops` for the id).

## Guardrails

- Customer identity is the **WhatsApp or call From number**. The bot never asks for a phone.
- That number is stored on the booking and in the Google Sheet **Customer** column.
- **At most 4 upcoming confirmed** bookings per number (across shops). Cancelled and completed visits do not count, so they can book again until they are back at 4.
- WhatsApp time lists follow the Google **Hours** tab and hide booked slots. If a time is taken mid-flow, the customer is asked to pick another remaining slot that day.

```http
POST /shops
GET  /shops
GET  /shops/:id
GET  /shops/:id/bookings
GET  /shops/:id/slots?date=YYYY-MM-DD&serviceId=haircut
PATCH /shops/:id
```

## WhatsApp setup (Meta Cloud API)

1. Create a Meta WhatsApp Business app and phone number.
2. Set env: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`.
3. Webhook URL: `https://<your-host>/webhooks/whatsapp`
4. Subscribe to `messages`.
5. Map the business number on a shop via `whatsappNumber`, **or** have customers send the shop code (e.g. `FADE01`).

Without credentials the agent logs outbound WhatsApp payloads as dry-runs.

## Phone calls (Twilio Voice)

1. Buy a Twilio number; set voice webhook to `POST https://<your-host>/webhooks/voice`.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`.
3. Map `twilioNumber` on a shop, **or** callers enter the shop code then `#`.

IVR uses **DTMF** for menus (cheap, reliable). Short-text questions use speech gather.

## Architecture

```
WhatsApp / Twilio Voice
        ↓
   Webhook gateway
        ↓
 Booking orchestrator (shared state machine)
        ↓
 Shop config · Slot engine · optional cheap LLM
        ↓
     Bookings DB (SQLite)
```

## Demo shops

| Code | Shop | Personalized questions |
|------|------|------------------------|
| `FADE01` | Fade Room | Fade style (low/mid/high), beard add-on |
| `CLIP02` | Clip Joint | Hair type, allergies, style notes |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start API with hot reload |
| `npm run start` | Run compiled server |
| `npm run seed` | Migrate + seed demo shops |
| `npm run demo:book` | End-to-end simulated booking |
| `npm run build` | Compile TypeScript |

## Env reference

See [`.env.example`](.env.example). `LLM_*` is optional — booking works without it using exact/list matching only.
