# Deploy to Vercel

This repo is a **long-running Express server + SQLite (`better-sqlite3`)**. Vercel runs **serverless functions**. Pushing the project as-is will not work.

Use **Railway / Render / Fly / a VPS** instead ([DEPLOY.md](DEPLOY.md)). Follow this file only if you still want Vercel and are willing to change the app.

---

## Why a plain `vercel` deploy fails

| This project | Vercel |
|--------------|--------|
| `app.listen(PORT)` stays up | One request → one function → process may freeze |
| SQLite file on disk | Filesystem is **read-only** except `/tmp`; `/tmp` is wiped between instances |
| `better-sqlite3` (native C++) | Often **fails to build** or load on the serverless image |
| Sessions in SQLite | Two WhatsApp messages can hit **two different functions** → lost session |
| Seed shops in `index.ts` | Cold start may re-seed; no durable shop/booking store |

Do not import this GitHub repo into Vercel and expect WhatsApp to work without the work below.

---

## If you still want Vercel: required app changes

Do these **before** connecting the Vercel project.

1. **Replace SQLite** with a hosted database (Turso/libSQL, Neon Postgres, PlanetScale, etc.). Store sessions and bookings there.
2. **Export the Express `app`** from a module. Do not call `listen()` in the Vercel function. Example shape:

   ```ts
   // api/index.ts  (Vercel serverless entry)
   import app from "../src/app.js";
   export default app;
   ```

3. Move `migrate()` / seed so they do not run on every request, or make them idempotent against the hosted DB.
4. Add `vercel.json` to route all HTTP (including webhooks) to that function:

   ```json
   {
     "rewrites": [{ "source": "/(.*)", "destination": "/api" }]
   }
   ```

5. Set **Node 22** in Vercel → Project → Settings → General.

Until those land, skip the dashboard and use [DEPLOY.md](DEPLOY.md).

---

## Dashboard steps (after the app is Vercel-compatible)

### 1. Account and CLI (optional)

- Sign up at [vercel.com](https://vercel.com) with GitHub.
- Optional CLI:

```bash
npm i -g vercel
vercel login
```

### 2. Import the repo

1. Vercel → **Add New** → **Project**.
2. Import `venky7799/barber-booking-agent` (or your fork).
3. **Framework Preset:** Other.
4. **Root Directory:** `.` (repo root).
5. **Build Command:** `npm run build` (only if you compile `src` to `dist` and the function imports `dist`).
6. **Output Directory:** leave empty for a serverless Express wrapper (this is not a static site).
7. **Install Command:** `npm install`.

### 3. Environment variables

Vercel → Project → **Settings** → **Environment Variables**.

Add for **Production** (and Preview if you test webhooks on preview URLs):

| Name | Notes |
|------|--------|
| `PUBLIC_BASE_URL` | `https://your-project.vercel.app` (or custom domain), no trailing slash |
| `WHATSAPP_VERIFY_TOKEN` | Same as Meta webhook verify token |
| `WHATSAPP_ACCESS_TOKEN` | Prefer a long-lived system user token |
| `WHATSAPP_PHONE_NUMBER_ID` | |
| `WHATSAPP_APP_SECRET` | |
| `WHATSAPP_WABA_ID` | |
| `WHATSAPP_BUSINESS_NUMBER` | Digits only |
| `WHATSAPP_APP_ID` | |
| `TWILIO_*` | Optional |
| `LLM_*` | Optional |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON string — not a Mac file path |
| `GOOGLE_SHEET_ID` / `GOOGLE_SHEET_TAB` / `GOOGLE_CALENDAR_ID` | |
| DB URL | Whatever you use instead of SQLite |

Do **not** set `GOOGLE_APPLICATION_CREDENTIALS` to `/Users/...json`.

`PORT` is set by Vercel; you do not add it.

Redeploy after changing env vars: **Deployments** → ⋮ → **Redeploy**.

### 4. Deploy

- **Deploy** in the import wizard, or push to `main` if Git integration is on.
- Open `https://your-project.vercel.app/health` — it must return `{ "ok": true }`.

### 5. WhatsApp / Twilio

Same as [DEPLOY.md](DEPLOY.md):

- Meta callback: `https://your-project.vercel.app/webhooks/whatsapp`
- Verify token = `WHATSAPP_VERIFY_TOKEN`
- Subscribe **`messages`**
- `POST /{WABA_ID}/subscribed_apps`
- Twilio voice: `POST https://your-project.vercel.app/webhooks/voice`

Serverless **timeouts** (Hobby often ~10s) can kill slow Graph/Google/LLM calls.

### 6. Custom domain (optional)

Vercel → Project → **Settings** → **Domains** → add the domain → set `PUBLIC_BASE_URL` to `https://that-domain` → redeploy → update Meta/Twilio URLs.

---

## Checklist

- [ ] SQLite / `better-sqlite3` removed or replaced
- [ ] Express exported as a serverless handler (no `listen` on `127.0.0.1`)
- [ ] Env vars in Vercel, not only local `.env`
- [ ] `/health` works on the `.vercel.app` URL
- [ ] Meta webhook GET + POST work
- [ ] Timeouts acceptable for WhatsApp turns

If any of the first two boxes are unchecked, **do not use Vercel** for this project.
