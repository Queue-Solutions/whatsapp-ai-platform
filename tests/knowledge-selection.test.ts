import { describe, expect, it, vi } from 'vitest';
import { selectKnowledge, selectReturnsKnowledge } from '../src/modules/ai/knowledge-selection';
import { buildRequest } from '../src/modules/ai/openai';
import { GroundedStrategy } from '../src/modules/ai/grounded-strategy';
import { MAX_KNOWLEDGE_BYTES, MAX_REQUEST_BYTES } from '../src/modules/ai/config';
import type { KnowledgeSource } from '../src/modules/ai/contracts';
import type { MessageContext } from '../src/modules/messaging/types';

const context: MessageContext = { tenantId:'trusted-tenant', conversationId:'test', requestKey:'test', type:'text', text:'ur branches?', eligible:true, history:[{role:'user',content:'Jewelry'}] };
const source = (n: number, data: object, kind: 'faq'|'fact' = 'faq'): KnowledgeSource => ({
  id:`source-${n}`, label:`K${n}`, kind, updatedAt:'2026-09-16T00:00:00Z', content:JSON.stringify(data),
});
const branches = Array.from({length:9}, (_,i) => source(i+1, {category:'branch',value:{name:`Test area ${i}`,address:`${i} Fictional Street`,hours:'9am–5pm',exceptions:'Closed Fridays'}}, 'fact'));
const faqs = Array.from({length:16}, (_,i) => source(i+10, {question:`Product ${i} details?`,answer:'Fictional product information. '.repeat(30)}));

describe('bounded approved knowledge selection', () => {
  it.each(['ur branches?', 'Where are your locations?', 'فين فروعكم؟', 'عناوين الفروع'])('keeps all nine branches from an oversized corpus for %s', text => {
    const available = [...faqs,...branches];
    const selection = selectKnowledge({...context,text},available);
    expect(selection.sources.filter(s=>s.kind==='fact')).toEqual(expect.arrayContaining(branches));
    expect(selection.coverage).toMatchObject({branchDirectoryComplete:true});
    expect(selection.coverage.omittedSourceCount).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(selection.sources.map(({label,content})=>({label,content}))))).toBeLessThanOrEqual(MAX_KNOWLEDGE_BYTES);
    expect(Buffer.byteLength(buildRequest({...context,text},selection.sources,selection.coverage))).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
  });
  it('reaches the provider and cites original versions when the full corpus is too large', async () => {
    const productContext={...context,text:'What are the Product 0 details?',history:[]};
    const complete=vi.fn(async(request:string)=>{
      const input=JSON.parse(JSON.parse(request).input);
      expect(input.approvedSources).toHaveLength(selectKnowledge(productContext,[...faqs,...branches]).sources.length);
      return {decision:{action:'answer' as const,text:'Approved Product 0 details.',sourceLabels:['K10']},input:1500,output:50};
    });
    const load=vi.fn(async()=>[...faqs,...branches]);
    const ledger={reserve:vi.fn(async()=>({status:'new' as const,id:'reservation'})),finish:vi.fn()};
    const result=await new GroundedStrategy(load,ledger,{complete}).reply(productContext);
    expect(result).toMatchObject({action:'answer',reason:'approved_knowledge',sources:[{id:faqs[0].id,kind:'faq',updatedAt:faqs[0].updatedAt}]});
    expect(load).toHaveBeenCalledWith('trusted-tenant');expect(complete).toHaveBeenCalledOnce();expect(ledger.finish).toHaveBeenCalledOnce();
  });
  it('ranks an Arabic price question above unrelated content across more than 40 sources', () => {
    const relevant=source(100,{question:'What are your prices?',answer:'The test item costs 20.'});
    const many=Array.from({length:80},(_,i)=>source(i+1,{question:`Topic ${i}`,answer:'Other approved content.'}));
    const selection=selectKnowledge({...context,text:'الاسعار كام؟'},[...many,relevant]);
    expect(selection.sources[0]).toEqual(relevant);expect(selection.sources.length).toBeLessThanOrEqual(40);
  });
  it.each([
    ['What is your delivry policy?','What is your delivery policy?'],
    ['ايه سياسه الاسترجاغ؟','ما هي سياسة الاسترجاع؟'],
  ])('uses typo-tolerant retrieval for %s without changing approved facts', (text,question) => {
    const relevant=source(100,{question,answer:'Approved policy text.'});
    const many=Array.from({length:80},(_,i)=>source(i+1,{question:`Unrelated topic ${i}`,answer:'Other approved content.'}));
    expect(selectKnowledge({...context,text},[...many,relevant]).sources[0]).toEqual(relevant);
  });
  it('isolates approved returns-policy FAQs from unrelated knowledge',()=>{
    const returns=source(100,{question:'What are your return, exchange, cancellation and refund policies?',answer:'Approved returns policy.'});
    const delivery=source(101,{question:'What is your delivery policy?',answer:'Approved delivery policy.'});
    const selection=selectReturnsKnowledge({...context,text:'I want to return a bracelet'},[delivery,...branches,returns]);
    expect(selection.sources).toEqual([returns]);
    expect(selection.coverage).toEqual({omittedSourceCount:0,branchDirectoryComplete:true});
  });
  it('uses the named branch and recent customer history for a short follow-up', () => {
    const target=source(100,{category:'branch',value:{name:'Riverside',address:'River Road',hours:'10am–6pm'}},'fact');
    const available=[...faqs,...branches,target];
    expect(selectKnowledge({...context,text:'Riverside branch hours?'},available).sources[0]).toEqual(target);
    expect(selectKnowledge({...context,text:'And on Friday?',history:[{role:'user',content:'Riverside'}]},available).sources).toContainEqual(target);
  });
  it('never truncates a long policy and marks an incomplete branch directory', () => {
    const oversized=source(100,{category:'branch',value:{name:'Long branch',exceptions:'Exception. '.repeat(1500)}},'fact');
    const selection=selectKnowledge(context,[oversized,...branches]);
    expect(selection.sources).not.toContainEqual(oversized);
    expect(selection.sources).toEqual(expect.arrayContaining(branches));
    expect(selection.coverage).toEqual({omittedSourceCount:1,branchDirectoryComplete:false});
    const request=JSON.parse(buildRequest(context,selection.sources,selection.coverage));
    expect(JSON.parse(request.input).knowledgeCoverage.branchDirectoryComplete).toBe(false);
    expect(request.instructions).toContain('Never claim a partial list is exhaustive');
  });
  it('fits the actual serialized request with escaped content and long history', () => {
    const escaped=Array.from({length:30},(_,i)=>source(i+1,{question:'Branch?',answer:'"\\\n'.repeat(50)}));
    const longContext={...context,text:'branches? '.repeat(340),history:[{role:'user' as const,content:'Previous context. '.repeat(140)}]};
    const selection=selectKnowledge(longContext,escaped);
    expect(selection.sources.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(buildRequest(longContext,selection.sources,selection.coverage))).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    for(const selected of selection.sources)expect(escaped).toContainEqual(selected);
  });
  it('checks cached citations against all current approved sources, and rejects omitted-source citations from new answers', async () => {
    const available=[...faqs,...branches];
    const productContext={...context,text:'What are the Product 0 details?',history:[]};
    const omitted=faqs.find(s=>!selectKnowledge(productContext,available).sources.includes(s))!;
    const cached={action:'answer' as const,text:'An earlier answer.',reason:'approved_knowledge',sources:[{id:omitted.id,kind:omitted.kind,updatedAt:omitted.updatedAt}]};
    const complete=vi.fn();
    expect(await new GroundedStrategy(async()=>available,{reserve:async()=>({status:'completed',decision:cached}),finish:vi.fn()},{complete}).reply(productContext)).toEqual(cached);
    expect(complete).not.toHaveBeenCalled();
    const result=await new GroundedStrategy(async()=>available,{reserve:async()=>({status:'new',id:'test'}),finish:vi.fn()},
      {complete:async()=>({decision:{action:'answer',text:'Unsupported.',sourceLabels:[omitted.label]},input:100,output:10})}).reply(productContext);
    expect(result.reason).toBe('invalid_source_reference');
  });
});
