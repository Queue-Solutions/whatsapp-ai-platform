import { z } from "zod";
import type { DeliveryStatus, IncomingMessage } from "../messaging/types";

const timestamp = z.string().regex(/^\d{1,12}$/).refine(v => Number(v) <= 253402300799);
const message = z.object({
  id: z.string().min(1), from: z.string().regex(/^\d{7,15}$/), timestamp,
  type: z.string().min(1), text: z.object({ body: z.string().max(16384) }).optional(),
}).refine(v => v.type !== "text" || v.text !== undefined);
const payload = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.object({ changes: z.array(z.object({
    field: z.string(), value: z.object({
      metadata: z.object({ phone_number_id: z.string() }).optional(),
      contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).optional() })).optional(),
      messages: z.array(message).optional(),
      statuses: z.array(z.object({ id: z.string(), status: z.string(), timestamp,
        errors: z.array(z.object({ code: z.number() })).optional() })).optional(),
    }),
  })) })),
});
export function parseWebhook(input: unknown): { messages: IncomingMessage[]; statuses: DeliveryStatus[] } {
  const data = payload.parse(input);
  const messages: IncomingMessage[] = [];
  const statuses: DeliveryStatus[] = [];
  for (const entry of data.entry) for (const change of entry.changes) {
    if (change.field !== "messages") continue;
    const value = change.value;
    const phoneNumberId = value.metadata?.phone_number_id;
    if (!phoneNumberId && (value.messages?.length || value.statuses?.length)) throw new Error("Missing phone number ID");
    if (!phoneNumberId) continue;
    for (const m of value.messages ?? []) messages.push({
      phoneNumberId, providerMessageId: m.id, from: m.from,
      displayName: value.contacts?.find(c => c.wa_id === m.from)?.profile?.name,
      occurredAt: new Date(Number(m.timestamp) * 1000).toISOString(),
      type: m.type, text: m.type === "text" ? m.text!.body : null,
    });
    for (const s of value.statuses ?? []) {
      if (!["sent", "delivered", "read", "failed"].includes(s.status)) continue;
      statuses.push({phoneNumberId, providerMessageId: s.id,
        status: s.status as DeliveryStatus["status"], occurredAt: new Date(Number(s.timestamp) * 1000).toISOString(),
        errorCode: s.errors?.[0]?.code.toString()});
    }
  }
  return { messages, statuses };
}
