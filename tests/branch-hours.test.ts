import {describe,expect,it,vi} from 'vitest';
import {asksIfBranchOpenNow,parseWorkingHours} from '../src/modules/ai/branch-hours';
import {GroundedStrategy} from '../src/modules/ai/grounded-strategy';
import type {KnowledgeSource} from '../src/modules/ai/contracts';
import type {MessageContext} from '../src/modules/messaging/types';

const arkan:KnowledgeSource={id:'arkan',label:'ARKAN',kind:'fact',updatedAt:'2026-10-07',content:JSON.stringify({category:'branch',value:{
  name:'IRAM Arkan',city:'6th of October City',address:'Arkan Plaza Mall',mapsUrl:'https://maps.app.goo.gl/arkan',
  hours:'Saturday to Thursday: 11:00 AM to 10:00 PM | Friday: 2:00 PM to 10:00 PM',
  btcEnabled:true,btcHours:'Daily: 12:00 PM to 8:30 PM',btcPhone:'01234567890',
  maintenanceEnabled:true,maintenanceHours:'Daily: 1:00 PM to 9:00 PM',
}})};
const korba:KnowledgeSource={id:'korba',label:'KORBA',kind:'fact',updatedAt:'2026-10-07',content:JSON.stringify({category:'branch',value:{
  name:'IRAM Korba',city:'Heliopolis',address:'Korba address',mapsUrl:'https://maps.app.goo.gl/korba',
  hours:'Daily: 10:00 AM to 11:00 PM',btcEnabled:true,btcHours:'Daily: 12:00 PM to 9:15 PM',btcPhone:'01200000001',
  maintenanceEnabled:false,maintenanceHours:'',
}})};
const base:MessageContext={tenantId:'tenant',conversationId:'chat',requestKey:'message',type:'text',text:'Is IRAM Arkan open now?'};
const strategy=(now:string,sources=[arkan])=>new GroundedStrategy(async()=>sources,{reserve:vi.fn(),finish:vi.fn()},{complete:vi.fn()},'whatsapp',undefined,async()=>{},()=>new Date(now));

describe('live Egypt branch hours',()=>{
  it('parses the dashboard schedule in English and Arabic',()=>{
    expect(parseWorkingHours('Saturday to Thursday: 11:00 AM to 10:00 PM | Friday: 2:00 PM to 10:00 PM')?.size).toBe(7);
    expect(parseWorkingHours('السبت إلى الخميس: 11:00 صباحًا إلى 10:00 مساءً | الجمعة: 2:00 مساءً إلى 10:00 مساءً')?.size).toBe(7);
    expect(asksIfBranchOpenNow('Is IRAM Arkan open on Friday?')).toBe(false);
  });
  it('uses Cairo time and warns when the selected branch closes soon',async()=>{
    const decision=await strategy('2026-01-05T19:15:00Z').reply(base);
    expect(decision.text).toContain('IRAM Arkan is open now');expect(decision.text).toContain('closes at 10:00 PM');expect(decision.text).toContain('head over soon');
  });
  it('states the next opening when the branch is closed',async()=>{
    const decision=await strategy('2026-01-09T21:00:00Z').reply(base);
    expect(decision.text).toContain('closed now');expect(decision.text).toContain('tomorrow at 11:00 AM');
  });
  it('uses the BTC schedule instead of general branch hours in BTC context',async()=>{
    const decision=await strategy('2026-01-05T17:00:00Z').reply({...base,requestKey:'btc',history:[{role:'user',content:'BTC'}]});
    expect(decision.text).toContain('closes at 8:30 PM');expect(decision.text).not.toContain('10:00 PM');
  });
  it('uses the maintenance schedule for a maintenance opening question',async()=>{
    const decision=await strategy('2026-01-05T18:15:00Z').reply({...base,requestKey:'maintenance',text:'Is maintenance at IRAM Arkan open now?'});
    expect(decision.text).toContain('closes at 9:00 PM');expect(decision.text).not.toContain('10:00 PM');
  });
  it('retains the live-status request when semantic routing supplies the branch from context',async()=>{
    const classifyIntent=vi.fn(async()=>({decision:{intent:'branch' as const,confidence:.99,language:'en' as const,product:'jewelry' as const,
      branchMode:'detail' as const,branchDetail:'hours' as const,branchLabels:['ARKAN'],originEvidence:'',originQuery:'',normalizedQuery:'Is this branch open now?',
      analyticsTopic:'branch opening status',summary:'',risk:'none' as const,contactName:'',repeatFollowup:false},input:100,output:20}));
    const usage={reserve:vi.fn(async()=>({status:'new' as const,id:'intent'})),finish:vi.fn()};
    const result=await new GroundedStrategy(async()=>[arkan],usage,{complete:vi.fn(),classifyIntent},'whatsapp',undefined,async()=>{},()=>new Date('2026-01-05T19:15:00Z'))
      .reply({...base,text:'Is this branch opened now?',history:[{role:'user',content:'IRAM Arkan'}]});
    expect(result.text).toContain('IRAM Arkan is open now');expect(result.text).toContain('10:00 PM');
  });
  it('makes the latest selected branch active even when semantic routing repeats an older branch',async()=>{
    const classifyIntent=vi.fn(async()=>({decision:{intent:'branch' as const,confidence:.99,language:'en' as const,product:'btc' as const,
      branchMode:'detail' as const,branchDetail:'hours' as const,branchLabels:['ARKAN'],originEvidence:'',originQuery:'',normalizedQuery:'Is IRAM Arkan open now?',
      analyticsTopic:'branch opening status',summary:'',risk:'none' as const,contactName:'',repeatFollowup:false},input:100,output:20}));
    const usage={reserve:vi.fn(async()=>({status:'new' as const,id:'intent'})),finish:vi.fn()};
    const result=await new GroundedStrategy(async()=>[arkan,korba],usage,{complete:vi.fn(),classifyIntent},'whatsapp',undefined,async()=>{},()=>new Date('2026-01-05T17:00:00Z'))
      .reply({...base,text:'Is it opened now?',history:[
        {role:'user',content:'What are the working hours for IRAM Arkan?'},{role:'assistant',content:'Opening hours for IRAM Arkan: 11:00 AM to 10:00 PM.'},
        {role:'user',content:'Does this branch have BTC?'},{role:'assistant',content:'1. IRAM Nox — New Cairo\n2. TJH Mivida — New Cairo\n3. IRAM Korba — Heliopolis'},
        {role:'user',content:'3'},{role:'assistant',content:'Here are the BTC details for IRAM Korba — Heliopolis.'},
      ]});
    expect(result.text).toContain('IRAM Korba is open now');expect(result.text).toContain('9:15 PM');expect(result.text).not.toContain('IRAM Arkan');
  });
});
