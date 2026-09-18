# How to start this project (step by step)

This is a Node.js booking agent for barber shops. Customers book over **WhatsApp** or **phone**; you can also test in the browser without Meta or Twilio.

Demo shops:

- **Fade Room** — shop code `FADE01`
- **Clip Joint** — shop code `CLIP02`

---

## 1. Requirements

- **Node.js 22+** (this repo uses Node 22)
- npm (comes with Node)
- Optional later: Meta developer account, Twilio account, Google Cloud project, OpenAI key

Check:

```bash
node -v
```

---

## 2. Install

From the project folder:

```bash
cp .env.example .env
npm install
```

Edit `.env` only as you add WhatsApp / Google / Twilio. For a local demo, the defaults are enough (`PORT=3000`).

---

## 3. Start the server

```bash
npm run dev
```

Leave this terminal running. Open:

- http://localhost:3000 — home
- http://localhost:3000/health — `{ "ok": true }`
- http://localhost:3000/shops — demo shops
- http://localhost:3000/simulate — how to send a booking turn

Seeded shops appear automatically on first start.

---

## 4. Book without WhatsApp (recommended first)

### Option A — one command

```bash
npm run demo:book
```

You should see two confirmed references (e.g. `BRB-XXXXXX`).

### Option B — browser / curl

Use the **same** `externalId` for every step:

1. http://localhost:3000/simulate?externalId=user-1&text=FADE01  
2. Then `text=book`  
3. Then `1` (service) → `1` (barber) → `1` (day) → `1` (time) → answers → `yes`

Or:

```bash
curl -s localhost:3000/simulate -H 'content-type: application/json' \
  -d '{"externalId":"user-1","text":"FADE01"}'
```

---

## 5. Optional: LangChain (fuzzy text)

Buttons and numbers work **without** AI.

To map messy sentences (“hair cut please”) when matching fails:

1. Put an OpenAI key in `.env`: `LLM_API_KEY=sk-...`
2. Keep `LLM_MODEL=gpt-4o-mini`
3. Restart `npm run dev`

Greetings like `hi` do **not** call the model.

---

## 6. WhatsApp (Meta Cloud API)

The bot only replies if **Meta POSTs** inbound messages to your server. Sending from the API (outbound) is not enough.

### 6.1 Create the app

1. [Meta for Developers](https://developers.facebook.com/apps/) → Create app → add **WhatsApp**.
2. WhatsApp → **API Setup**: copy **Phone number ID** and a token into `.env`:

```
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=barber_verify_token
WHATSAPP_APP_SECRET=
WHATSAPP_WABA_ID=
WHATSAPP_BUSINESS_NUMBER=
```

`WHATSAPP_WABA_ID` is **WhatsApp Business Account ID** on API Setup (not the phone number ID).  
`WHATSAPP_BUSINESS_NUMBER` is digits of the test/live number (e.g. `15551629285`). Fade Room is bound to this number on startup.

3. Add your personal WhatsApp under **To** (test recipients) and complete the code.

### 6.2 Public HTTPS URL

Meta cannot call `localhost`. In a **second** terminal, tunnel port 3000, for example:

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

Copy the `https://...` URL. Keep this process running next to `npm run dev`.

Quick tunnels (Cloudflare / loca.lt / Pinggy) often **verify GET** but **drop POST**. If chats never reach the bot, use **ngrok** (logged in) or deploy the app (see **[DEPLOY.md](DEPLOY.md)**). Online deploy does **not** need Cloudflare.

### 6.3 Register the webhook

```bash
PUBLIC_BASE_URL=https://YOUR-PUBLIC-HOST npm run whatsapp:webhook
```

Or in Meta: **WhatsApp → Configuration**

- Callback: `https://YOUR-PUBLIC-HOST/webhooks/whatsapp`
- Verify token: same as `WHATSAPP_VERIFY_TOKEN`
- **Manage** webhook fields → subscribe **`messages`** (must be on)

### 6.4 Subscribe *this* app to the WABA (required)

If you skip this, Meta delivers real chats to another app (e.g. “WA DevX”) and your bot never sees Hi / Book.

```bash
curl -X POST "https://graph.facebook.com/v21.0/YOUR_WABA_ID/subscribed_apps" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

Confirm with GET on the same URL. Your app name (e.g. **barber**) must appear in `data`.

### 6.5 Test

1. Send Meta’s `hello_world` template once if needed.  
2. Message the **business test number** from your whitelisted phone.  
3. Send `Hi` → you should get Book / Cancel / Reschedule.  
4. Tap buttons (or type `1`, `2`, `3`).

Temporary tokens expire (~24 hours or less). Paste a new token into `.env` and restart `npm run dev` when sends fail with OAuth `#190`.

The bot uses the **sender WhatsApp number** as the customer id (never asks for it). **Max 4 upcoming confirmed** bookings per number; after one is cancelled or the appointment time has passed, they can book again.

---

## 7. Google Sheets + Google Calendar

When a booking is **confirmed**, the agent appends a Sheet row and creates a Calendar event. Booking still succeeds if Google is not configured.

1. Google Cloud project → enable **Sheets API** and **Calendar API**.  
2. Create a **service account** → download JSON key.  
3. Share the spreadsheet and calendar with the service account email as **Editor** (calendar: **Make changes to events**).  
4. In `.env`:

```
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
GOOGLE_SHEET_ID=the_id_from_the_spreadsheet_URL
GOOGLE_SHEET_TAB=Sheet1
GOOGLE_CALENDAR_ID=xxxx@group.calendar.google.com
```

Use the sheet ID from `/d/THIS_PART/edit`, not the full URL.  
Calendar ID is under Calendar settings → **Integrate calendar**, not `calendar.google.com/calendar/u/0/r`.

5. Check access:

```bash
npx tsx src/scripts/check-google.ts
```

You want `access_token ok`, `sheet_ok`, and `calendar_ok`. Then run `npm run demo:book` and refresh the sheet/calendar.

---

## 8. Phone calls (Twilio) — optional

1. Buy a number in Twilio.  
2. `.env`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`.  
3. Voice webhook: `POST https://YOUR-PUBLIC-HOST/webhooks/voice`.  
4. PATCH a shop with `"twilioNumber": "+1..."` or callers enter `FADE01` as digits then `#` (letter codes are awkward on a keypad).

Trial accounts: verify caller IDs and add credit.

---

## 9. What to keep running

| Process | Why |
|---------|-----|
| `npm run dev` | The booking API |
| HTTPS tunnel or deployed host | WhatsApp / Twilio webhooks |

If either stops, WhatsApp goes silent.

---

## 10. Common problems

| Symptom | Likely cause |
|---------|----------------|
| `Cannot GET /simulate` | Old server; GET is supported after restart |
| WhatsApp Hello World only, no bot | That template is from Meta, not this app |
| You send Hi / Book, no reply | No public URL, tunnel dropped POSTs, or WABA not subscribed to **this** app |
| Logs show only `GET /webhooks/whatsapp` | Handshake works; **messages** not subscribed / WABA `subscribed_apps` missing |
| `[google] skipped` | Credentials or IDs empty |
| Sheet `caller does not have permission` | Share the sheet with the service account email |
| Calendar homepage URL in `.env` | Replace with `...@group.calendar.google.com` |
| Send fails `#190` | Access token expired |

---

## Scripts

| Command | What it does |
|---------|----------------|
| `npm run dev` | Dev server (watch) |
| `npm run demo:book` | Simulated bookings for both demo shops |
| `npm run whatsapp:webhook` | Register Meta webhook using `PUBLIC_BASE_URL` |
| `npx tsx src/scripts/check-google.ts` | Test Sheets + Calendar auth |
| `npm run build` / `npm start` | Production compile + run |
