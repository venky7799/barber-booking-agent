# Shop content in Google (not in code)

Do **not** put services, prices, or barbers in `src/seed.ts` for production. Edit a **Google Spreadsheet**.

A **Google Doc** (File → New → Google Docs) is a Word-style page. This app cannot reliably read prices from paragraphs. Use **Google Sheets** (File → New → Google Sheets) in the same Google Drive. You still edit it in the browser; it is not code.

Bookings stay on tab `Sheet1` (or `GOOGLE_SHEET_TAB`). Catalog uses extra tabs in the **same** spreadsheet, already shared with the service account.

## Tabs

| Tab | Columns |
|-----|---------|
| **Shop** | `key`, `value` — `name`, `code`, `greeting`, `confirmation`, `timezone`, `currency` (`INR`), `bufferMinutes`, `sameDayCutoffMinutes` |
| **Services** | `id`, `name`, `durationMinutes`, `price` — for INR, `price` is **rupees** (350 = ₹350) |
| **Barbers** | `id`, `name` |
| **Hours** | `day` (`mon`…`sun`), `open`, `close` (`10:00`) |
| **Questions** | `id`, `prompt`, `type` (`single_choice` / `yes_no` / `short_text`), `options` (comma-separated), `required` |

If those tabs are missing, the app **creates them** on boot with an Indian Fade Room example.

## How it updates

- On each server start
- Every `GOOGLE_CATALOG_SYNC_SECONDS` (default 120)
- Immediately: `POST https://your-host/catalog/sync`

Change a price in the sheet, wait up to 2 minutes (or hit `/catalog/sync`), then send **Hi** on WhatsApp.

## Render

You already have `GOOGLE_SHEET_ID`. No extra env is required. After deploy, open the spreadsheet: you should see **Shop / Services / Barbers / Hours / Questions**. Edit there.
