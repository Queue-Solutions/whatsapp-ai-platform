import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentDecision } from './contracts';
import { AI_MODEL, PROMPT_VERSION } from './config';
export type Reservation = { status: 'new'|'reserved'|'completed'|'failed'|'budget_exhausted'; id?: string; errorCode?:string; decision?: AgentDecision };
export interface UsageLedger {
  reserve(tenant: string, key: string, purpose: 'whatsapp'|'acceptance'): Promise<Reservation>;
  finish(tenant: string, id: string, result: {
    state: 'completed'|'failed'; input: number|null; output: number|null;
    latency: number; decision: AgentDecision|null; error: string|null;
  }): Promise<void>;
}
export class SupabaseUsageLedger implements UsageLedger {
  constructor(private db: SupabaseClient) {}
  async reserve(tenant: string, key: string, purpose: 'whatsapp'|'acceptance') {
    const { data, error } = await this.db.rpc('reserve_ai_request', { p_tenant: tenant, p_key: key, p_purpose: purpose, p_model: AI_MODEL, p_prompt: PROMPT_VERSION });
    if (error) throw new Error('AI budget unavailable');
    const reservation=data as Reservation;
    if(reservation.status==='failed'&&reservation.id){
      const result=await this.db.from('ai_requests').select('error_code').eq('tenant_id',tenant).eq('id',reservation.id).single();
      if(result.error)throw new Error('AI recovery state unavailable');
      reservation.errorCode=result.data.error_code??undefined;
    }
    return reservation;
  }
  async finish(tenant: string, id: string, result: Parameters<UsageLedger['finish']>[2]) {
    const { error } = await this.db.rpc('finish_ai_request', { p_tenant: tenant, p_id: id, p_state: result.state,
      p_input: result.input, p_output: result.output, p_latency: result.latency, p_decision: result.decision, p_error: result.error });
    if (error) throw new Error('AI usage commit unavailable');
  }
}
