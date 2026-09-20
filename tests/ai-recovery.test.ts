import {describe,it,expect,vi} from 'vitest';
import {GroundedStrategy} from '../src/modules/ai/grounded-strategy';
import {ModelFailure} from '../src/modules/ai/openai';
import {productIntent} from '../src/modules/ai/branch-dialogue';
import {SupabaseMessagingRepository} from '../src/modules/messaging/supabase-repository';
import {processIncomingMessage} from '../src/modules/messaging/process-incoming-message';
import {SendError} from '../src/modules/whatsapp/sender';
import {AI_RECOVERY_SUMMARY} from '../src/modules/ai/recovery';
import {attentionReason} from '../src/modules/admin/inbox';
import type {Reservation,UsageLedger} from '../src/modules/ai/ledger';
import type {KnowledgeSource} from '../src/modules/ai/contracts';
import type {MessageContext,MessagingRepository,MessageJob} from '../src/modules/messaging/types';
import type {SupabaseClient} from '@supabase/supabase-js';
const context:MessageContext={tenantId:'tenant',conversationId:'conversation',type:'text',text:'What payment methods do you accept?',requestKey:'message:one',eligible:true};
const source:KnowledgeSource={id:'faq',kind:'faq',label:'K1',updatedAt:'2026-09-20',content:JSON.stringify({question:'Payment methods?',answer:'Cash or card.'})};
const result=()=>({decision:{action:'answer' as const,text:'Cash or card.',sourceLabels:['K1']},input:100,output:20});
function ledger(){
 const saved=new Map<string,Reservation>();
 return {saved,reserve:vi.fn(async(tenant:string,key:string)=>{
  const id=`${tenant}:${key}`;const existing=saved.get(id);if(existing)return existing;
  saved.set(id,{status:'reserved',id});return {status:'new' as const,id};
 }),finish:vi.fn(async(_tenant:string,id:string,value:Parameters<UsageLedger['finish']>[2])=>{saved.set(id,{id,status:value.state,decision:value.decision??undefined,errorCode:value.error??undefined});})};
}
describe('BTC context from the screenshot',()=>{
 const btc={...source,content:JSON.stringify({question:'BTC services?',answer:'Riverside: 01200000001\nBTC working hours: Daily from 12:00 PM to 8:30 PM, except Friday from 2:00 PM to 8:30 PM.'})};
 const branch:KnowledgeSource={id:'branch',label:'B1',kind:'fact',updatedAt:'2026-09-20',content:JSON.stringify({category:'branch',value:{name:'Riverside',city:'Cairo',address:'123 Street',hours:'9am–10pm'}})};
 it.each(['سبايك','السبايك','سبائك','السبائك','سبيكة','BTC','bullion'])('retains %s as BTC when the customer subsequently asks for branches',async product=>{
  const c={...context,text:'ايه الفروع ؟',history:[{role:'user' as const,content:product},{role:'assistant' as const,content:'لو حابب أعرفك على أقرب فرع لخدمة سبائك الذهب، ممكن تقول لي مكانك؟'}]};
  expect(productIntent(c)).toBe('btc');
  const complete=vi.fn(async()=>({decision:{action:'answer' as const,text:'مواعيد خدمة السبائك من ١٢ ظهرًا لحد ٨:٣٠ مساءً، والجمعة من ٢ لحد ٨:٣٠ مساءً.',branchLines:['Riverside — Cairo'],sourceLabels:['K1']},input:100,output:80}));
  const decision=await new GroundedStrategy(async()=>[btc,branch],ledger(),{complete}).reply(c);
  expect(decision.action).toBe('answer');expect(decision.text).toContain('لو بتسأل على السبائك، فدي الفروع المتاحة');expect(decision.text).not.toMatch(/المجوهرات ولا|123 Street|9am/);expect(complete).not.toHaveBeenCalled();
 });
});
describe('bounded and silent model recovery',()=>{
 it.each(['openai_incomplete','openai_network_unknown','openai_http_429','openai_http_503','openai_invalid_decision'])('recovers %s under a separate stable reservation and reuses the recovered answer on replay',async code=>{
  const usage=ledger();const complete=vi.fn().mockRejectedValueOnce(new ModelFailure(code,{input:300,output:650})).mockResolvedValue(result());
  const strategy=new GroundedStrategy(async()=>[source],usage,{complete});
  expect((await strategy.reply(context)).text).toBe('Cash or card.');expect((await strategy.reply(context)).text).toBe('Cash or card.');expect(complete).toHaveBeenCalledTimes(2);
  expect(usage.saved.size).toBe(2);expect(usage.reserve).toHaveBeenCalledWith('tenant','message:one:recovery:1','whatsapp');
  expect(usage.finish.mock.calls[0][2]).toMatchObject({state:'failed',input:300,output:650});
  const recovery=JSON.parse(complete.mock.calls[1][0]);expect(recovery.instructions).toContain('final internal recovery attempt');expect(recovery.text.format.schema.properties.text.maxLength).toBe(450);
 });
 it('reprocesses a rejected citation without ever returning its unsupported answer',async()=>{
  const usage=ledger(),complete=vi.fn().mockResolvedValueOnce({...result(),decision:{...result().decision,text:'Invented answer.',sourceLabels:['other-tenant']}}).mockResolvedValue(result());
  const decision=await new GroundedStrategy(async()=>[source],usage,{complete}).reply(context);
  expect(decision.text).toBe('Cash or card.');expect(usage.finish).toHaveBeenCalledTimes(2);
 });
 it('retries a temporary source-load failure without making an unreserved model call',async()=>{
  const load=vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue([source]),usage=ledger(),complete=vi.fn(async()=>result());
  expect((await new GroundedStrategy(load,usage,{complete}).reply(context)).action).toBe('answer');
  expect(load).toHaveBeenCalledTimes(2);expect(complete).toHaveBeenCalledOnce();expect(usage.reserve).toHaveBeenCalledOnce();
 });
 it('stops after two failures and never sends technical prose, including on replay',async()=>{
  const usage=ledger(),complete=vi.fn().mockRejectedValue(new ModelFailure('openai_network_unknown'));
  const strategy=new GroundedStrategy(async()=>[source],usage,{complete});
  for(let i=0;i<3;i++)expect(await strategy.reply(context)).toMatchObject({action:'suppress',text:'',reason:'openai_network_unknown'});
  expect(complete).toHaveBeenCalledTimes(2);expect(usage.finish.mock.calls.every(c=>c[2].input===null&&c[2].output===null)).toBe(true);
 });
 it.each(['openai_http_401','openai_http_403','openai_refusal'])('does not retry permanent or policy failure %s',async code=>{
  const complete=vi.fn().mockRejectedValue(new ModelFailure(code));
  expect(await new GroundedStrategy(async()=>[source],ledger(),{complete}).reply(context)).toMatchObject({action:'suppress',text:''});expect(complete).toHaveBeenCalledOnce();
 });
 it('honors exhausted budgets and does not open another reservation while the first is still running',async()=>{
  for(const status of ['budget_exhausted','reserved'] as const){
   const usage={reserve:vi.fn(async()=>({status})),finish:vi.fn()},complete=vi.fn();
   expect(await new GroundedStrategy(async()=>[source],usage,{complete}).reply(context)).toMatchObject({action:'suppress',text:''});expect(usage.reserve).toHaveBeenCalledOnce();expect(complete).not.toHaveBeenCalled();
  }
 });
 it('cannot recover when the second budget reservation is denied',async()=>{
  const usage=ledger();usage.reserve.mockResolvedValueOnce({status:'new',id:'first'}).mockResolvedValueOnce({status:'budget_exhausted'});
  const complete=vi.fn().mockRejectedValue(new ModelFailure('openai_network_unknown'));
  expect(await new GroundedStrategy(async()=>[source],usage,{complete}).reply(context)).toMatchObject({action:'suppress',text:'',reason:'ai_budget_exhausted'});expect(complete).toHaveBeenCalledOnce();
 });
 it('suppresses technical prose in decisions cached by an older deployment',async()=>{
  const complete=vi.fn();const usage={reserve:async()=>({status:'completed' as const,decision:{action:'unavailable' as const,text:'Sorry, a technical issue occurred.',reason:'openai_http_401',sources:[]}}),finish:vi.fn()};
  expect(await new GroundedStrategy(async()=>[source],usage,{complete}).reply(context)).toMatchObject({action:'suppress',text:''});expect(complete).not.toHaveBeenCalled();
 });
 it('never sends a reply when recovery fails and never retries an uncertain WhatsApp send',async()=>{
  const job:MessageJob={id:'job',tenant_id:'tenant',inbound_message_id:'one',lease_token:'lease'};
  const complete=vi.fn().mockRejectedValueOnce(new ModelFailure('openai_incomplete')).mockResolvedValue(result());
  const prepareDecision=vi.fn(async()=>({outbound_id:'out',phone_number_id:'9001',recipient:'allowed',body:'Cash or card.'}));
  const fail=vi.fn(),send=vi.fn().mockRejectedValue(new SendError(true,'timeout'));
  const repository={context:async()=>context,prepareDecision,fail} as unknown as MessagingRepository;
  expect(await processIncomingMessage(job,{repository,sender:{send},strategy:new GroundedStrategy(async()=>[source],ledger(),{complete})})).toBe('needs_review');expect(send).toHaveBeenCalledOnce();expect(fail).toHaveBeenCalledWith(job,'needs_review','timeout');
  const suppress=vi.fn(async()=>null);send.mockClear();
  expect(await processIncomingMessage(job,{repository:{...repository,prepareDecision:suppress},sender:{send},strategy:new GroundedStrategy(async()=>[source],ledger(),{complete:vi.fn().mockRejectedValue(new ModelFailure('openai_incomplete'))})})).toBe('skipped');
  expect(suppress).toHaveBeenCalledWith(job,expect.objectContaining({action:'suppress',text:''}));expect(send).not.toHaveBeenCalled();
 });
});

describe('dashboard-only failure review',()=>{
 it('uses the existing suppress RPC and tenant/epoch-scoped metadata writes without an outbound message',async()=>{
  const queries=new Map<string,{select:ReturnType<typeof vi.fn>;update:ReturnType<typeof vi.fn>;eq:ReturnType<typeof vi.fn>;in:ReturnType<typeof vi.fn>;single:ReturnType<typeof vi.fn>;then:unknown}>();
  const from=vi.fn((table:string)=>{
   const q={select:vi.fn(),update:vi.fn(),eq:vi.fn(),in:vi.fn(),single:vi.fn(async()=>({data:{conversation_id:'conversation'},error:null})),then:(resolve:(value:unknown)=>unknown)=>Promise.resolve({error:null}).then(resolve)};
   for(const method of ['select','update','eq','in'] as const)q[method].mockReturnValue(q);queries.set(table,q);return q;
  });
  const rpc=vi.fn(async()=>({data:null,error:null}));const repository=new SupabaseMessagingRepository({from,rpc} as unknown as SupabaseClient,'9001');
  const job={id:'job',tenant_id:'tenant',inbound_message_id:'one',lease_token:'lease',automation_epoch:4};
  expect(await repository.prepareDecision(job,{action:'unavailable',reason:'openai_incomplete',text:'Old technical failure',sources:[]})).toBeNull();
  expect(rpc).toHaveBeenCalledWith('prepare_followup_reply',expect.objectContaining({p_action:'suppress',p_body:'',p_sources:[]}));
  for(const q of queries.values())expect(q.eq).toHaveBeenCalledWith('tenant_id','tenant');
  expect(queries.get('messages')!.select).toHaveBeenCalledWith('conversation_id');expect(queries.get('messages')!.update).not.toHaveBeenCalled();
  expect(queries.get('conversations')!.eq).toHaveBeenCalledWith('automation_epoch',4);expect(queries.get('conversations')!.eq).toHaveBeenCalledWith('automation_mode','auto');
  expect(queries.get('conversations')!.in).toHaveBeenCalledWith('attention_state',['none','resolved']);
  expect(queries.get('conversations')!.update).toHaveBeenCalledWith(expect.objectContaining({attention_state:'waiting',attention_summary:AI_RECOVERY_SUMMARY,attention_message_id:'one'}));
  expect(attentionReason('manual',AI_RECOVERY_SUMMARY)).toBe('Assistant reply needs review');
 });
});
