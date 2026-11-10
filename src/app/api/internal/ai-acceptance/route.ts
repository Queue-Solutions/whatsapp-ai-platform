import { createAdminClient } from '@/lib/supabase/client';
import { readAiKey } from '@/modules/ai/config';
import { OpenAiProvider } from '@/modules/ai/openai';
import { SupabaseUsageLedger } from '@/modules/ai/ledger';
import { GroundedStrategy } from '@/modules/ai/grounded-strategy';
import { handleAcceptance } from '@/modules/ai/acceptance-handler';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function POST(request: Request) {
  return handleAcceptance(request, {
    secret: process.env.CRON_SECRET,
    enabled: process.env.AI_ACCEPTANCE_ENABLED === 'true',
    async resolveTenant() {
      const { data, error } = await createAdminClient().from('whatsapp_channels').select('tenant_id')
        .eq('mode','pilot').eq('dashboard_active',true).eq('enabled',true).single();
      if (error || !data) throw new Error('Company channel unavailable'); return data.tenant_id;
    },
    async run(context,sources) {
      return new GroundedStrategy(async () => sources, new SupabaseUsageLedger(createAdminClient()), new OpenAiProvider(readAiKey()), 'acceptance').reply(context);
    },
  });
}
