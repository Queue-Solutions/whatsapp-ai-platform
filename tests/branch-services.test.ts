import {describe,expect,it,vi} from 'vitest';
import {GroundedStrategy} from '../src/modules/ai/grounded-strategy';
import {btcCatalog} from '../src/modules/ai/btc-branches';
import {repairFaqReply} from '../src/modules/ai/repair-faq';
import type {KnowledgeSource} from '../src/modules/ai/contracts';
import type {MessageContext} from '../src/modules/messaging/types';

const branch=(id:string,name:string,enabled:{btc?:boolean;maintenance?:boolean}):KnowledgeSource=>({id,label:id.toUpperCase(),kind:'fact',updatedAt:'2026-10-07',content:JSON.stringify({category:'branch',value:{
  name,city:'Cairo',address:`${name} address`,hours:'Daily: 10:00 AM to 10:00 PM',mapsUrl:`https://maps.app.goo.gl/${id}`,
  btcEnabled:!!enabled.btc,btcHours:enabled.btc?'Daily: 12:00 PM to 8:30 PM':'',btcPhone:enabled.btc?`0120000000${id.length}`:'',
  maintenanceEnabled:!!enabled.maintenance,maintenanceHours:enabled.maintenance?'Daily: 1:00 PM to 9:00 PM':'',
}})});
const legacy:KnowledgeSource={id:'legacy',label:'FAQ',kind:'faq',updatedAt:'2026-09-01',content:JSON.stringify({question:'What information can you provide about BTC?',answer:'IRAM Legacy: 01111111111\nBTC hours: Daily 9 AM to 5 PM'})};
const sources=[branch('one','IRAM One',{btc:true,maintenance:true}),branch('two','IRAM Two',{btc:false,maintenance:true}),legacy];
const base:MessageContext={tenantId:'tenant',conversationId:'chat',requestKey:'request',type:'text',text:'BTC branches?',history:[]};

describe('per-branch service settings',()=>{
  it('makes enabled branch BTC settings authoritative over the legacy FAQ',async()=>{
    const catalog=btcCatalog(sources);expect(catalog?.entries).toEqual([expect.objectContaining({name:'IRAM One',hours:'Daily: 12:00 PM to 8:30 PM'})]);
    expect(catalog?.sources.map(source=>source.id)).toEqual(['one']);
    const complete=vi.fn(),decision=await new GroundedStrategy(async()=>sources,{reserve:vi.fn(),finish:vi.fn()},{complete}).reply(base);
    expect(decision.text).toContain('IRAM One');expect(decision.text).toContain('12:00 PM to 8:30 PM');expect(decision.text).not.toMatch(/IRAM Two|Legacy|01111111111/);expect(complete).not.toHaveBeenCalled();
  });
  it('lists only maintenance-enabled branches with their own hours',()=>{
    const decision=repairFaqReply({...base,text:'Which branches offer maintenance?'},sources,true);
    expect(decision?.text).toContain('IRAM One');expect(decision?.text).toContain('IRAM Two');expect(decision?.text.match(/1:00 PM to 9:00 PM/g)).toHaveLength(2);
    expect(decision?.sources.map(source=>source.id)).toEqual(['one','two']);
  });
});
