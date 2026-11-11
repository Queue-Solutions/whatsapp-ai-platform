import { WhatsAppOnboarding } from './ui';

export const dynamic = 'force-dynamic';

export default function WhatsAppOnboardingPage() {
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? '';
  const url = process.env.SUPABASE_URL ?? '';
  const appId = process.env.WHATSAPP_PILOT_APP_ID ?? '';
  const configurationId = process.env.WHATSAPP_PILOT_CONFIG_ID ?? '';
  const configured = key.startsWith('sb_publishable_') && /^https:\/\//.test(url);

  return <WhatsAppOnboarding
    authConfig={configured ? { url, key } : null}
    metaConfig={{ appId, configurationId }}
  />;
}
