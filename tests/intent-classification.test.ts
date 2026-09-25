import {describe,expect,it,vi} from 'vitest';
import {buildIntentRequest,type IntentDecision} from '../src/modules/ai/intent-classification';
import {GroundedStrategy} from '../src/modules/ai/grounded-strategy';
import {OpenAiProvider} from '../src/modules/ai/openai';
import {AI_MODEL} from '../src/modules/ai/config';
import type {KnowledgeSource} from '../src/modules/ai/contracts';
import type {Reservation,UsageLedger} from '../src/modules/ai/ledger';
import type {MessageContext} from '../src/modules/messaging/types';

const context:MessageContext={tenantId:'tenant',conversationId:'conversation',requestKey:'message:intent',type:'text',text:'plz kontct me frm nki brnch',eligible:true,
  history:[{role:'assistant',content:'An old returns-policy answer.'}]};
const source=(label:string,data:object,kind:'faq'|'fact'='faq'):KnowledgeSource=>({id:`id-${label}`,label,kind,updatedAt:'2026-09-23T00:00:00Z',content:JSON.stringify(data)});
const branch=source('B1',{category:'branch',value:{name:'IRAM Nox',city:'New Cairo',address:'Nox Mall, New Cairo',hours:'11am–10pm',mapsUrl:'https://maps.app.goo.gl/nox'}},'fact');
const links=source('L1',{question:'Where can I see the collection online?',answer:'Website: https://iram.example/\nInstagram: https://instagram.com/iram'});
const delivery=source('D1',{question:'What is the delivery policy?',answer:'Approved delivery information.'});
const returns=source('R1',{question:'What are your return, exchange, cancellation and refund policies?',answer:'Returns are accepted at any IRAM branch during working hours under the approved policy conditions.'});
const decision=(changes:Partial<IntentDecision>):IntentDecision=>({intent:'business_question',confidence:.98,language:'en',product:'unknown',branchMode:'none',branchDetail:'none',branchLabels:[],originEvidence:'',originQuery:'',normalizedQuery:'What is the delivery policy?',summary:'',...changes});
function ledger():UsageLedger{
  const saved=new Map<string,Reservation>();
  return {
    reserve:vi.fn(async(_tenant,key)=>saved.get(key)??{status:'new' as const,id:key}),
    finish:vi.fn(async(_tenant,id,result)=>{saved.set(id,{status:result.state,id,decision:result.decision??undefined,errorCode:result.error??undefined});}),
  };
}

describe('semantic intent classification',()=>{
  it('sends only a compact capability catalog, never FAQ answers, and constrains branch identifiers',()=>{
    const request=JSON.parse(buildIntentRequest(context,[branch,links]));
    const input=JSON.parse(request.input);
    expect(input.latestCustomerMessage).toBe(context.text);
    expect(input.activeContactCollection).toBe(false);
    expect(input.branchCatalog).toEqual([{label:'B1',name:'IRAM Nox',city:'New Cairo'}]);
    expect(input.faqTopics).toEqual(['Where can I see the collection online?']);
    expect(request.input).not.toContain('https://iram.example');
    expect(request.instructions).toContain('Perform semantic interpretation, not keyword matching');
    expect(request.instructions).toContain('Agreement or acknowledgement expressions');
    expect(request.instructions).toContain('Wanting a return, exchange, cancellation or refund does not by itself prove a complaint');
    expect(request.instructions).toContain('originEvidence must be the exact consecutive words copied from the latest customer message');
    expect(request.text.format.schema.required).toEqual(expect.arrayContaining(['originEvidence','originQuery']));
    expect(request.text.format.schema.properties.branchLabels.items.enum).toEqual(['B1']);
  });

  it('parses the strict classifier response through the production adapter',async()=>{
    const route=decision({intent:'human_followup',branchMode:'detail',branchLabels:['B1'],normalizedQuery:'I need someone from IRAM Nox to contact me.',summary:'Customer requests contact from IRAM Nox.'});
    const fetcher=vi.fn().mockResolvedValue(Response.json({model:AI_MODEL,status:'completed',usage:{input_tokens:300,output_tokens:60},
      output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(route)}]}]}));
    const provider=new OpenAiProvider('fake-key',fetcher);
    await expect(provider.classifyIntent(buildIntentRequest(context,[branch]))).resolves.toEqual({decision:route,input:300,output:60});
  });

  it('lets semantic intent override stale history and starts personal follow-up without an answer-generation call',async()=>{
    const complete=vi.fn(),classifyIntent=vi.fn(async()=>({
      decision:decision({intent:'human_followup',branchMode:'detail',branchLabels:['B1'],normalizedQuery:'I need someone from IRAM Nox to contact me.',summary:'Customer requests a callback from IRAM Nox.'}),input:250,output:50,
    }));
    const strategy=new GroundedStrategy(async()=>[branch,links],ledger(),{complete,classifyIntent});
    const result=await strategy.reply(context);
    expect(result).toMatchObject({action:'clarify',reason:'human_requested',followUp:{state:'collecting'},attentionSummary:'Customer requests a callback from IRAM Nox.'});
    expect(await strategy.reply(context)).toEqual(result);expect(classifyIntent).toHaveBeenCalledOnce();expect(complete).not.toHaveBeenCalled();
  });

  it('never revives a completed personal-contact request from history when the latest message is only a greeting',async()=>{
    const complete=vi.fn(),classifyIntent=vi.fn(async()=>({
      decision:decision({intent:'human_followup',normalizedQuery:'Hi',summary:'Customer greeted and previously requested personal contact.'}),input:250,output:50,
    }));
    const loadSources=vi.fn(async()=>[branch,links]);const usage=ledger();
    const strategy=new GroundedStrategy(loadSources,usage,{complete,classifyIntent});
    const result=await strategy.reply({...context,text:'Hi',history:[
      {role:'user',content:'Can I reach someone?'},
      {role:'assistant',content:'Could you share your name and the best phone number to contact you on?'},
      {role:'user',content:'Ziad 01067945993'},
      {role:'assistant',content:'Thank you, I’ve saved your name and contact number. Someone from IRAM will contact you personally shortly.'},
    ]});
    expect(result).toMatchObject({action:'clarify',reason:'social_greeting'});
    expect(result.followUp).toBeUndefined();expect(result.attentionSummary).toBeUndefined();
    expect(loadSources).not.toHaveBeenCalled();expect(classifyIntent).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();
    expect(usage.reserve).not.toHaveBeenCalled();expect(usage.finish).not.toHaveBeenCalled();
  });

  it('welcomes once, then answers wellbeing messages naturally without repeating onboarding',async()=>{
    const classifyIntent=vi.fn(),complete=vi.fn(),loadSources=vi.fn();
    const strategy=new GroundedStrategy(loadSources,ledger(),{complete,classifyIntent});
    const first=await strategy.reply({...context,requestKey:'greeting-1',text:'Hi',history:[]});
    expect(first.text).toContain('Welcome to IRAM');expect(first.text).toContain('jewelry or BTC');
    const history=[{role:'user' as const,content:'Hi'},{role:'assistant' as const,content:first.text}];
    const second=await strategy.reply({...context,requestKey:'greeting-2',text:'How are u ?',history});
    expect(second.text).toContain('doing well');expect(second.text).not.toContain('Welcome to IRAM');expect(second.text).not.toContain('jewelry or BTC');
    const third=await strategy.reply({...context,requestKey:'greeting-3',text:'How are you doing ?',history:[...history,{role:'user',content:'How are u?'},{role:'assistant',content:second.text}]});
    expect(third.text).toContain('doing well');expect(third.text).not.toContain('Welcome to IRAM');expect(third.text).not.toContain('jewelry or BTC');
    expect(loadSources).not.toHaveBeenCalled();expect(classifyIntent).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();
  });

  it('keeps AI-recognized greeting variants context-aware instead of replaying onboarding',async()=>{
    const classifyIntent=vi.fn(async()=>({decision:decision({intent:'greeting',normalizedQuery:'How are you?'}),input:200,output:30}));
    const strategy=new GroundedStrategy(async()=>[branch],ledger(),{complete:vi.fn(),classifyIntent});
    const result=await strategy.reply({...context,text:'hw r u',history:[{role:'assistant',content:'Welcome to IRAM.'}]});
    expect(result).toMatchObject({reason:'social_greeting'});expect(result.text).toContain('doing well');expect(result.text).not.toContain('jewelry or BTC');
    expect(classifyIntent).toHaveBeenCalledOnce();
  });

  it('routes a misspelled online-shopping request to exact approved links',async()=>{
    const complete=vi.fn();
    const strategy=new GroundedStrategy(async()=>[links],ledger(),{complete,classifyIntent:vi.fn(async()=>({
      decision:decision({intent:'online_links',normalizedQuery:'I want to shop online.'}),input:220,output:35,
    }))});
    const result=await strategy.reply({...context,text:'wana by onlne'});
    expect(result.action).toBe('answer');expect(result.text).toContain('https://iram.example');expect(result.text).toContain('https://instagram.com/iram');
    expect(complete).not.toHaveBeenCalled();
  });

  it('uses approved branch identifiers to render exact records instead of model-written branch facts',async()=>{
    const complete=vi.fn();
    const strategy=new GroundedStrategy(async()=>[branch],ledger(),{complete,classifyIntent:vi.fn(async()=>({
      decision:decision({intent:'branch',language:'ar',product:'jewelry',branchMode:'detail',branchDetail:'address',branchLabels:['B1'],normalizedQuery:'عايز عنوان فرع نوكس'}),input:220,output:40,
    }))});
    const result=await strategy.reply({...context,text:'عنون فرع نوكي'});
    expect(result.text).toContain('IRAM Nox — New Cairo');expect(result.text).toContain('Nox Mall, New Cairo');expect(result.text).toContain('https://maps.app.goo.gl/nox');
    expect(complete).not.toHaveBeenCalled();
  });

  it('clarifies an unresolved specific branch instead of converting it into an all-branches request',async()=>{
    const complete=vi.fn();
    const strategy=new GroundedStrategy(async()=>[branch],ledger(),{complete,classifyIntent:vi.fn(async()=>({
      decision:decision({intent:'branch',language:'ar',product:'jewelry',branchMode:'detail',branchDetail:'address',branchLabels:[],normalizedQuery:'عايز عنوان الفرع الغير واضح'}),input:220,output:40,
    }))});
    const result=await strategy.reply({...context,text:'عايز عنوان فرع نوكييي غريب'});
    expect(result).toMatchObject({action:'clarify',reason:'reply_scope_clarification'});expect(result.text).not.toContain('Nox Mall');expect(complete).not.toHaveBeenCalled();
  });

  it('preserves the requested branch detail instead of turning every branch intent into an address request',async()=>{
    const complete=vi.fn(async(request:string)=>{
      const input=JSON.parse(JSON.parse(request).input);expect(input.approvedSources[0].label).toBe('B1');
      return {decision:{action:'answer' as const,text:'IRAM Nox opens from 11am to 10pm.',summary:'',branchLines:[],sourceLabels:['B1']},input:350,output:45};
    });
    const strategy=new GroundedStrategy(async()=>[branch],ledger(),{complete,classifyIntent:vi.fn(async()=>({
      decision:decision({intent:'branch',product:'jewelry',branchMode:'detail',branchDetail:'hours',branchLabels:['B1'],normalizedQuery:'What are the opening hours for IRAM Nox?'}),input:220,output:40,
    }))});
    const result=await strategy.reply({...context,text:'nox opning ours'});
    expect(result.text).toBe('IRAM Nox opens from 11am to 10pm.');expect(result.text).not.toContain('Nox Mall');expect(complete).toHaveBeenCalledOnce();
  });

  it('uses the corrected semantic query for retrieval while preserving the original message for generation',async()=>{
    const unrelated=Array.from({length:55},(_,index)=>source(`U${index}`,{question:`Unrelated topic ${index}`,answer:'Other information.'}));
    const complete=vi.fn(async(request:string)=>{
      const input=JSON.parse(JSON.parse(request).input);
      expect(input.customerMessage).toBe('wat is delivry polcy');
      expect(input.interpretedRequest).toBe('What is the delivery policy?');
      expect(input.approvedSources[0].label).toBe('D1');
      return {decision:{action:'answer' as const,text:'Approved delivery information.',summary:'',branchLines:[],sourceLabels:['D1']},input:400,output:50};
    });
    const strategy=new GroundedStrategy(async()=>[...unrelated,delivery],ledger(),{complete,classifyIntent:vi.fn(async()=>({decision:decision({}),input:220,output:35}))});
    const result=await strategy.reply({...context,text:'wat is delivry polcy'});
    expect(result).toMatchObject({action:'answer',reason:'approved_knowledge'});expect(complete).toHaveBeenCalledOnce();
  });

  it('answers a misspelled return request from only the approved returns FAQ instead of opening personal follow-up',async()=>{
    const complete=vi.fn(async(request:string)=>{
      const body=JSON.parse(request),input=JSON.parse(body.input);
      expect(input.classifiedIntent).toBe('returns');
      expect(input.customerMessage).toBe('I wanted to return a bravelet i got from u guyz');
      expect(input.approvedSources).toEqual([{label:'R1',content:returns.content}]);
      expect(body.instructions).toContain('A straightforward request such as "I want to return a bracelet" is not a complaint');
      return {decision:{action:'answer' as const,text:'You can return the bracelet at any IRAM branch during working hours, subject to the approved policy conditions.',summary:'',branchLines:[],sourceLabels:['R1']},input:410,output:55};
    });
    const strategy=new GroundedStrategy(async()=>[branch,delivery,returns],ledger(),{complete,classifyIntent:vi.fn(async()=>({
      decision:decision({intent:'returns',normalizedQuery:'I want to return a bracelet I purchased.'}),input:230,output:35,
    }))});
    const result=await strategy.reply({...context,text:'I wanted to return a bravelet i got from u guyz'});
    expect(result).toMatchObject({action:'answer',reason:'approved_knowledge'});
    expect(result.followUp).toBeUndefined();expect(result.attentionSummary).toBeUndefined();expect(complete).toHaveBeenCalledOnce();
  });

  it('keeps a reported damaged purchase on the complaint path',async()=>{
    const complete=vi.fn();
    const strategy=new GroundedStrategy(async()=>[returns],ledger(),{complete,classifyIntent:vi.fn(async()=>({
      decision:decision({intent:'complaint',normalizedQuery:'My bracelet arrived damaged and I want a refund.',summary:'Customer reports a damaged bracelet and requests a refund.'}),input:230,output:35,
    }))});
    const result=await strategy.reply({...context,text:'bracelet came brokn and i need my money back'});
    expect(result).toMatchObject({action:'clarify',reason:'complaint',followUp:{state:'collecting'}});
    expect(result.attentionSummary).toContain('damaged bracelet');expect(complete).not.toHaveBeenCalled();
  });
});
