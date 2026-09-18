/**
 * End-to-end simulated booking (in-process, no HTTP server required).
 * Usage: npx tsx src/scripts/demo-book.ts
 */
import { migrate } from "../db.js";
import { seedDemoShops } from "../seed.js";
import { handleTurn } from "../orchestrator.js";
import { listShops } from "../shops.js";
import { listBookings } from "../slots.js";

async function turn(externalId: string, text: string, dtmf?: string) {
  const result = await handleTurn({
    channel: "api",
    externalId,
    text,
    dtmf,
  });
  console.log(`\n> ${text || `(dtmf ${dtmf})`}`);
  console.log(`< [${result.reply.step}] ${result.reply.text}`);
  if (result.reply.choices?.length) {
    console.log(
      "  choices:",
      result.reply.choices.map((c, i) => `${i + 1}:${c.title}`).join(" | ")
    );
  }
  return result;
}

async function main() {
  migrate();
  seedDemoShops();
  const shopList = listShops();
  console.log(
    "Shops:",
    shopList.map((s) => `${s.code} questions=${s.config.questions.map((q) => q.id).join(",")}`)
  );

  const id = `demo-${Date.now()}`;
  await turn(id, "FADE01");
  await turn(id, "book");
  await turn(id, "1"); // haircut
  await turn(id, "1"); // any barber
  await turn(id, "1"); // date
  await turn(id, "1"); // time
  await turn(id, "mid");
  await turn(id, "yes");
  const done = await turn(id, "yes");

  if (!done.reply.bookingReference) {
    console.error("Booking failed — no reference returned");
    process.exit(1);
  }
  const fade = shopList.find((s) => s.code === "FADE01")!;
  console.log("\nBookings:", listBookings(fade.id));

  const id2 = `demo2-${Date.now()}`;
  await turn(id2, "CLIP02");
  await turn(id2, "book");
  await turn(id2, "1");
  await turn(id2, "1");
  await turn(id2, "1");
  await turn(id2, "1");
  await turn(id2, "curly");
  await turn(id2, "none");
  await turn(id2, "keep length on top");
  const done2 = await turn(id2, "yes");
  if (!done2.reply.bookingReference) {
    console.error("Clip Joint booking failed");
    process.exit(1);
  }
  console.log("\nDemo bookings completed successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
