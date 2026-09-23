import {describe,it,expect,vi} from 'vitest';
import {GroundedStrategy} from '../src/modules/ai/grounded-strategy';
import {isCareerEnquiry} from '../src/modules/ai/follow-up';
import type {MessageContext,MessagingRepository} from '../src/modules/messaging/types';
import {OpenAiModerator,blockedCategories} from '../src/modules/moderation/provider';
import type {Environment} from '../src/config/env';
import {processIncomingMessage} from '../src/modules/messaging/process-incoming-message';
import {handleBlacklistImage} from '../src/modules/admin/blacklist-image';
import {parseWebhook} from '../src/modules/whatsapp/parser';
const context:MessageContext={tenantId:'tenant',conversationId:'conversation',requestKey:'message:job',type:'text',text:'محتاج شغل'};
const careerFaq={id:'career-faq',kind:'faq' as const,label:'F9',updatedAt:'2026-09-20',content:JSON.stringify({question:'Do you have any job vacancies?',answer:'Please send your CV to hr@example.test.'})};
const env={WHATSAPP_ACCESS_TOKEN:'synthetic-token',META_GRAPH_API_VERSION:'v24.0',WHATSAPP_TEST_PHONE_NUMBER_ID:'9001'} as Environment;
const categories=(flag:string|null=null)=>Object.fromEntries([...blockedCategories,'self-harm','violence'].map(c=>[c,c===flag]));
const result=(flag:string|null=null)=>Response.json({results:[{categories:categories(flag)}]});
describe('job enquiries',()=>{
 it('answers from FAQ 9 immediately without collecting role or contact details',async()=>{
  const load=vi.fn(async()=>[careerFaq]),complete=vi.fn(),reserve=vi.fn();const strategy=new GroundedStrategy(load,{reserve,finish:vi.fn()},{complete});
  for(const text of ['محتاج شغل','عايز اشتغل عندكم','فيه وظائف؟','Are you hiring?','I want to work at IRAM','i wanna work with u guyz']){
   const reply=await strategy.reply({...context,text,requestKey:`message:${text}`});expect(reply).toMatchObject({reason:'approved_knowledge',action:'answer',sources:[{id:'career-faq'}]});expect(reply.text).toContain('hr@example.test');expect(reply.followUp).toBeUndefined();
   if(/[\u0600-\u06ff]/.test(text)){expect(reply.text).toContain('السيرة الذاتية');expect(reply.text).not.toContain('Please send');}
   else expect(reply.text).toContain('Please send');
   expect(reply.text).not.toMatch(/شكرًا لتواصلك|Thank you for contacting|مع أطيب التحيات|Best regards/i);
  }
  expect(load).toHaveBeenCalledTimes(6);expect(complete).not.toHaveBeenCalled();expect(reserve).not.toHaveBeenCalled();
 });
 it('does not confuse opening hours or a refusal to look for work with applications',()=>{
  for(const text of ['What are your working hours?','مواعيد الشغل ايه؟','فين فروعكم','مش عايز شغل','I am not looking for a job'])expect(isCareerEnquiry(text)).toBe(false);
 });
 it('ignores a legacy role-collection state and leaves unrelated questions on normal handling',async()=>{
  const provider={complete:vi.fn()};const strategy=new GroundedStrategy(async()=>[],{reserve:vi.fn(),finish:vi.fn()},provider);
  expect((await strategy.reply({...context,eligible:false})).action).toBe('suppress');
  const r=await strategy.reply({...context,text:'فين فروعكم؟',followUp:{purpose:'career',role:null,state:'collecting',name:null,phone:null,reason:'career_application',summary:'Job enquiry'}});
  expect(r.followUp?.role??null).toBeNull();
 });
});
describe('text and image moderation',()=>{
 it.each(['كسمك','احا','يعم احا بقى كسمكم','كس أمك','ك س م ك','احاا'])('blocks configured Egyptian Arabic abuse locally: %s',async text=>{
  const fetcher=vi.fn<typeof fetch>();
  expect(await new OpenAiModerator('synthetic-key',env,fetcher).check({...context,text})).toEqual({state:'flagged',categories:['harassment']});
  expect(fetcher).not.toHaveBeenCalled();
 });
 it.each(['احاول اوضح سؤالي','عايز اسأل عن الأسعار'])('does not confuse ordinary Arabic with local abuse: %s',async text=>{
  const fetcher=vi.fn<typeof fetch>(async()=>result());
  expect(await new OpenAiModerator('synthetic-key',env,fetcher).check({...context,text})).toEqual({state:'clear',categories:[]});
  expect(fetcher).toHaveBeenCalledOnce();
 });
 it('blocks only configured categories, not complaints, job details or unrelated sensitive categories',async()=>{
  for(const flag of [null,'self-harm','violence',...blockedCategories]){
   const fetcher=vi.fn<typeof fetch>(async()=>result(flag));const check=await new OpenAiModerator('synthetic-key',env,fetcher).check({...context,text:'Synthetic content'});
   expect(check.state).toBe(blockedCategories.includes(flag as typeof blockedCategories[number])?'flagged':'clear');
   expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).model).toBe('omni-moderation-latest');
  }
 });
 it('inspects images and captions using authenticated bounded Meta retrieval without exposing a media URL to OpenAI',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({url:'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123',mime_type:'image/png',file_size:3})).mockResolvedValueOnce(new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}})).mockResolvedValueOnce(result('sexual'));
  expect(await new OpenAiModerator('synthetic-key',env,fetcher).check({...context,type:'image',mediaId:'123',text:'Synthetic caption'})).toMatchObject({state:'flagged',categories:['sexual']});
  const input=JSON.parse(fetcher.mock.calls[2][1]!.body as string).input;
  expect(input).toEqual([{type:'text',text:'Synthetic caption'},{type:'image_url',image_url:{url:'data:image/png;base64,AQID'}}]);
  expect(fetcher.mock.calls[0][0]).toContain('phone_number_id=9001');expect(fetcher.mock.calls[1][1]).toMatchObject({redirect:'error',headers:{Authorization:'Bearer synthetic-token'}});
 });
 it('never downloads customer-controlled URLs or oversized media and treats failures as unavailable, not abuse',async()=>{
  for(const metadata of [{url:'https://attacker.example/image',mime_type:'image/png',file_size:3},{url:'https://lookaside.fbsbx.com/x',mime_type:'image/png',file_size:6000000}]){
   const fetcher=vi.fn(async()=>Response.json(metadata));expect((await new OpenAiModerator('key',env,fetcher).check({...context,type:'image',mediaId:'123'})).state).toBe('unavailable');expect(fetcher).toHaveBeenCalledOnce();
  }
  for(const response of [new Response('',{status:429}),Response.json({results:[]}),Response.json({results:[{categories:{sexual:false}}]})])expect((await new OpenAiModerator('key',env,vi.fn(async()=>response)).check(context)).state).toBe('unavailable');
 });
 it('extracts signed-image metadata including caption without treating it as a text message',()=>{
  const parsed=parseWebhook({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:'9001'},messages:[{id:'image',from:'201000000001',timestamp:'1700000000',type:'image',image:{id:'123',caption:'Synthetic caption'}}]}}]}]});
  expect(parsed.messages[0]).toMatchObject({type:'image',mediaId:'123',text:'Synthetic caption'});
 });
 it('gates AI and sends on the durable moderation result and skips already blocked customers',async()=>{
  const job={id:'job',tenant_id:'tenant',inbound_message_id:'message',lease_token:'lease'};
  const strategy={reply:vi.fn()},sender={send:vi.fn()},moderator={check:vi.fn().mockResolvedValue({state:'flagged',categories:['sexual']})};
  const repository={context:vi.fn().mockResolvedValue(context),moderate:vi.fn().mockResolvedValue(false),prepare:vi.fn()} as unknown as MessagingRepository;
  expect(await processIncomingMessage(job,{repository,strategy,sender,moderator})).toBe('skipped');expect(strategy.reply).not.toHaveBeenCalled();expect(sender.send).not.toHaveBeenCalled();
  vi.mocked(repository.context).mockResolvedValue({...context,blocked:true});moderator.check.mockClear();await processIncomingMessage(job,{repository,strategy,sender,moderator});expect(moderator.check).not.toHaveBeenCalled();
 });
 it('requires authentication for image review and never fetches inaccessible evidence',async()=>{
  const load=vi.fn().mockResolvedValue(null),authenticate=vi.fn().mockResolvedValue(false);const url='https://example.test/api?message=11111111-1111-4111-8111-111111111111';
  expect((await handleBlacklistImage(new Request(url),{load,authenticate})).status).toBe(401);expect(authenticate).not.toHaveBeenCalled();
  expect((await handleBlacklistImage(new Request(url,{headers:{Authorization:'Bearer invalid'}}),{load,authenticate})).status).toBe(401);expect(load).not.toHaveBeenCalled();
  authenticate.mockResolvedValue(true);expect((await handleBlacklistImage(new Request(url,{headers:{Authorization:'Bearer allowed'}}),{load,authenticate})).status).toBe(404);
 });
});
