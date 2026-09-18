export type QuestionType = "single_choice" | "multi_choice" | "yes_no" | "short_text";

export interface ShopQuestion {
  id: string;
  prompt: string;
  type: QuestionType;
  options?: string[];
  required: boolean;
}

export interface ShopService {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
}

export interface Barber {
  id: string;
  name: string;
}

export interface DayHours {
  open: string; // "09:00"
  close: string; // "18:00"
}

export type Weekday =
  | "mon"
  | "tue"
  | "wed"
  | "thu"
  | "fri"
  | "sat"
  | "sun";

export interface ShopConfig {
  greeting: string;
  confirmation: string;
  services: ShopService[];
  barbers: Barber[];
  hours: Partial<Record<Weekday, DayHours>>;
  bufferMinutes: number;
  sameDayCutoffMinutes: number;
  questions: ShopQuestion[];
  timezone: string;
  /** ISO 4217. priceCents is paise for INR, cents for USD. */
  currency: string;
}

export interface Shop {
  id: string;
  name: string;
  code: string;
  whatsappNumber: string | null;
  twilioNumber: string | null;
  config: ShopConfig;
  createdAt: string;
  updatedAt: string;
}

export type BookingStep =
  | "idle"
  | "await_intent"
  | "await_shop_code"
  | "await_service"
  | "await_barber"
  | "await_date"
  | "await_time"
  | "await_question"
  | "await_confirm"
  | "completed"
  | "cancelled";

export type Channel = "whatsapp" | "voice" | "api";

export interface BookingDraft {
  serviceId?: string;
  barberId?: string;
  date?: string; // YYYY-MM-DD
  time?: string; // HH:MM
  answers: Record<string, string | string[]>;
  questionIndex: number;
  lockId?: string;
}

export interface Session {
  id: string;
  shopId: string | null;
  channel: Channel;
  externalId: string;
  step: BookingStep;
  draft: BookingDraft;
  lastPrompt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Booking {
  id: string;
  shopId: string;
  reference: string;
  customerExternalId: string;
  channel: Channel;
  serviceId: string;
  barberId: string | null;
  startsAt: string;
  endsAt: string;
  answersJson: string;
  status: "confirmed" | "cancelled";
  createdAt: string;
}

export interface Slot {
  start: string; // ISO
  end: string;
  barberId: string | null;
  label: string;
}

export interface OrchestratorReply {
  text: string;
  step: BookingStep;
  choices?: Array<{ id: string; title: string }>;
  choiceMode?: "buttons" | "list" | "dtmf";
  endSession?: boolean;
  bookingReference?: string;
  gatherSpeech?: boolean;
}
