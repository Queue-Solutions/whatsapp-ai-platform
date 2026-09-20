import {describe,it,expect,vi} from 'vitest';
import {GroundedStrategy} from '../src/modules/ai/grounded-strategy';
import {selectKnowledge} from '../src/modules/ai/knowledge-selection';
import {branchScope} from '../src/modules/ai/branch-scope';
import {buildRequest} from '../src/modules/ai/openai';
import type {KnowledgeSource,AgentDecision} from '../src/modules/ai/contracts';
import type {MessageContext} from '../src/modules/messaging/types';
const context:MessageContext={tenantId:'tenant',conversationId:'conversation',requestKey:'message:synthetic',type:'text',text:'مش محتاجين عمالة ؟'};
const branches:KnowledgeSource[]=['Riverside','Garden'].map((name,i)=>({id:'branch'+i,kind:'fact',label:'B'+i,updatedAt:'2026-09-17',content:JSON.stringify({category:'branch',value:{name:'IRAM '+name,address:name+' Road',hours:'9–5'}})}));
const faq:KnowledgeSource={id:'faq',kind:'faq',label:'F1',updatedAt:'2026-09-17',content:JSON.stringify({question:'How can I pay?',answer:'Cash or card.'})};
const directory:KnowledgeSource={...faq,id:'directory',label:'F2',content:JSON.stringify({question:'Where are your branches?',answer:'Riverside and Garden.'})};
const ledger=()=>({reserve:vi.fn(async()=>({status:'new' as const,id:'reservation'})),finish:vi.fn()});
describe('hiring intent and immediate confirmations',()=>{
 it.each(['مش محتاجين عمالة ؟','محتاجين موظفين؟','مش عايزين عمال؟','هل بتعينوا ناس؟','Do you need staff?','I would like to join your team'])('takes %s straight to the role question without retrieval or an AI request',async text=>{
  const load=vi.fn(),complete=vi.fn(),usage=ledger();const reply=await new GroundedStrategy(load,usage,{complete}).reply({...context,text});
  expect(reply).toMatchObject({reason:'career_application',followUp:{purpose:'career',role:null,state:'collecting'}});expect(reply.text).not.toMatch(/فروع|branches|مشكلة تقنية/);expect(load).not.toHaveBeenCalled();expect(usage.reserve).not.toHaveBeenCalled();
 });
 it('recovers the exact screenshot clarification followed by اه',async()=>{
  const result=await new GroundedStrategy(vi.fn(),ledger(),{complete:vi.fn()}).reply({...context,text:'اه',history:[{role:'user',content:'مش محتاجين عمالة ؟'},{role:'assistant',content:'هل تقصد إنك عايز تشتغل مع ارم كعامل؟ ممكن توضح أكتر طلبك؟'}]});
  expect(result.followUp).toMatchObject({purpose:'career',role:null});expect(result.text).toContain('الوظيفة');
  const again=await new GroundedStrategy(vi.fn(),ledger(),{complete:vi.fn()}).reply({...context,text:'اه',followUp:{...result.followUp!,reason:result.reason,summary:result.attentionSummary!}});
  expect(again.followUp?.role).toBeNull();
 });
 it('uses model career classification for less common wording without sending model prose or invented references',async()=>{
  const result=await new GroundedStrategy(async()=>[faq],ledger(),{complete:async()=>({decision:{action:'career',text:'Call all our branches.',branchLines:[],sourceLabels:[]},input:100,output:20})}).reply({...context,text:'Can I send you my CV?'});
  expect(result.followUp?.purpose).toBe('career');expect(result.text).not.toContain('branches');
 });
});
describe('branch listings require a request',()=>{
 it('excludes branch records and directory FAQs from unrelated requests, even with old branch history',()=>{
  for(const text of ['What payment methods do you accept?','عايز اقدم عندكم','I want help with an order']){
   const c={...context,text,history:[{role:'user' as const,content:'Your branches?'},{role:'assistant' as const,content:'Riverside and Garden.'}]};
   expect(branchScope(c,branches)).toBe('none');expect(selectKnowledge(c,[...branches,faq,directory]).sources).toEqual([faq]);
   const request=JSON.parse(buildRequest(c,[faq]));expect(JSON.parse(request.input).replyScope).toBe('none');expect(request.text.format.schema.properties.branchLines.maxItems).toBe(0);
  }
 });
 it('retains explicit branch requests and specific hours/area follow-ups',()=>{
  expect(branchScope({...context,text:'فين فروعكم؟'},branches)).toBe('directory');expect(branchScope({...context,text:'When do you close?'},branches)).toBe('detail');expect(branchScope({...context,text:'Riverside?'},branches)).toBe('detail');
  expect(branchScope({...context,text:'And on Friday?',history:[{role:'user',content:'Riverside'}]},branches)).toBe('detail');
  expect(selectKnowledge({...context,text:'Your branches?'},[...branches,faq]).sources).toEqual(expect.arrayContaining(branches));
 });
 it('does not treat a request to avoid branches as permission to list them',()=>{
  for(const text of ['Do not list branches, what cards do you accept?','بلاش فروع، الاسعار كام؟'])expect(branchScope({...context,text},branches)).toBe('none');
 });
 it('blocks unsolicited branchLines and directories hidden in prose, including cached replies',async()=>{
  const text='IRAM Riverside — Riverside Road. IRAM Garden — Garden Road.';
  for(const branchLines of [[],['Riverside','Garden']]){
   const result=await new GroundedStrategy(async()=>[...branches,faq],ledger(),{complete:async()=>({decision:{action:'answer',text,branchLines,sourceLabels:['F1']},input:100,output:40})}).reply({...context,text:'How can I pay?'});
   expect(result.action).toBe('clarify');expect(result.text).not.toMatch(/Riverside|Garden/);
  }
  const cached:AgentDecision={action:'answer',text,reason:'approved_knowledge',sources:branches.map(({id,kind,updatedAt})=>({id,kind,updatedAt}))};
  const result=await new GroundedStrategy(async()=>[...branches,faq],{reserve:async()=>({status:'completed',decision:cached}),finish:vi.fn()},{complete:vi.fn()}).reply({...context,text:'How can I pay?'});
  expect(result.action).toBe('clarify');expect(result.text).not.toContain('Riverside');
 });
 it('keeps focused branch questions concise without discarding relevant FAQs or valid aggregate citations',async()=>{
  const payment={...faq,content:JSON.stringify({question:'What payment methods do your branches accept?',answer:'Cash or card.'})};
  expect(selectKnowledge({...context,text:'Can I pay by card?'},[...branches,payment]).sources).toContainEqual(payment);
  expect(branchScope({...context,text:'What are your branches opening hours?'},branches)).toBe('detail');
  const result=await new GroundedStrategy(async()=>branches,ledger(),{complete:async()=>({decision:{action:'answer',text:'Both open from 9 to 5.',branchLines:[],sourceLabels:['B0','B1']},input:100,output:20})}).reply({...context,text:'What are your jewelry branches opening hours?'});
  expect(result.action).toBe('answer');
 });
 it('allows an explicitly requested directory and one directly requested branch detail',async()=>{
  const provider={complete:async()=>({decision:{action:'answer' as const,text:'Our branches',branchLines:['IRAM Riverside — Riverside Road','IRAM Garden — Garden Road'],sourceLabels:['B0','B1']},input:100,output:50})};
  const result=await new GroundedStrategy(async()=>branches,ledger(),provider).reply({...context,text:'Your jewelry branches?'});expect(result.action).toBe('answer');expect(result.text).toContain('Riverside');
  const detail=await new GroundedStrategy(async()=>branches,ledger(),{complete:async()=>({decision:{action:'answer',text:'Riverside opens at 9.',branchLines:[],sourceLabels:['B0']},input:100,output:30})}).reply({...context,text:'Riverside jewelry hours?'});expect(detail.action).toBe('answer');
 });
});
