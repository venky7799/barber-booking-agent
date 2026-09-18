import type { OrchestratorReply } from "../types.js";

const GRAPH = "https://graph.facebook.com/v21.0";

function enabled(): boolean {
  return Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

async function sendPayload(payload: Record<string, unknown>): Promise<void> {
  if (!enabled()) {
    console.log("[whatsapp:dry-run]", JSON.stringify(payload));
    return;
  }
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("[whatsapp] send failed", res.status, body);
  }
}

export async function sendWhatsAppReply(to: string, reply: OrchestratorReply): Promise<void> {
  const toDigits = to.replace(/\D/g, "");

  if (reply.choices && reply.choices.length > 0 && reply.choices.length <= 3 && reply.choiceMode === "buttons") {
    await sendPayload({
      messaging_product: "whatsapp",
      to: toDigits,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: reply.text.slice(0, 1024) },
        action: {
          buttons: reply.choices.slice(0, 3).map((c) => ({
            type: "reply",
            reply: { id: c.id.slice(0, 256), title: c.title.slice(0, 20) },
          })),
        },
      },
    });
    return;
  }

  if (reply.choices && reply.choices.length > 0) {
    const rows = reply.choices.slice(0, 10).map((c) => ({
      id: c.id.slice(0, 200),
      title: c.title.slice(0, 24),
    }));
    await sendPayload({
      messaging_product: "whatsapp",
      to: toDigits,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: reply.text.slice(0, 1024) },
        action: {
          button: "Choose",
          sections: [{ title: "Options", rows }],
        },
      },
    });
    return;
  }

  await sendPayload({
    messaging_product: "whatsapp",
    to: toDigits,
    type: "text",
    text: { body: reply.text.slice(0, 4096) },
  });
}

export function extractWhatsAppInbound(body: unknown): Array<{
  from: string;
  to?: string;
  text: string;
  messageId: string;
}> {
  const out: Array<{ from: string; to?: string; text: string; messageId: string }> = [];
  const root = body as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          metadata?: { display_phone_number?: string; phone_number_id?: string };
          messages?: Array<{
            from: string;
            id: string;
            type: string;
            text?: { body?: string };
            interactive?: {
              button_reply?: { id?: string; title?: string };
              list_reply?: { id?: string; title?: string };
            };
            button?: { text?: string; payload?: string };
          }>;
        };
      }>;
    }>;
  };

  for (const entry of root.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;
      const to = value?.metadata?.display_phone_number;
      for (const msg of value?.messages || []) {
        let text = "";
        if (msg.type === "text") text = msg.text?.body || "";
        else if (msg.type === "interactive") {
          text =
            msg.interactive?.button_reply?.id ||
            msg.interactive?.list_reply?.id ||
            msg.interactive?.button_reply?.title ||
            msg.interactive?.list_reply?.title ||
            "";
        } else if (msg.type === "button") {
          text = msg.button?.payload || msg.button?.text || "";
        }
        if (!text) continue;
        out.push({ from: msg.from, to, text, messageId: msg.id });
      }
    }
  }
  return out;
}
