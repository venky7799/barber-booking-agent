import { migrate } from "./db.js";
import { createShop, getShopByCode, listShops } from "./shops.js";
import type { ShopConfig } from "./types.js";

const weekdayHours = {
  mon: { open: "09:00", close: "18:00" },
  tue: { open: "09:00", close: "18:00" },
  wed: { open: "09:00", close: "18:00" },
  thu: { open: "09:00", close: "19:00" },
  fri: { open: "09:00", close: "19:00" },
  sat: { open: "10:00", close: "16:00" },
};

const fadeRoomConfig: ShopConfig = {
  greeting: "Welcome to Fade Room — sharp cuts, fair prices.",
  confirmation: "You're booked at Fade Room. See you soon!",
  timezone: "America/New_York",
  bufferMinutes: 5,
  sameDayCutoffMinutes: 30,
  hours: weekdayHours,
  services: [
    { id: "haircut", name: "Haircut", durationMinutes: 30, priceCents: 2500 },
    { id: "fade", name: "Skin Fade", durationMinutes: 45, priceCents: 3500 },
    { id: "beard", name: "Beard Trim", durationMinutes: 20, priceCents: 1500 },
  ],
  barbers: [
    { id: "jay", name: "Jay" },
    { id: "omar", name: "Omar" },
  ],
  questions: [
    {
      id: "fade_style",
      prompt: "What fade do you want?",
      type: "single_choice",
      options: ["low", "mid", "high"],
      required: true,
    },
    {
      id: "beard_add_on",
      prompt: "Add a beard lineup?",
      type: "yes_no",
      required: true,
    },
  ],
};

const clipJointConfig: ShopConfig = {
  greeting: "Clip Joint here — walk-ins welcome, bookings preferred.",
  confirmation: "Clip Joint booking confirmed. Bring a photo of the style if you have one.",
  timezone: "America/Chicago",
  bufferMinutes: 0,
  sameDayCutoffMinutes: 45,
  hours: {
    ...weekdayHours,
    sun: { open: "11:00", close: "15:00" },
  },
  services: [
    { id: "classic", name: "Classic Cut", durationMinutes: 30, priceCents: 2200 },
    { id: "kids", name: "Kids Cut", durationMinutes: 25, priceCents: 1800 },
    { id: "shave", name: "Hot Towel Shave", durationMinutes: 40, priceCents: 4000 },
  ],
  barbers: [{ id: "mina", name: "Mina" }],
  questions: [
    {
      id: "hair_type",
      prompt: "What is your hair type?",
      type: "single_choice",
      options: ["straight", "wavy", "curly", "coily"],
      required: true,
    },
    {
      id: "allergies",
      prompt: "Any product allergies we should know?",
      type: "short_text",
      required: false,
    },
    {
      id: "style_notes",
      prompt: "Any style notes for your barber?",
      type: "short_text",
      required: false,
    },
  ],
};

export function seedDemoShops(): void {
  migrate();
  if (!getShopByCode("FADE01")) {
    createShop({
      name: "Fade Room",
      code: "FADE01",
      whatsappNumber: process.env.DEMO_FADE_WHATSAPP || null,
      twilioNumber: process.env.DEMO_FADE_TWILIO || null,
      config: fadeRoomConfig,
    });
  }
  if (!getShopByCode("CLIP02")) {
    createShop({
      name: "Clip Joint",
      code: "CLIP02",
      whatsappNumber: process.env.DEMO_CLIP_WHATSAPP || null,
      twilioNumber: process.env.DEMO_CLIP_TWILIO || null,
      config: clipJointConfig,
    });
  }
  console.log(
    `Seeded shops: ${listShops()
      .map((s) => `${s.name} (${s.code})`)
      .join(", ")}`
  );
}
