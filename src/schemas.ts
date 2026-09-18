import { z } from "zod";

export const questionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  type: z.enum(["single_choice", "multi_choice", "yes_no", "short_text"]),
  options: z.array(z.string().min(1)).optional(),
  required: z.boolean().default(true),
});

export const serviceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  durationMinutes: z.number().int().positive(),
  priceCents: z.number().int().nonnegative(),
});

export const barberSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const dayHoursSchema = z.object({
  open: z.string().regex(/^\d{2}:\d{2}$/),
  close: z.string().regex(/^\d{2}:\d{2}$/),
});

export const shopConfigSchema = z.object({
  greeting: z.string().min(1),
  confirmation: z.string().min(1),
  services: z.array(serviceSchema).min(1),
  barbers: z.array(barberSchema).default([]),
  hours: z
    .object({
      mon: dayHoursSchema.optional(),
      tue: dayHoursSchema.optional(),
      wed: dayHoursSchema.optional(),
      thu: dayHoursSchema.optional(),
      fri: dayHoursSchema.optional(),
      sat: dayHoursSchema.optional(),
      sun: dayHoursSchema.optional(),
    })
    .partial(),
  bufferMinutes: z.number().int().nonnegative().default(0),
  sameDayCutoffMinutes: z.number().int().nonnegative().default(60),
  questions: z.array(questionSchema).default([]),
  timezone: z.string().default("UTC"),
});

export const upsertShopSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(2).max(16),
  whatsappNumber: z.string().nullable().optional(),
  twilioNumber: z.string().nullable().optional(),
  config: shopConfigSchema,
});
