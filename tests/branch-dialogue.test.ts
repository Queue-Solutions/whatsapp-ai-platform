import {describe,it,expect,vi} from 'vitest';
import {GroundedStrategy} from '../src/modules/ai/grounded-strategy';
import {branchScope,matchingBranches} from '../src/modules/ai/branch-scope';
import {buildRequest} from '../src/modules/ai/openai';
import {boundedHistory,resolveContinuation} from '../src/modules/ai/conversation-context';
import {productIntent} from '../src/modules/ai/branch-dialogue';
import {selectKnowledge} from '../src/modules/ai/knowledge-selection';
import {continueFollowUp} from '../src/modules/ai/follow-up';
import {requestsApprovedLinks} from '../src/modules/ai/approved-links';
import type {KnowledgeSource} from '../src/modules/ai/contracts';
import type {MessageContext} from '../src/modules/messaging/types';
const base:MessageContext={tenantId:'tenant',conversationId:'chat',requestKey:'test',type:'text',text:'branches?'};
const branch=(name:string,city:string,label:string):KnowledgeSource=>({id:label,label,kind:'fact',updatedAt:'2026-09-20',content:JSON.stringify({category:'branch',value:{name,city,address:`123 ${name} Street`,hours:'Jewelry: 9am–10pm',phone:'1234567',mapsUrl:`https://maps.app.goo.gl/${label}`}})});
const branches=[branch('IRAM Riverside','Alexandria','B1'),branch('IRAM Senzo Mall','Hurghada','B2'),branch('IRAM El Kawthar','Hurghada','B3')];
const btc:KnowledgeSource={id:'btc-faq',label:'F1',kind:'faq',updatedAt:'2026-09-20',content:JSON.stringify({question:'Where can I buy BTC bullion?',answer:'IRAM Riverside: 01200000001\nBTC working hours: Saturday–Thursday 11am–4pm, Friday closed.'})};
const ledger=()=>({reserve:vi.fn(async()=>({status:'new' as const,id:'reservation'})),finish:vi.fn()});
const history=(product='Jewelry'):MessageContext['history']=>[{role:'user',content:product},{role:'assistant',content:'Type the branch you want for its full address and location link.'}];

describe('product-aware branch navigation',()=>{
 it.each(['branches?','Hurghada address','الغردقة','Alexandria','مواعيد الفروع'])('asks the product before mentioning branches for %s',async text=>{
  const complete=vi.fn(),usage=ledger();
  const decision=await new GroundedStrategy(async()=>branches,usage,{complete}).reply({...base,text});
  expect(decision.reason).toBe('branch_product_clarification');expect(decision.text).toContain('BTC');expect(decision.text).not.toMatch(/Riverside|Senzo|123/);expect(complete).not.toHaveBeenCalled();
 });
 it('keeps the latest customer product choice, ignoring product choices in assistant prose',()=>{
  expect(productIntent({...base,text:'Jewelry',history:[{role:'user',content:'BTC'}]})).toBe('jewelry');
  expect(productIntent({...base,history:[{role:'assistant',content:'Jewelry or BTC?'}]})).toBeNull();
  expect(productIntent({...base,text:'معادي',history:[{role:'assistant',content:'فروع المجوهرات:\n\n• TJH Maadi — Maadi'},{role:'assistant',content:'ممكن توضح طلبك؟'}]})).toBe('jewelry');
  expect(productIntent({...base,text:'BTC or jewelry?'})).toBeNull();
 });
 it.each(['معادي','المعادي','المعادى','معندكوش فرع في المعادي؟'])('resolves the Arabic Maadi selection locally on the first try: %s',async text=>{
  const maadi=branch('TJH Maadi','Maadi','MAADI'),complete=vi.fn(),usage=ledger();
  const directory='فروع المجوهرات:\n\n• TJH Maadi — Maadi\n\nاكتب اسم الفرع اللي يناسبك علشان أبعتلك العنوان الكامل ورابط الموقع.';
  expect(matchingBranches(text,[maadi])).toEqual([maadi]);
  const decision=await new GroundedStrategy(async()=>[maadi],usage,{complete}).reply({...base,text,history:[{role:'assistant',content:directory},{role:'user',content:'معادي'}]});
  expect(decision.action).toBe('answer');expect(decision.text).toContain('TJH Maadi — Maadi');expect(decision.text).toContain('123 TJH Maadi Street');expect(complete).not.toHaveBeenCalled();expect(usage.reserve).not.toHaveBeenCalled();
 });
 it.each([
  ['كوربة','IRAM Korba'],['سيتي ستارز','TJH City Stars'],['ميفيدا','TJH Mivida'],['الكوثر','TJH El Kawthar'],
  ['نوكس','IRAM Nox'],['اركان','IRAM Arkan'],['زيا','IRAM ZIA'],['كمبنسكي','TJH Kempinski Hotel'],['سنزو','TJH Senzo Mall'],
 ] as const)('matches the Arabic branch alias %s to %s', (text,name)=>{
  const source=branch(name,'Cairo','ALIAS');expect(matchingBranches(text,[source])).toEqual([source]);
 });
 it('renders the directory without model-generated addresses, hours, or links and ends with a selection request',async()=>{
  const decision=await new GroundedStrategy(async()=>branches,ledger(),{complete:async()=>({decision:{action:'answer',text:'Our branches are at 123 Riverside Street.',branchLines:['IRAM Riverside: https://maps.app.goo.gl/B1'],sourceLabels:['B1','B2','B3']},input:100,output:30})}).reply({...base,history:history()});
  expect(decision.action).toBe('answer');expect(decision.text).toContain('IRAM Riverside — Alexandria');expect(decision.text).toContain('IRAM Senzo Mall — Hurghada');
  expect(decision.text).not.toMatch(/123|Street|https:|9am/);expect(decision.text).toMatch(/Type the branch.*location link\.$/);
 });
 it.each(['IRAM Riverside','Alexandria','الاسكندرية'])('returns the selected branch address and stored map for %s without a paid model call',async text=>{
  const complete=vi.fn();const decision=await new GroundedStrategy(async()=>branches,ledger(),{complete}).reply({...base,text,history:history()});
  expect(decision.action).toBe('answer');expect(decision.text).toContain('123 IRAM Riverside Street');expect(decision.text).not.toMatch(/ارم|إيرام/);expect(decision.text).toContain('https://maps.app.goo.gl/B1');expect(complete).not.toHaveBeenCalled();
 });
 it('keeps multiple branches in a city as a directory and resolves a specific branch in that city',()=>{
  expect(branchScope({...base,text:'Hurghada address'},branches)).toBe('directory');
  expect(branchScope({...base,text:'الغردقة'},branches)).toBe('directory');
  expect(branchScope({...base,text:'Hurghada Senzo Mall'},branches)).toBe('detail');
 });
 it('resumes a named location after the customer answers the product question',async()=>{
  const decision=await new GroundedStrategy(async()=>branches,ledger(),{complete:vi.fn()}).reply({...base,text:'Jewelry',history:[{role:'user',content:'Alexandria address'},{role:'assistant',content:'Jewelry or BTC products?'}]});
  expect(decision.text).toContain('https://maps.app.goo.gl/B1');
 });
 it('marks missing maps honestly rather than inventing one',async()=>{
  const source={...branches[0],content:JSON.stringify({category:'branch',value:{name:'Riverside',address:'123 Street',mapsUrl:''}})};
  const decision=await new GroundedStrategy(async()=>[source],ledger(),{complete:vi.fn()}).reply({...base,text:'Riverside',history:history()});
  expect(decision.text).toContain('123 Street');expect(decision.text).toContain('not currently available');expect(decision.text).not.toContain('https:');
 });
 it('prioritizes BTC FAQs and excludes general branch hours from both BTC lists and address requests',()=>{
  for(const text of ['BTC branches?','BTC Riverside address','BTC hours?']){
   const c={...base,text};const selection=selectKnowledge(c,[...branches,btc]);expect(selection.sources[0]).toEqual(btc);
   const request=JSON.parse(buildRequest(c,selection.sources));const input=JSON.parse(request.input);
   expect(input.productIntent).toBe('btc');expect(input.approvedSources.filter((s:{label:string})=>s.label.startsWith('B')).every((s:{content:string})=>!s.content.includes('9am'))).toBe(true);
   expect(request.instructions).toContain('BTC availability and BTC service hours MUST come from FAQs');
  }
 });
 it('does not accept general branch citations as proof of BTC availability',async()=>{
  const decision=await new GroundedStrategy(async()=>branches,ledger(),{complete:async()=>({decision:{action:'answer',text:'All branches offer BTC.',sourceLabels:['B1','B2','B3']},input:100,output:30})}).reply({...base,text:'BTC branches?'});
  expect(decision.reason).toBe('missing_business_information');expect(decision.text).not.toContain('All branches');
 });
 it('answers BTC lists with FAQ-specific hours and no addresses',async()=>{
  const decision=await new GroundedStrategy(async()=>[...branches,btc],ledger(),{complete:async()=>({decision:{action:'answer',text:'BTC service: Saturday–Thursday 11am–4pm, Friday closed. Type the branch for its full address.',branchLines:['IRAM Riverside — Alexandria'],sourceLabels:['F1']},input:100,output:30})}).reply({...base,text:'BTC branches?'});
  expect(decision.action).toBe('answer');expect(decision.text).toContain('11am–4pm');expect(decision.text).not.toMatch(/9am|123|https:|Senzo/);expect(decision.text).toMatch(/Type the branch.*BTC phone number\.$/);
 });
});

describe('short replies act on the last assistant offer',()=>{
 it.each(['ياريت','اه','أيوه','ابعت','ماشي','طبعا','فين'])('resolves %s to the online links offer',text=>{
  const context={...base,text,history:[{role:'assistant' as const,content:'تقدر تشتري أونلاين من الموقع الرسمي. تحب أبعتلك الروابط؟'}]};
  expect(resolveContinuation(context).text).toContain('روابط الشراء');
 });
 it.each(['yes','sure','please','send them','where'])('resolves %s in English',text=>{
  expect(resolveContinuation({...base,text,history:[{role:'assistant',content:'You can shop online. Would you like the links?'}]}).text).toContain('Send the online');
 });
 it('moves from the refund policy offer to product routing instead of repeating the policy',async()=>{
  const decision=await new GroundedStrategy(async()=>branches,ledger(),{complete:vi.fn()}).reply({...base,text:'ياريت',history:[{role:'user',content:'ايه سياسة الاسترجاع؟'},{role:'assistant',content:'تقدر تزور أي فرع رسمي. هل تحتاج مساعدة في معرفة أقرب فرع ليك؟'}]});
  expect(decision.reason).toBe('branch_product_clarification');expect(decision.text).not.toContain('استرجاع');
 });
 it.each(['اون لاين','ابعت','ياريت','online','send links'])('does not collect %s as a customer name',text=>{
  expect(continueFollowUp({...base,text,history:[{role:'assistant',content:'ممكن اسمك ورقم التليفون؟'}],followUp:{state:'collecting',name:null,phone:null,reason:'missing_business_information',summary:'Question'}})).toBeNull();
 });
 it('preserves the last long assistant reply and does not substitute stale history when a limit is reached',()=>{
  const long='م'.repeat(3000);
  expect(boundedHistory([{direction:'outbound',body:long},{direction:'inbound',body:'Earlier branch question'}])[1].content).toBe(long);
  expect(boundedHistory([{direction:'outbound',body:'Recent'},{direction:'inbound',body:'x'.repeat(100)},{direction:'outbound',body:'Stale'}],20)).toEqual([{role:'assistant',content:'Recent'}]);
 });
});

describe('approved links and source labels',()=>{
 const website:KnowledgeSource={id:'web',kind:'faq',label:'W1',updatedAt:'2026-09-20',content:JSON.stringify({question:'Could you provide more product photos or additional design options?',answer:'Website: https://shop.example.test/collection.\nInstagram: https://instagram.com/example\nFacebook: https://facebook.com/example'})};
 it('fulfills the screenshot link acceptance from approved FAQs without another offer or model call',async()=>{
  const complete=vi.fn();const decision=await new GroundedStrategy(async()=>[...branches,website],ledger(),{complete}).reply({...base,text:'ابعت',history:[{role:'assistant',content:'تقدر تشتري أونلاين من الموقع الرسمي. تحب أبعتلك الروابط؟'}]});
  expect(decision.action).toBe('answer');expect(decision.text).toContain('https://shop.example.test/collection');expect(decision.text).toContain('https://instagram.com/example');expect(decision.text).not.toContain('تحب');expect(complete).not.toHaveBeenCalled();
 });
 it.each(['عندكم مجوهرات؟','ممكن أشوف الكوليكشن؟','What is your Instagram?','Can I see your jewelry collection?'])('sends all approved collection/social links on the first request: %s',async text=>{
  const complete=vi.fn();const decision=await new GroundedStrategy(async()=>[...branches,website],ledger(),{complete}).reply({...base,text,history:[]});
  expect(decision.action).toBe('answer');expect(decision.text).toContain('https://shop.example.test/collection');expect(decision.text).toContain('https://instagram.com/example');expect(decision.text).toContain('https://facebook.com/example');expect(complete).not.toHaveBeenCalled();
 });
 it('does not turn a jewelry branch request into a collection-links reply',async()=>{
  expect(requestsApprovedLinks('Where is your jewelry branch?')).toBe(false);
 });
 it('does not mistake punctuation or Markdown around approved URLs for an invented link',async()=>{
  const decision=await new GroundedStrategy(async()=>[website],ledger(),{complete:async()=>({decision:{action:'answer',text:'Visit [our website](https://shop.example.test/collection).',sourceLabels:['W1']},input:100,output:30})}).reply({...base,text:'Where can I buy online?'});
  expect(decision.action).toBe('answer');
 });
 it('rejects lookalike and unapproved URL paths even when they contain an approved hostname',async()=>{
  const decision=await new GroundedStrategy(async()=>[website],ledger(),{complete:async()=>({decision:{action:'answer',text:'Visit https://shop.example.test/collect',sourceLabels:['W1']},input:100,output:30})}).reply({...base,text:'Where can I buy online?'});
  expect(decision.reason).toBe('unsupported_link');
 });
 it('restricts generated citations to the actual selected labels',()=>{
  const request=JSON.parse(buildRequest({...base,text:'Online shopping?'},[website]));
  expect(request.text.format.schema.properties.sourceLabels.items.enum).toEqual(['W1']);
 });
 it('treats a named branch during contact collection as navigation instead of saving it as a name',async()=>{
  const decision=await new GroundedStrategy(async()=>branches,ledger(),{complete:vi.fn()}).reply({...base,text:'Alexandria',history:[{role:'user',content:'Jewelry'},{role:'assistant',content:'Could you share your name and phone number?'}],followUp:{state:'collecting',name:null,phone:null,reason:'missing_business_information',summary:'Help requested'}});
  expect(decision.followUp).toBeUndefined();expect(decision.text).toContain('https://maps.app.goo.gl/B1');
 });
});


it('does not replace a product question mentioning a branch with its address',async()=>{
 const complete=vi.fn(async()=>({decision:{action:'clarify' as const,text:'Which ring are you interested in?',sourceLabels:[]},input:100,output:30}));
 const decision=await new GroundedStrategy(async()=>branches,ledger(),{complete}).reply({...base,text:'What wedding rings does Riverside have?',history:history()});
 expect(complete).toHaveBeenCalledOnce();expect(decision.text).not.toContain('123');expect(decision.text).toContain('Which ring');
});
