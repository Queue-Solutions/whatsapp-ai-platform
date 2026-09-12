import 'server-only';
import { readEnvironment } from '@/config/env';
import { createAdminClient } from '@/lib/supabase/client';
import { SupabaseMessagingRepository } from './supabase-repository';
import { MetaMessageSender } from '../whatsapp/sender';
import { echoStrategy } from './echo-strategy';
import { readAiKey, readAiMode } from '../ai/config';
import { OpenAiProvider } from '../ai/openai';
import { GroundedStrategy } from '../ai/grounded-strategy';
import { SupabaseUsageLedger } from '../ai/ledger';
import { KnowledgeRepository } from '../knowledge/repository';
export function createMessagingRuntime() {
  const env=readEnvironment();
  const db=createAdminClient();
  const strategy = readAiMode() === 'ai'
    ? new GroundedStrategy(tenant => new KnowledgeRepository(db).forAssistant(tenant), new SupabaseUsageLedger(db), new OpenAiProvider(readAiKey()))
    : echoStrategy;
  return {env,repository:new SupabaseMessagingRepository(db,env.WHATSAPP_TEST_PHONE_NUMBER_ID),
    sender:new MetaMessageSender(env),strategy};
}
