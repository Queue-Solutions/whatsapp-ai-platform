import 'server-only';
import {OpenAiModerator} from '../moderation/provider';
import { readEnvironment } from '@/config/env';
import { readPilotConnection, testConnection } from '@/config/whatsapp-connections';
import { createAdminClient } from '@/lib/supabase/client';
import { SupabaseMessagingRepository } from './supabase-repository';
import { MetaMessageSender } from '../whatsapp/sender';
import { echoStrategy } from './echo-strategy';
import { readAiKey, readAiMode } from '../ai/config';
import { OpenAiProvider } from '../ai/openai';
import { GroundedStrategy } from '../ai/grounded-strategy';
import { SupabaseUsageLedger } from '../ai/ledger';
import { KnowledgeRepository } from '../knowledge/repository';
export function createMessagingRuntime(channel: 'test' | 'pilot' = 'test') {
  const env=readEnvironment();
  const connection=channel==='test'?testConnection(env):readPilotConnection();
  if(!connection)throw new Error('Pilot is not configured');
  const db=createAdminClient();
  const strategy = readAiMode() === 'ai'
    ? new GroundedStrategy(tenant => new KnowledgeRepository(db).forAssistant(tenant), new SupabaseUsageLedger(db), new OpenAiProvider(readAiKey()))
    : echoStrategy;
  return {env,connection,repository:new SupabaseMessagingRepository(db,connection.phoneNumberId,connection.mode==='pilot'?connection:undefined),
    sender:new MetaMessageSender(connection),strategy,moderator:new OpenAiModerator(process.env.OPENAI_API_KEY,connection)};
}
