import { z } from 'zod';
import type { Environment } from './env';
import { recipientPattern } from '../modules/whatsapp/identity';

export type WhatsAppConnection = {
  mode: 'test' | 'pilot';
  phoneNumberId: string;
  tenantId?: string;
  appId?: string;
  appSecret: string;
  verifyToken: string;
  accessToken: string;
  graphVersion: string;
  recipients: string[];
  sendEnabled: boolean;
};

export function testConnection(env: Environment): WhatsAppConnection {
  return {
    mode: env.WHATSAPP_MODE,
    phoneNumberId: env.WHATSAPP_TEST_PHONE_NUMBER_ID,
    appSecret: env.META_APP_SECRET,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    graphVersion: env.META_GRAPH_API_VERSION,
    recipients: env.WHATSAPP_TEST_RECIPIENTS,
    sendEnabled: env.WHATSAPP_MODE === 'test',
  };
}

export function asConnection(input: Environment | WhatsAppConnection): WhatsAppConnection {
  return 'phoneNumberId' in input ? input : testConnection(input);
}

const enabledSchema = z.enum(['false', 'true']).default('false');
const verifyTokenSchema = z.string().min(16);
const pilotSchema = z.object({
  WHATSAPP_PILOT_TENANT_ID: z.uuid(),
  WHATSAPP_PILOT_APP_ID: z.string().regex(/^\d+$/),
  WHATSAPP_PILOT_PHONE_NUMBER_ID: z.string().regex(/^\d+$/),
  WHATSAPP_PILOT_APP_SECRET: z.string().min(16),
  WHATSAPP_PILOT_VERIFY_TOKEN: verifyTokenSchema,
  WHATSAPP_PILOT_ACCESS_TOKEN: z.string().min(20),
  WHATSAPP_PILOT_GRAPH_API_VERSION: z.string().regex(/^v\d+\.0$/),
  WHATSAPP_PILOT_RECIPIENTS: z.string().transform(value => value.split(',').map(v => v.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(recipientPattern)).min(1)),
  WHATSAPP_PILOT_SEND_ENABLED: enabledSchema,
});

/** Webhook verification is safe while the pilot remains disabled; POST still uses the full gated connection. */
export function readPilotVerifyToken(source: Record<string, string | undefined> = process.env): string {
  const result = verifyTokenSchema.safeParse(source.WHATSAPP_PILOT_VERIFY_TOKEN);
  if (!result.success) throw new Error('Invalid configuration: WHATSAPP_PILOT_VERIFY_TOKEN');
  return result.data;
}

/** Separate opt-in: the original test configuration is never repurposed for a real number. */
export function readPilotConnection(source: Record<string, string | undefined> = process.env): WhatsAppConnection | null {
  const enabled = enabledSchema.safeParse(source.WHATSAPP_PILOT_ENABLED);
  if (!enabled.success) throw new Error('Invalid configuration: WHATSAPP_PILOT_ENABLED');
  if (enabled.data === 'false') return null;
  const result = pilotSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  }
  const config = result.data;
  if (config.WHATSAPP_PILOT_PHONE_NUMBER_ID === source.WHATSAPP_TEST_PHONE_NUMBER_ID) {
    throw new Error('Pilot and test channels must be different');
  }
  return {
    mode: 'pilot', tenantId: config.WHATSAPP_PILOT_TENANT_ID,
    appId: config.WHATSAPP_PILOT_APP_ID, phoneNumberId: config.WHATSAPP_PILOT_PHONE_NUMBER_ID,
    appSecret: config.WHATSAPP_PILOT_APP_SECRET, verifyToken: config.WHATSAPP_PILOT_VERIFY_TOKEN,
    accessToken: config.WHATSAPP_PILOT_ACCESS_TOKEN, graphVersion: config.WHATSAPP_PILOT_GRAPH_API_VERSION,
    recipients: config.WHATSAPP_PILOT_RECIPIENTS, sendEnabled: config.WHATSAPP_PILOT_SEND_ENABLED === 'true',
  };
}

/** Input is a database-resolved channel, never a tenant/phone supplied by a browser or webhook. */
export function connectionForChannel(connections: WhatsAppConnection[], channel: {
  tenant_id: string; phone_number_id: string; mode: string;
}): WhatsAppConnection | null {
  return connections.find(connection => connection.mode === channel.mode && connection.phoneNumberId === channel.phone_number_id
    && (connection.mode === 'test' || connection.tenantId === channel.tenant_id)) ?? null;
}
