import 'server-only';
import {OpenAiModerator} from '../moderation/provider';
import { readPilotConnection } from '@/config/whatsapp-connections';
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
  const connection=readPilotConnection();
  if(!connection)throw new Error('Pilot is not configured');
  const db=createAdminClient();
  const strategy = readAiMode() === 'ai'
    ? new GroundedStrategy(tenant => new KnowledgeRepository(db).forAssistant(tenant), new SupabaseUsageLedger(db), new OpenAiProvider(readAiKey()))
    : echoStrategy;
  const repository=new SupabaseMessagingRepository(db,connection.phoneNumberId,connection);
  return {connection,repository,sender:new MetaMessageSender(connection,fetch,reply=>repository.isAllowedIdentity(reply.recipient,[])),strategy,
    moderator:new OpenAiModerator(process.env.OPENAI_API_KEY,connection)};
}
