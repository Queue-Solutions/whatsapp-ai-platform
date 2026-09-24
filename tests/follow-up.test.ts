import {describe,it,expect,vi} from 'vitest';
import {GroundedStrategy} from '../src/modules/ai/grounded-strategy';
import {beginFollowUp,continueFollowUp,contactPhone} from '../src/modules/ai/follow-up';
import {formatReply,formatBusinessReply,formatBranchReply} from '../src/modules/ai/reply-format';
import type {MessageContext} from '../src/modules/messaging/types';
const context:MessageContext={tenantId:'tenant',conversationId:'conversation',requestKey:'inbound',eligible:true,type:'text',text:'My order arrived damaged'};
const issue={action:'handoff' as const,reason:'complaint',text:'',sources:[],attentionSummary:'The customer reports a damaged item.'};
const pending={state:'collecting' as const,name:null,phone:null,reason:'complaint',summary:issue.attentionSummary};
describe('personal follow-up collection',()=>{
 it('starts with a name and phone request and completes only after both are supplied',()=>{
  const start=beginFollowUp(context,issue);
  expect(start).toMatchObject({action:'clarify',reason:'complaint',followUp:{state:'collecting',name:null,phone:null}});
  const name=continueFollowUp({...context,text:'Maya Hassan',followUp:pending,history:[{role:'assistant',content:start.text}]})!;
  expect(name.followUp).toMatchObject({name:'Maya Hassan',phone:null,state:'collecting'});expect(name.text).toContain('phone number');expect(name.text).not.toContain('shortly');
  const ready=continueFollowUp({...context,text:'01012345678',followUp:{...pending,...name.followUp},history:[{role:'assistant',content:name.text}]})!;
  expect(ready).toMatchObject({action:'handoff',followUp:{state:'ready',name:'Maya Hassan',phone:'201012345678'}});
  expect(ready.text).toContain('within the next 24 hours');expect(ready.text).toContain('type Cancel');expect(ready.text).not.toContain('type AI or');expect(ready.text).toContain('AI assistant is now turned off');
 });
 it('accepts combined details, international and Arabic digits without paid calls',async()=>{
  expect(contactPhone('٠١٠١٢٣٤٥٦٧٨')).toBe('201012345678');expect(contactPhone('+44 7700 900123')).toBe('447700900123');expect(contactPhone('123')).toBeNull();
  const ledger={reserve:vi.fn(),finish:vi.fn()};const complete=vi.fn();
  const start=beginFollowUp({...context,text:'الطلب وصل غلط'},issue);
  const result=await new GroundedStrategy(vi.fn(),ledger,{complete}).reply({...context,text:'اسمي منى حسن، رقمي ٠١٠١٢٣٤٥٦٧٨',followUp:pending,history:[{role:'assistant',content:start.text}]});
  expect(result.followUp).toEqual({state:'ready',name:'منى حسن',phone:'201012345678'});expect(result.text).toContain('IRAM');expect(result.text).toContain('24 ساعة');expect(result.text).toContain('اكتب Cancel');expect(result.text).not.toContain('AI أو Cancel');
  expect(ledger.reserve).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();
 });
 it.each(['Ziad 01067945993','Ziad\n01067945993'])('saves unlabelled name and phone details from the requested contact form: %j',async text=>{
  const ledger={reserve:vi.fn(),finish:vi.fn()};
  const complete=vi.fn();const classifyIntent=vi.fn();const loadSources=vi.fn();
  const start=beginFollowUp(context,issue);
  const result=await new GroundedStrategy(loadSources,ledger,{complete,classifyIntent}).reply({...context,text,followUp:pending,history:[{role:'assistant',content:start.text}]});
  expect(result).toMatchObject({action:'handoff',followUp:{state:'ready',name:'Ziad',phone:'201067945993'}});
  expect(result.text).toContain('within the next 24 hours');
  expect(loadSources).not.toHaveBeenCalled();expect(classifyIntent).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();
  expect(ledger.reserve).not.toHaveBeenCalled();expect(ledger.finish).not.toHaveBeenCalled();
 });
 it('retains a one-word name sent separately and asks only for the missing phone',async()=>{
  const loadSources=vi.fn(async()=>[]),complete=vi.fn();
  const reserve=vi.fn(async()=>({status:'new' as const,id:'contact-intent'})),finish=vi.fn();
  const classifyIntent=vi.fn(async()=>({decision:{intent:'contact_details' as const,confidence:.99,language:'en' as const,product:'unknown' as const,branchMode:'none' as const,branchDetail:'none' as const,branchLabels:[],normalizedQuery:'Emad',summary:''},input:100,output:20}));
  const start=beginFollowUp(context,issue);
  const result=await new GroundedStrategy(loadSources,{reserve,finish},{complete,classifyIntent}).reply({...context,text:'emad',followUp:pending,history:[{role:'assistant',content:start.text}]});
  expect(result).toMatchObject({action:'clarify',followUp:{state:'collecting',name:'emad',phone:null}});
  expect(result.text).toContain('phone number');expect(result.text).not.toContain('share your name and');
  expect(loadSources).toHaveBeenCalledOnce();expect(classifyIntent).toHaveBeenCalledOnce();expect(finish).toHaveBeenCalledOnce();expect(complete).not.toHaveBeenCalled();
 });
 it.each(['Ofcourse','of course','SURE','Absolutely','تمام'])('does not save an acknowledgement as a customer name: %j',async text=>{
  const loadSources=vi.fn(),reserve=vi.fn(),complete=vi.fn(),classifyIntent=vi.fn();
  const start=beginFollowUp(context,issue);
  const result=await new GroundedStrategy(loadSources,{reserve,finish:vi.fn()},{complete,classifyIntent}).reply({...context,text,followUp:pending,history:[{role:'assistant',content:start.text}]});
  expect(result).toMatchObject({action:'clarify',followUp:{state:'collecting',name:null,phone:null}});
  expect(result.text).toContain('name');expect(result.text).toContain('phone');
  expect(loadSources).not.toHaveBeenCalled();expect(reserve).not.toHaveBeenCalled();expect(classifyIntent).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();
 });
 it('supports phone first, re-prompts for invalid phone and handles refusal without a callback promise',()=>{
  const start=beginFollowUp(context,issue);
  const phone=continueFollowUp({...context,text:'+201012345678',followUp:pending,history:[{role:'assistant',content:start.text}]})!;
  expect(phone.text).toContain('your name');
  const invalid=continueFollowUp({...context,text:'123',followUp:{...pending,name:'Maya'}})!;
  expect(invalid.followUp?.state).toBe('collecting');expect(invalid.followUp?.phone).toBeNull();
  const declined=continueFollowUp({...context,text:'I do not want to share my number',followUp:pending})!;
  expect(declined).toMatchObject({action:'handoff',followUp:{state:'declined'}});expect(declined.text).not.toContain('24 hours');expect(declined.text).toContain('type Cancel');expect(declined.text).not.toContain('type AI or');
 });
 it('does not infer a callback number from an order number or capture a business question as a name',()=>{
  expect(beginFollowUp({...context,text:'I am upset about my order'},issue).followUp?.name).toBeNull();
  expect(beginFollowUp({...context,text:'My order 123456789 arrived damaged'},issue).followUp?.phone).toBeNull();
  expect(continueFollowUp({...context,text:'What about order 123456789?',followUp:pending})).toBeNull();
  expect(continueFollowUp({...context,text:'Where are your branches?',followUp:pending,history:[{role:'assistant',content:'Could you share your name?'}]})).toBeNull();
  expect(continueFollowUp({...context,text:'I do not know your opening hours',followUp:pending})).toBeNull();
 });
 it('keeps an Arabic contact flow in Arabic when the next reply is only digits',()=>{
  const result=continueFollowUp({...context,text:'01012345678',followUp:{...pending,name:'منى'},history:[{role:'assistant',content:'ممكن رقم تليفون صحيح للتواصل؟'}]})!;
  expect(result.text).toContain('IRAM');expect(result.text).toContain('24 ساعة');
 });
 it('acknowledges a customer cancellation without knowledge or paid AI calls',async()=>{
  const load=vi.fn(),reserve=vi.fn(),complete=vi.fn(),classifyIntent=vi.fn();
  const strategy=new GroundedStrategy(load,{reserve,finish:vi.fn()},{complete,classifyIntent});
  const english=await strategy.reply({...context,text:'Cancel',resumeRequested:true,history:[{role:'assistant',content:'The AI assistant is now turned off for this chat.'}]});
  expect(english).toMatchObject({action:'clarify',reason:'assistant_resumed'});expect(english.text).toContain('follow-up has been cancelled');expect(english.text).toContain('AI assistant is back on');
  const arabic=await strategy.reply({...context,text:'cAnCeL',resumeRequested:true,history:[{role:'assistant',content:'المساعد الذكي اتوقف دلوقتي في المحادثة دي.'}]});
  expect(arabic.text).toContain('تم إلغاء طلب المتابعة');expect(load).not.toHaveBeenCalled();expect(reserve).not.toHaveBeenCalled();expect(classifyIntent).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();
 });
 it('never collects or sends after a manual takeover invalidates the job',async()=>{
  const result=await new GroundedStrategy(vi.fn(),{reserve:vi.fn(),finish:vi.fn()},{complete:vi.fn()}).reply({...context,eligible:false,text:'Maya +201012345678',followUp:pending});
  expect(result.action).toBe('suppress');expect(result.followUp).toBeUndefined();
 });
});
describe('WhatsApp reply presentation',()=>{
 it('normalizes all brand spellings to uppercase English while retaining useful paragraph spacing',()=>{
 expect(formatReply('أهلًا في إيرام؛  مع iram و ارم;\n\n\nتفضل')).toBe('أهلًا في IRAM\nمع IRAM و IRAM\n\nتفضل');
  expect(formatReply('See https://example.test/a;b')).toBe('See https://example.test/a%3Bb');
  expect(formatBusinessReply('شكرًا لتواصلك مع IRAM Jewelry!\n\nمن فضلك ابعت السيرة الذاتية.\n\nمع أطيب التحيات،\nIRAM Jewelry')).toBe('من فضلك ابعت السيرة الذاتية.');
  expect(formatBusinessReply('Hello!\n\nYour branch closes at 10 PM.')).toBe('Your branch closes at 10 PM.');
 });
 it('places each branch on its own line with a blank line between entries',()=>{
  expect(formatReply(formatBranchReply('Our branches:', ['Riverside — River Road','Garden — Park Road']))).toBe('Our branches:\n\n• Riverside — River Road\n\n• Garden — Park Road');
 });
 it('formats a cited model branch response and keeps its grounding checks',async()=>{
  const source={id:'branch-source',kind:'fact' as const,updatedAt:'2026-09-17',label:'K1',content:'IRAM Riverside on River Road and Garden on Park Road.'};
  const strategy=new GroundedStrategy(async()=>[source],{reserve:async()=>({status:'new',id:'reservation'}),finish:vi.fn()},{complete:async()=>({decision:{action:'answer',text:'Visit IRAM; here are our branches',branchLines:['Riverside — River Road','Garden — Park Road'],sourceLabels:['K1']},input:100,output:80})});
  const result=await strategy.reply({...context,text:'Your branches?'});
  expect(result.action).toBe('answer');expect(result.text).not.toMatch(/[;؛]/);
  expect(result.text).toContain('\\n\\n• Riverside — River Road\\n\\n• Garden — Park Road'.replaceAll('\\n','\n'));
  expect(result.sources).toEqual([{id:source.id,kind:'fact',updatedAt:source.updatedAt}]);
 });
 it('greets customers warmly and consistently in English and Arabic',async()=>{
  const strategy=new GroundedStrategy(vi.fn(),{reserve:vi.fn(),finish:vi.fn()},{complete:vi.fn()});
  const en=await strategy.reply({...context,text:'Hi'});const ar=await strategy.reply({...context,text:'السلام عليكم'});
  expect(en.text).toContain('Welcome to IRAM');expect(en.text).toContain('\n\n');expect(ar.text).toContain('IRAM');expect(ar.text).not.toMatch(/ارم|إيرام/);
  for(const reply of [en,ar])expect(reply.text).not.toMatch(/[;؛]/);
 });
});
