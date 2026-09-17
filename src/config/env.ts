import { z } from "zod";
import { recipientPattern } from '../modules/whatsapp/identity';

const schema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(20),
  META_APP_SECRET: z.string().min(16),
  WHATSAPP_VERIFY_TOKEN: z.string().min(16),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.0$/),
  WHATSAPP_ACCESS_TOKEN: z.string().min(20),
  WHATSAPP_TEST_PHONE_NUMBER_ID: z.string().regex(/^\d+$/),
  WHATSAPP_TEST_RECIPIENTS: z.string().transform(v => v.split(",").map(s => s.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(recipientPattern)).min(1)),
  WHATSAPP_MODE: z.literal("test"),
  CRON_SECRET: z.string().min(32),
});
export type Environment = z.infer<typeof schema>;
export function readEnvironment(source: Record<string, string | undefined> = process.env): Environment {
  const result = schema.safeParse(source);
  if (!result.success) {
    // Only names: Zod errors must never expose configuration values.
    throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join(".")).join(", ")}`);
  }
  return result.data;
}
