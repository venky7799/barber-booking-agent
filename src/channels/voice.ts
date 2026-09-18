import twilio from "twilio";
import type { OrchestratorReply } from "../types.js";

const VoiceResponse = twilio.twiml.VoiceResponse;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function speakableChoices(reply: OrchestratorReply): string {
  if (!reply.choices?.length) return "";
  return reply.choices
    .map((c, i) => `Press ${i + 1} for ${c.title}.`)
    .join(" ");
}

/**
 * Build TwiML for the next booking turn.
 * Uses DTMF for choices; Gather speech for short_text questions.
 */
export function buildVoiceTwiml(reply: OrchestratorReply, actionPath: string): string {
  const vr = new VoiceResponse();
  const spoken = `${reply.text} ${speakableChoices(reply)}`.trim();

  if (reply.endSession && !reply.choices?.length) {
    vr.say({ voice: "Polly.Joanna" }, spoken);
    vr.hangup();
    return vr.toString();
  }

  if (reply.gatherSpeech) {
    const gather = vr.gather({
      input: ["speech"],
      action: actionPath,
      method: "POST",
      timeout: 5,
      speechTimeout: "auto",
    });
    gather.say({ voice: "Polly.Joanna" }, spoken);
    vr.say({ voice: "Polly.Joanna" }, "I did not catch that.");
    vr.redirect({ method: "POST" }, actionPath);
    return vr.toString();
  }

  const gather = vr.gather({
    input: ["dtmf"],
    numDigits: reply.step === "await_shop_code" ? 6 : 1,
    action: actionPath,
    method: "POST",
    timeout: 8,
    finishOnKey: reply.step === "await_shop_code" ? "#" : undefined,
  });
  gather.say({ voice: "Polly.Joanna" }, spoken);

  vr.say({ voice: "Polly.Joanna" }, "Sorry, I did not get any input.");
  vr.redirect({ method: "POST" }, actionPath);
  return vr.toString();
}

/** Fallback plain builder without twilio SDK types quirks */
export function buildVoiceTwimlSafe(reply: OrchestratorReply, actionPath: string): string {
  try {
    return buildVoiceTwiml(reply, actionPath);
  } catch {
    const choices = speakableChoices(reply);
    const say = escapeXml(`${reply.text} ${choices}`.trim());
    if (reply.endSession) {
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">${say}</Say><Hangup/></Response>`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="dtmf" numDigits="1" action="${escapeXml(
      actionPath
    )}" method="POST" timeout="8"><Say voice="Polly.Joanna">${say}</Say></Gather><Redirect method="POST">${escapeXml(
      actionPath
    )}</Redirect></Response>`;
  }
}
