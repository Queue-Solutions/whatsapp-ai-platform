import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { GroundedStrategy } from '../src/modules/ai/grounded-strategy';
import { AI_MODEL, RESERVED_NANO } from '../src/modules/ai/config';
import { buildRequest, ModelFailure, OpenAiProvider } from '../src/modules/ai/openai';
import type { AgentDecision, KnowledgeSource } from '../src/modules/ai/contracts';
import type { UsageLedger, Reservation } from '../src/modules/ai/ledger';
import type { MessageContext, MessageJob, MessagingRepository } from '../src/modules/messaging/types';
import { processIncomingMessage } from '../src/modules/messaging/process-incoming-message';
import { handleAcceptance } from '../src/modules/ai/acceptance-handler';
const tenant = '11111111-1111-4111-8111-111111111111';
const otherTenant = '22222222-2222-4222-8222-222222222222';
const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const source: KnowledgeSource = { id: '33333333-3333-4333-8333-333333333333', kind: 'faq', updatedAt: '2026-09-12T00:00:00.000Z', label: 'K1', content: 'The fictional test branch closes at 21:00 on Tuesdays.' };
const context: MessageContext = { tenantId: tenant, conversationId: 'conversation', requestKey: 'message:one', text: 'When do you close on Tuesdays?', type: 'text', eligible: true };
const answer: AgentDecision = { text: 'We close at 21:00 on Tuesdays.', action: 'answer', reason: 'approved_knowledge', sources: [{ id: source.id, kind: source.kind, updatedAt: source.updatedAt }] };
function fakeLedger() {
  const reservations = new Map<string,Reservation>();
  const reserve = vi.fn(async (tenant: string,key: string) => {
    const k = tenant+':'+key; const previous = reservations.get(k); if (previous) return previous;
    reservations.set(k,{ status: 'reserved', id: k }); return { status: 'new' as const, id: k };
  });
  const finish = vi.fn(async (_tenant: string,id: string,result: Parameters<UsageLedger['finish']>[2]) => {
    reservations.set(id,{ status: result.state, id, decision: result.decision ?? undefined });
  });
  return { reserve, finish };
}
const modelResult = () => ({ decision: { text: answer.text, action: 'answer' as const, sourceLabels: ['K1'] }, input: 400, output: 70 });
describe('grounded reply strategy', () => {
  it('uses only the resolved tenant and reuses completed decisions on duplicate processing', async () => {
    const load = vi.fn(async () => [source]); const ledger = fakeLedger(); const complete = vi.fn(async () => modelResult());
    const strategy = new GroundedStrategy(load,ledger,{ complete });
    const first = await strategy.reply(context); const second = await strategy.reply(context);
    expect(first).toEqual(second); expect(complete).toHaveBeenCalledOnce(); expect(load).toHaveBeenCalledWith(tenant);
    expect(ledger.finish).toHaveBeenCalledWith(tenant,expect.any(String),expect.objectContaining({ input: 400, output: 70, state: 'completed' }));
    expect(first.usage?.costNano).toBe(400*400+70*1600);
  });
  it('makes no paid calls for empty knowledge, ineligible messages, explicit human requests, unsupported media or oversized inputs', async () => {
    const complete = vi.fn(); const ledger = fakeLedger(); const strategy = new GroundedStrategy(async () => [],ledger,{ complete });
    expect((await strategy.reply(context)).reason).toBe('no_approved_knowledge');
    expect((await strategy.reply({...context,eligible:false})).action).toBe('suppress');
    expect((await strategy.reply({...context,text:'عايز أكلم موظف'})).action).toBe('handoff');
    expect((await strategy.reply({...context,type:'image',text:null})).reason).toBe('unsupported_message');
    expect((await strategy.reply({...context,text:'ع'.repeat(2000)})).reason).toBe('message_too_long');
    expect(complete).not.toHaveBeenCalled(); expect(ledger.reserve).not.toHaveBeenCalled();
  });
  it('fails closed for exhausted budgets and existing uncertain reservations without retries', async () => {
    for (const status of ['reserved','failed','budget_exhausted'] as const) {
      const complete = vi.fn(); const ledger = {reserve:vi.fn(async()=>({status})),finish:vi.fn()};
      const result = await new GroundedStrategy(async()=>[source],ledger,{complete}).reply(context);
      expect(result.action).toBe('unavailable'); expect(complete).not.toHaveBeenCalled();
    }
  });
  it('retains the reservation on network uncertainty and never repeats the API call', async () => {
    const ledger = fakeLedger(); const complete = vi.fn().mockRejectedValue(new ModelFailure('openai_network_unknown'));
    const strategy = new GroundedStrategy(async()=>[source],ledger,{complete});
    expect((await strategy.reply(context)).action).toBe('unavailable');
    await strategy.reply(context); expect(complete).toHaveBeenCalledOnce();
    expect(ledger.finish).toHaveBeenCalledWith(tenant,expect.any(String),expect.objectContaining({state:'failed',input:null,output:null}));
  });
  it('does not deliver an uncommitted result if usage persistence fails', async () => {
    const ledger = fakeLedger(); ledger.finish.mockRejectedValue(new Error('DB down'));
    await expect(new GroundedStrategy(async()=>[source],ledger,{complete:async()=>modelResult()}).reply(context)).rejects.toThrow('DB down');
  });
  it('rejects unknown citations, empty citations and invented links while recording consumed usage', async () => {
    for (const result of [
      { ...modelResult(), decision: { ...modelResult().decision, sourceLabels:['OTHER_TENANT'] } },
      { ...modelResult(), decision: { ...modelResult().decision, sourceLabels:[] } },
      { ...modelResult(), decision: { ...modelResult().decision, text:'See https://invented.example.test' } },
    ]) {
      const ledger = fakeLedger(); const decision = await new GroundedStrategy(async()=>[source],ledger,{complete:async()=>result}).reply(context);
      expect(decision.action).toBe('unavailable'); expect(decision.usage).toBeDefined(); expect(ledger.finish).toHaveBeenCalledOnce();
    }
  });
  it('rejects the wrong reply language even when the model cites the right source', async () => {
    const decision=await new GroundedStrategy(async()=>[source],fakeLedger(),{complete:async()=>({
      ...modelResult(),decision:{...modelResult().decision,text:'فرع الاختبار بيقفل الساعة تسعة مساءً.'},
    })}).reply(context);
    expect(decision.reason).toBe('wrong_response_language');expect(decision.action).toBe('unavailable');
    expect(decision.text).not.toMatch(/[\u0600-\u06ff]/);
    expect(JSON.parse(buildRequest(context,[{...source,content:'كوبر: test branch hours'}])).instructions).toContain('REQUIRED OUTPUT LANGUAGE: English');
  });
  it('does not reuse a cached answer after its source was changed or unpublished', async () => {
    const load = vi.fn(async()=>[source]); const complete = vi.fn(async()=>modelResult()); const strategy = new GroundedStrategy(load,fakeLedger(),{complete});
    await strategy.reply(context); load.mockResolvedValue([{...source,updatedAt:'2026-09-13T00:00:00.000Z'}]);
    expect((await strategy.reply(context)).reason).toBe('cached_knowledge_changed'); expect(complete).toHaveBeenCalledOnce();
  });
  it('keeps unknown-answer fallback in the customer language and overrides unsupported model claims', async () => {
    const decision = await new GroundedStrategy(async()=>[source],fakeLedger(),{ complete:async()=>({
      decision:{action:'unavailable',text:'Invented business promise',sourceLabels:[]},input:300,output:40,
    }) }).reply({...context,text:'السعر كام؟'});
    expect(decision.text).toMatch(/[\u0600-\u06ff]/); expect(decision.text).not.toContain('Invented');
  });
  it('does not call the provider when approved knowledge exceeds the input allowance', async () => {
    const complete=vi.fn(); const ledger=fakeLedger();
    expect((await new GroundedStrategy(async()=>[{...source,content:'x'.repeat(9000)}],ledger,{complete}).reply(context)).reason).toBe('knowledge_too_large');
    expect(ledger.reserve).not.toHaveBeenCalled();
  });
});

describe('OpenAI HTTP adapter', () => {
  const envelope = (changes: Record<string,unknown>={}) => ({ model:AI_MODEL,status:'completed',usage:{input_tokens:400,output_tokens:70},
    output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(modelResult().decision)}]}],...changes });
  it('uses a bounded, stateless structured response with no tools and no hidden identifiers', async () => {
    const fetcher=vi.fn().mockResolvedValue(Response.json(envelope()));
    const body=buildRequest({...context,history:[{role:'user',content:'I mean the test branch.'}]},[source]);
    expect(await new OpenAiProvider('fake-key',fetcher).complete(body)).toEqual(modelResult());
    const sent=JSON.parse(fetcher.mock.calls[0][1].body);
    expect(sent).toMatchObject({model:AI_MODEL,store:false,max_output_tokens:650,text:{format:{type:'json_schema',strict:true}}});
    expect(sent.tools).toBeUndefined(); expect(sent.input).not.toContain(tenant); expect(sent.input).not.toContain(source.id);
    expect(sent.input).toContain('I mean the test branch.');
  });
  it('rejects huge requests before API dispatch', () => {
    expect(()=>buildRequest({...context,text:'ع'.repeat(10000)},[source])).toThrow('limit');
  });
  it('never retries HTTP errors, malformed output, refusal or uncertain network outcomes', async () => {
    const fixtures=[new Response('private provider detail',{status:429}),Response.json(envelope({status:'incomplete'})),
      Response.json(envelope({output:[{type:'message',content:[{type:'refusal'}]}]})),Response.json(envelope({output:[]})),
      Response.json(envelope({usage:{input_tokens:999999,output_tokens:2}}))];
    for(const response of fixtures){const fetcher=vi.fn().mockResolvedValue(response);await expect(new OpenAiProvider('fake',fetcher).complete('{}')).rejects.toBeInstanceOf(ModelFailure);expect(fetcher).toHaveBeenCalledOnce();}
    const fetcher=vi.fn().mockRejectedValue(new Error('secret response body'));
    await expect(new OpenAiProvider('fake',fetcher).complete('{}')).rejects.toThrow('openai_network_unknown');
  });
});

describe('acceptance endpoint boundary', () => {
  const secret='s'.repeat(32); const run=vi.fn(async()=>answer); const resolveTenant=vi.fn(async()=>tenant);
  const options={secret,enabled:true,run,resolveTenant};
  beforeEach(()=>vi.clearAllMocks());
  it('authenticates before resolving a tenant or making any paid calls', async () => {
    expect((await handleAcceptance(new Request('https://test',{method:'POST',body:'{"case":"english_hours"}'}),options)).status).toBe(401);
    expect(run).not.toHaveBeenCalled(); expect(resolveTenant).not.toHaveBeenCalled();
  });
  it('rejects arbitrary prompts, tenant overrides and oversized bodies', async () => {
    for(const body of ['{"case":"english_hours","tenant":"other"}','{"case":"anything"}','x'.repeat(1025)]) {
      const r=await handleAcceptance(new Request('https://test',{method:'POST',headers:{Authorization:`Bearer ${secret}`},body}),options);
      expect([400,413]).toContain(r.status);
    }
    expect(run).not.toHaveBeenCalled();
  });
  it('only runs a fixed fixture under a trusted channel tenant and can be disabled', async () => {
    const req=()=>new Request('https://test',{method:'POST',headers:{Authorization:`Bearer ${secret}`},body:'{"case":"english_hours"}'});
    expect((await handleAcceptance(req(),{...options,enabled:false})).status).toBe(404);
    expect((await handleAcceptance(req(),options)).status).toBe(200);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({tenantId:tenant,requestKey:'acceptance:v2:english_hours'}),expect.any(Array));
  });
});

describe('durable AI allowance and final send guards', () => {
  let db: PGlite;
  async function rows<T>(sql:string,args:unknown[]=[]){return (await db.query<T>(sql,args)).rows;}
  async function reserve(key:string,t=tenant){return (await rows<{v:Reservation}>('select public.reserve_ai_request($1,$2,$3,$4,$5) as v',[t,key,'acceptance',AI_MODEL,'test-v1']))[0].v;}
  async function finish(id:string,input:number|null,output:number|null,state='completed'){
    return db.query('select public.finish_ai_request($1,$2,$3,$4,$5,$6,$7,$8)',[tenant,id,state,input,output,30,state==='completed'?JSON.stringify(answer):null,state==='failed'?'test_failure':null]);
  }
  beforeAll(async()=>{
    db=new PGlite();
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
    for(const file of ['202609120001_foundation.sql','202609120002_bounded_ai.sql']) await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  });
  afterAll(async()=>{await db?.close();});
  beforeEach(async()=>{
    await db.exec('reset role;truncate public.tenants,auth.users cascade;update public.ai_budget set allocated_nano=0,cap_nano=250000000;');
    await db.query('insert into public.tenants(id,name,slug) values($1,$2,$3),($4,$5,$6)',[tenant,'Dev','dev',otherTenant,'Other','other']);
  });
  it('serializes concurrent reservations under one non-renewing $0.25 limit across tenants', async()=>{
    const attempts=await Promise.all(Array.from({length:30},(_,i)=>reserve('test'+i,i%2?tenant:otherTenant)));
    expect(attempts.filter(r=>r.status==='new')).toHaveLength(Math.floor(250000000/RESERVED_NANO));
    expect(attempts.some(r=>r.status==='budget_exhausted')).toBe(true);
    expect((await rows<{allocated_nano:number}>('select allocated_nano from public.ai_budget'))[0].allocated_nano).toBeLessThanOrEqual(250000000);
    await expect(db.exec('update public.ai_budget set cap_nano=250000001')).rejects.toThrow();
  });
  it('deduplicates reservations, settles once and retains full exposure on uncertain failures', async()=>{
    const first=await reserve('same');expect((await reserve('same')).status).toBe('reserved');
    await finish(first.id!,400,70);await finish(first.id!,0,0);
    const cached=await reserve('same');expect(cached.status).toBe('completed');expect(cached.decision).toEqual(answer);
    const uncertain=await reserve('uncertain');await finish(uncertain.id!,null,null,'failed');
    const budget=(await rows<{allocated_nano:number}>('select allocated_nano from public.ai_budget'))[0];
    expect(budget.allocated_nano).toBe(400*400+70*1600+RESERVED_NANO);
    expect((await reserve('uncertain')).status).toBe('failed');
  });
  it('rejects cross-tenant settlement, over-limit usage and unauthorized budget mutations', async()=>{
    const first=await reserve('one');await reserve('one',otherTenant);
    await expect(db.query('select public.finish_ai_request($1,$2,$3,$4,$5,$6,$7,$8)',[otherTenant,first.id,'failed',0,0,1,null,'error'])).rejects.toThrow();
    await expect(finish(first.id!,24001,0)).rejects.toThrow();
    await db.query('insert into auth.users(id) values($1)',[user]);await db.query("insert into public.tenant_memberships values($1,$2,'owner')",[tenant,user]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');
    expect(await rows('select id from public.ai_requests')).toHaveLength(1);
    await expect(db.exec('select * from public.ai_budget')).rejects.toThrow();await expect(reserve('browser')).rejects.toThrow();
    await expect(db.exec('update public.ai_requests set charged_nano=0')).rejects.toThrow();
    await db.exec('set role anon');await expect(db.exec('select * from public.ai_requests')).rejects.toThrow();await db.exec('reset role');
  });
  async function createJob(){
    await db.query("insert into public.whatsapp_channels(tenant_id,phone_number_id) values($1,'9001')",[tenant]);
    await db.query("select public.ingest_whatsapp_message('9001','test-inbound','201000000001',null,now(),'text','Test question')");
    return (await rows<MessageJob>("select * from public.claim_message_job('9001')"))[0];
  }
  async function prepare(job:MessageJob,decision:AgentDecision){return (await rows<{v:unknown}>('select public.prepare_ai_reply($1,$2,$3,$4,$5) as v',[job.id,job.lease_token,decision.text,decision.action,JSON.stringify(decision.sources)]))[0].v;}
  async function addSource(){await db.query('insert into public.faqs(id,tenant_id,question,answer,is_published,updated_at) values($1,$2,$3,$4,true,$5)',[source.id,tenant,'Hours?',source.content,source.updatedAt]);}
  it('suppresses an AI response if a human takes over while the model is running', async()=>{
    const job=await createJob();await addSource();
    const repository={context:async()=>context,prepareDecision:prepare,complete:vi.fn(),fail:vi.fn()} as unknown as MessagingRepository;
    const send=vi.fn();
    const result=await processIncomingMessage(job,{repository,sender:{send},strategy:{reply:async()=>{await db.exec("update public.conversations set automation_mode='human'");return answer;}}});
    expect(result).toBe('skipped');expect(send).not.toHaveBeenCalled();
  });
  it('suppresses changed or unpublished sources immediately before saving a send intent', async()=>{
    const job=await createJob();await addSource();await db.exec('update public.faqs set is_published=false');
    expect(await prepare(job,answer)).toBeNull();expect(await rows("select * from public.messages where direction='outbound'")).toHaveLength(0);
  });
  it('rejects another tenant\'s source and empty citations for factual answers', async()=>{
    const job=await createJob();await db.query('insert into public.faqs(id,tenant_id,question,answer,is_published,updated_at) values($1,$2,$3,$4,true,$5)',[source.id,otherTenant,'Other?','Private other answer',source.updatedAt]);
    await expect(prepare(job,{...answer,sources:[]})).rejects.toThrow('Ungrounded');
    expect(await prepare(job,answer)).toBeNull();
  });
  it('records a real handoff atomically with its acknowledgement and preserves the sending state', async()=>{
    const job=await createJob();expect(await prepare(job,{...answer,action:'handoff',sources:[]})).not.toBeNull();
    expect((await rows<{automation_mode:string}>('select automation_mode from public.conversations'))[0].automation_mode).toBe('human');
    expect((await rows<{state:string}>('select state from public.message_jobs'))[0].state).toBe('sending');
  });
});
