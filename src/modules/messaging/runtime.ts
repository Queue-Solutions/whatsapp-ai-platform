import 'server-only';
import { readEnvironment } from '@/config/env';
import { createAdminClient } from '@/lib/supabase/client';
import { SupabaseMessagingRepository } from './supabase-repository';
import { MetaMessageSender } from '../whatsapp/sender';
import { echoStrategy } from './echo-strategy';
export function createMessagingRuntime() {
  const env=readEnvironment();
  return {env,repository:new SupabaseMessagingRepository(createAdminClient(),env.WHATSAPP_TEST_PHONE_NUMBER_ID),
    sender:new MetaMessageSender(env),strategy:echoStrategy};
}
