import { getShopByCode, updateShop } from "./shops.js";

const GRAPH = "https://graph.facebook.com/v21.0";

function digits(value: string | undefined | null): string {
  return (value || "").replace(/\D/g, "");
}

export async function fetchWhatsAppDisplayNumber(): Promise<string | null> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return null;
  const res = await fetch(`${GRAPH}/${phoneId}?fields=display_phone_number`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error("[whatsapp] could not load display phone", res.status, await res.text());
    return null;
  }
  const data = (await res.json()) as { display_phone_number?: string };
  const n = digits(data.display_phone_number);
  return n || null;
}

/** Attach the Cloud API test/live number to Fade Room so inbound chats skip the shop code. */
export async function bindFadeRoomWhatsApp(): Promise<string | null> {
  const number =
    digits(process.env.WHATSAPP_BUSINESS_NUMBER) || (await fetchWhatsAppDisplayNumber());
  if (!number) {
    console.warn("[whatsapp] no business number to bind; set WHATSAPP_BUSINESS_NUMBER");
    return null;
  }
  const fade = getShopByCode("FADE01");
  if (!fade) return number;
  if (digits(fade.whatsappNumber) !== number) {
    updateShop(fade.id, { whatsappNumber: number });
    console.log(`[whatsapp] bound Fade Room (FADE01) to ${number}`);
  }
  return number;
}

async function appAccessToken(): Promise<string | null> {
  const secret = process.env.WHATSAPP_APP_SECRET;
  let appId = process.env.WHATSAPP_APP_ID || "";
  const userToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!appId && userToken) {
    const res = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(userToken)}&access_token=${encodeURIComponent(userToken)}`
    );
    if (res.ok) {
      const body = (await res.json()) as { data?: { app_id?: string } };
      appId = body.data?.app_id || "";
    }
  }
  if (!appId || !secret) return null;
  return `${appId}|${secret}`;
}

/** Point Meta webhooks at this host. callbackUrl must be public HTTPS. */
export async function registerWhatsAppWebhook(callbackUrl: string): Promise<boolean> {
  const verify = process.env.WHATSAPP_VERIFY_TOKEN;
  const appToken = await appAccessToken();
  if (!verify || !appToken) {
    console.warn("[whatsapp] webhook register skipped (need WHATSAPP_APP_SECRET + token)");
    return false;
  }
  const appId = appToken.split("|")[0];
  const params = new URLSearchParams({
    object: "whatsapp_business_account",
    callback_url: callbackUrl,
    fields: "messages",
    verify_token: verify,
    access_token: appToken,
  });
  const res = await fetch(`${GRAPH}/${appId}/subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("[whatsapp] webhook subscribe failed", res.status, text);
    return false;
  }
  console.log("[whatsapp] webhook subscribed", callbackUrl);
  return true;
}
