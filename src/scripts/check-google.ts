import { config } from "dotenv";
import { google } from "googleapis";
import { readFileSync } from "fs";

config();

async function main() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile) throw new Error("GOOGLE_APPLICATION_CREDENTIALS missing");
  const json = JSON.parse(readFileSync(keyFile, "utf8")) as { client_email: string; project_id: string };
  console.log("email", json.client_email);
  console.log("project", json.project_id);

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/calendar",
    ],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  console.log("access_token", token?.token ? "ok" : "FAIL");

  const sheets = google.sheets({ version: "v4", auth });
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      fields: "properties.title,sheets.properties.title",
    });
    console.log(
      "sheet_ok",
      meta.data.properties?.title,
      "tabs",
      meta.data.sheets?.map((s) => s.properties?.title)
    );
  } catch (e) {
    const err = e as { errors?: Array<{ message?: string }>; message?: string };
    console.log("sheet_fail", err.errors?.[0]?.message || err.message);
  }

  const calendar = google.calendar({ version: "v3", auth });
  try {
    const list = await calendar.calendarList.list();
    const items = list.data.items || [];
    console.log(
      "calendars",
      items.length ? items.map((i) => ({ id: i.id, summary: i.summary })) : "calendarList empty (normal for service accounts)"
    );
    const { parseCalendarId } = await import("../google-sync.js");
    const calId = parseCalendarId(process.env.GOOGLE_CALENDAR_ID || "");
    console.log("parsed_calendar_id", calId || "(none)");
    if (calId) {
      try {
        const cal = await calendar.calendars.get({ calendarId: calId });
        console.log("calendar_ok", cal.data.summary, cal.data.id);
      } catch (e) {
        const err = e as { errors?: Array<{ message?: string }>; message?: string };
        console.log("calendar_get_fail", err.errors?.[0]?.message || err.message);
      }
    }
  } catch (e) {
    const err = e as { errors?: Array<{ message?: string }>; message?: string };
    console.log("calendar_list_fail", err.errors?.[0]?.message || err.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
