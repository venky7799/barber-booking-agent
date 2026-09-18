# Deploy this project for free

WhatsApp needs a **public HTTPS URL** that is reachable whenever someone messages the shop. “Free” hosts often **sleep** or wipe the disk. Pick a path below that matches how reliable you need the bot to be.

This app is **not** a good free Vercel deploy. See [VERCEL.md](VERCEL.md).

**One code change on any host:** in `src/index.ts`, listen on `0.0.0.0`, not `127.0.0.1`, or the public URL will time out.

```ts
app.listen(port, "0.0.0.0", () => { /* ... */ });
```

Also set `PUBLIC_BASE_URL=https://your-free-url` (no trailing slash).

---

## What is actually free

| Piece | Free? |
|-------|--------|
| This Node app | Yes |
| Meta WhatsApp Cloud API (test number) | Yes |
| Google Sheets + Calendar (service account) | Yes (API quota) |
| Hosting | Yes, with limits (below) |
| OpenAI / LangChain | **No** — leave `LLM_API_KEY` empty; buttons still work |
| Twilio phone number | Usually **no** (trial credit, then paid) |

---

## Option A — Render free Web Service (easiest)

Good for a **demo**. The free instance **spins down after ~15 minutes** of no traffic. The next WhatsApp message can fail or wait 30–60s while Render wakes the app. Meta may not retry.

1. Push this repo to GitHub (already: `venky7799/barber-booking-agent`).
2. Sign up at [render.com](https://render.com) with GitHub (free).
3. **New** → **Web Service** → select the repo.
4. Settings:
   - **Runtime:** Node
   - **Build:** `npm install && npm run build` (required — `dist/` is not in git)
   - **Start:** `npm start`
   - **Instance:** Free
5. **Environment** → add the same keys as `.env.example` (see [DEPLOY.md](DEPLOY.md)). Do not use Mac file paths for Google JSON; paste `GOOGLE_SERVICE_ACCOUNT_JSON`.
6. Deploy. Open `https://YOUR-SERVICE.onrender.com/health`.
7. Meta webhook: `https://YOUR-SERVICE.onrender.com/webhooks/whatsapp`  
   Then WABA `subscribed_apps` (same as [HOW_TO_START.md](HOW_TO_START.md)).

SQLite on Render Free is **lost on most deploys**. Fine for testing; not for real shops.

---

## Option B — Always-on free VM (best free WhatsApp)

A small **always-free VPS** (for example Oracle Cloud “Always Free” ARM, or a tiny Fly.io machine if you still have free allowance) stays up, so WhatsApp POSTs do not hit a cold start.

Rough steps (Ubuntu):

```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

git clone https://github.com/venky7799/barber-booking-agent.git
cd barber-booking-agent
nano .env          # paste secrets; PUBLIC_BASE_URL=https://your-domain-or-ip
npm install
npm run build
```

Keep it running (example):

```bash
sudo npm i -g pm2
pm2 start dist/index.js --name barber
pm2 save && pm2 startup
```

Put **Caddy** or **nginx + Let’s Encrypt** in front so you have HTTPS. Point Meta at `https://your-domain/webhooks/whatsapp`.

SQLite on the VM disk survives restarts if you do not delete the folder. Snapshot the VM if you care about data.

---

## Option C — Your laptop (free, not “deployed”)

```bash
npm run dev
```

Second terminal: Cloudflare / ngrok / Pinggy tunnel to port 3000. Laptop must stay open. Free Pinggy dies after **60 minutes**. This is a local demo, not production. See [HOW_TO_START.md](HOW_TO_START.md).

---

## After the URL is live (all options)

1. Confirm `GET https://YOUR-URL/health` → `{"ok":true}`
2. Set Meta callback + verify token + **`messages`**
3. `POST /{WABA_ID}/subscribed_apps`
4. Message the WhatsApp test number (`Hi` → Book / Cancel / Reschedule)

Env vars: host dashboard (Render) or `.env` on the VM — never commit secrets. Details: [DEPLOY.md](DEPLOY.md) section 2.

---

## Recommendation

- **Try WhatsApp this weekend, no card:** Render Free, accept sleep + empty DB after redeploy.
- **Bot should answer all day for $0:** always-on free VM (Option B), not Vercel, not a sleeping Render box.
- **Need phone calls:** Twilio is the part that usually costs money; skip it on a free setup.
