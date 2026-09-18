# Deploy this project online

If the app is on a host with a **public HTTPS URL**, you do **not** need Cloudflare, ngrok, or any local tunnel. The live URL replaces that.

Local `npm run dev` is still enough for `/simulate` and `demo:book`. Use this file only when you want WhatsApp or phone to hit a real server.

---

## 1. Pick a host

This is a long-running **Node + Express + SQLite** process (`npm run build` then `npm start`).

| Host | Fit |
|------|-----|
| Railway, Render, Fly.io, a VPS | Good. **$0 options:** **[FREE_DEPLOY.md](FREE_DEPLOY.md)** |
| **Vercel** | Poor — see **[VERCEL.md](VERCEL.md)**. Needs a rewrite (no SQLite, no `app.listen`). Prefer Railway/Render/Fly. |

Requirements:

- **Node 22+**
- Open **HTTP** on the platform `PORT` (do not hard-code 3000 only)

`src/index.ts` currently listens on `127.0.0.1`. On a cloud host that often blocks inbound traffic. Change the listen address to `0.0.0.0` (or `process.env.HOST`) before deploy:

```ts
app.listen(port, "0.0.0.0", () => { /* ... */ });
```

---

## 2. Set environment variables

Do **not** commit `.env` or upload it as a git file. In production the host injects variables; `dotenv` still reads them if the platform writes a `.env`, but the usual way is the dashboard.

### How to add them (by host)

**Railway** — Project → your service → **Variables** → **New variable** (or **Raw Editor** and paste `KEY=value` lines). Redeploy if it does not pick them up automatically.

**Render** — Dashboard → your Web Service → **Environment** → **Add Environment Variable**. Save; Render restarts the service.

**Fly.io**

```bash
fly secrets set WHATSAPP_ACCESS_TOKEN="..." PUBLIC_BASE_URL="https://your-app.fly.dev"
fly secrets list
```

**VPS (Ubuntu, etc.)** — either a systemd `Environment=` / `EnvironmentFile=/etc/barber.env` (file mode `600`), or export in the process manager (PM2 `ecosystem.config.cjs` `env: { ... }`). Restart the process after edits.

**Never** put production secrets in GitHub Actions logs, README, or a public repo. GitHub **Secrets** are only for CI; this app still needs the same keys on the **runtime** host.

Copy every value from `.env.example` into the host. Important ones:

```
PORT=                    # usually set by the platform
PUBLIC_BASE_URL=https://your-app.example.com
DATABASE_PATH=./data/barber.db

WHATSAPP_VERIFY_TOKEN=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_APP_SECRET=
WHATSAPP_WABA_ID=
WHATSAPP_BUSINESS_NUMBER=
WHATSAPP_APP_ID=

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

LLM_API_KEY=             # optional
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

GOOGLE_SERVICE_ACCOUNT_JSON=
GOOGLE_SHEET_ID=
GOOGLE_SHEET_TAB=Sheet1
GOOGLE_CALENDAR_ID=
```

`PUBLIC_BASE_URL` must be `https://...` with **no trailing slash**.

**Do not** point `GOOGLE_APPLICATION_CREDENTIALS` at a path on your Mac (`/Users/.../Downloads/...json`). That file is not on the server.

Use one of:

- Paste the JSON into `GOOGLE_SERVICE_ACCOUNT_JSON` (single line or as the host allows), or
- Upload the JSON on the host and set `GOOGLE_APPLICATION_CREDENTIALS` to **that** path.

Share the Google Sheet and Calendar with the **service account email** as Editor.

---

## 3. Build and start

Typical commands (match these in the host “build” / “start” fields):

```bash
npm install
npm run build
npm start
```

Start command must be `npm start` (compiled `dist/`), not `npm run dev`.

Confirm:

- `https://your-app.example.com/health` → `{ "ok": true }`
- `https://your-app.example.com/shops` lists FADE01 / CLIP02

---

## 4. Point webhooks at the live URL

**WhatsApp (Meta)**

- Callback: `https://your-app.example.com/webhooks/whatsapp`
- Verify token: same as `WHATSAPP_VERIFY_TOKEN`
- Subscribe webhook field **`messages`**

Or:

```bash
PUBLIC_BASE_URL=https://your-app.example.com npm run whatsapp:webhook
```

**Subscribe this app to the WABA** (required or chats go to another Meta app):

```bash
curl -X POST "https://graph.facebook.com/v21.0/YOUR_WABA_ID/subscribed_apps" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

GET the same URL and confirm **your** app name is in `data`.

**Twilio Voice** (optional)

- Voice webhook: `POST https://your-app.example.com/webhooks/voice`

Use a **system user** WhatsApp token in production. Short-lived tokens from API Setup expire and outbound messages fail with OAuth `#190`.

---

## 5. What you skip after deploy

- `cloudflared` / ngrok on your laptop
- Keeping `npm run dev` running locally for WhatsApp
- `localhost` as the Meta callback URL

---

## 6. SQLite on PaaS

Bookings are stored in `DATABASE_PATH` (default `./data/barber.db`).

On Railway / Render / Fly the disk is often **ephemeral**: a redeploy can wipe the database. For a demo that is acceptable. For real shops:

- attach a **persistent volume**, or
- move later to Postgres / another hosted DB

---

## 7. Checklist

- [ ] Host is Node 22, process listens on `0.0.0.0` + `PORT`
- [ ] `PUBLIC_BASE_URL` is the HTTPS origin
- [ ] All WhatsApp / Google / Twilio secrets are on the host, not only in local `.env`
- [ ] `/health` works on the public URL
- [ ] Meta webhook verifies (GET) and receives messages (POST)
- [ ] WABA `subscribed_apps` includes this app
- [ ] Sheet + calendar shared with the service account
- [ ] Volume or you accept SQLite reset on redeploy

---

## 8. Common problems

| Symptom | Likely cause |
|---------|----------------|
| App builds but URL times out | Still bound to `127.0.0.1` |
| Meta verify fails | Wrong verify token or URL path |
| Verify works, chats never arrive | Tunnel was never the issue — `messages` field or `subscribed_apps` |
| Google skipped / 403 | JSON not on the host, or sheet not shared with the SA email |
| Bookings vanish after deploy | Ephemeral disk / SQLite |
| Send fails `#190` | Access token expired |
