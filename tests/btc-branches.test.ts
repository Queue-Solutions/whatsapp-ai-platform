import {describe,it,expect,vi} from 'vitest';
import {GroundedStrategy} from '../src/modules/ai/grounded-strategy';
import {btcCatalog,btcBranchRecords} from '../src/modules/ai/btc-branches';
import {selectKnowledge} from '../src/modules/ai/knowledge-selection';
import type {KnowledgeSource,AgentDecision} from '../src/modules/ai/contracts';
import type {MessageContext} from '../src/modules/messaging/types';
const names=['IRAM Korba','TJH City stars','IRAM Nox','TJH Mivida','TJH Maadi','IRAM Arkan','IRAM Alex','IRAM Mansoura'];
const cities=['Heliopolis','Nasr City','Fifth Settlement','New Cairo','Maadi','Sheikh Zayed','Roshdy','Mansoura'];
const phones=names.map((_,i)=>`0120000000${i+1}`);
const hours='BTC working hours: Daily from 12:00 PM to 8:30 PM, except Friday from 2:00 PM to 8:30 PM.';
const makeFaq=(answer=names.map((name,i)=>`${name}: ${phones[i]}`).join('\n')+'\n\n'+hours):KnowledgeSource=>({id:'btc-faq',label:'F8',kind:'faq',updatedAt:'2026-09-20',content:JSON.stringify({question:'What information can you provide about your bullion or BTC products?',answer})});
const records:KnowledgeSource[]=[...names,'IRAM ZIA','IRAM El Kawthar'].map((name,i)=>({id:`branch-${i}`,label:`B${i}`,kind:'fact',updatedAt:'2026-09-20',content:JSON.stringify({category:'branch',value:{name:name==='IRAM Mansoura'?'IRAM MANS (Mansoura)':name.toUpperCase(),city:cities[i]??'Other city',address:`${i+1} Fictional Street`,mapsUrl:`https://maps.app.goo.gl/fixture${i}`,phone:'09999999999',hours:'Jewelry hours: 9 AM–10 PM'}})}));
const base:MessageContext={tenantId:'trusted-tenant',conversationId:'test',requestKey:'inbound',type:'text',eligible:true,text:'What are the branches?',history:[{role:'user',content:'BTC'}]};
function fixture(sources=[makeFaq(),...records]){
 const complete=vi.fn(),reserve=vi.fn(),load=vi.fn(async()=>sources);
 return {complete,reserve,load,strategy:new GroundedStrategy(load,{reserve,finish:vi.fn()},{complete})};
}
describe('BTC FAQ is the branch eligibility authority',()=>{
 it('renders exactly the eight FAQ branches, excludes jewelry-only branches and never calls the model',async()=>{
  const f=fixture();const decision=await f.strategy.reply(base);
  expect(decision.action).toBe('answer');expect(decision.text.split('\n').filter(l=>l.startsWith('• '))).toEqual(names.map((n,i)=>`• ${n} — ${cities[i]}`));
  expect(decision.text).not.toMatch(/ZIA|Kawthar|Fictional|https:|09999999999|0120000000/);
  expect(decision.text).toContain('12:00 PM to 8:30 PM');expect(decision.text).toContain('Friday from 2:00 PM to 8:30 PM');
  expect(decision.text.match(/Type the branch/g)).toHaveLength(1);expect(decision.text.match(/For BTC/g)).toHaveLength(1);
  expect(f.complete).not.toHaveBeenCalled();expect(f.reserve).not.toHaveBeenCalled();expect(f.load).toHaveBeenCalledWith('trusted-tenant');
 });
 it.each(names.map((name,i)=>[name,i] as const))('joins %s to its own address/map and the BTC-specific FAQ phone',async(name,i)=>{
  const f=fixture();const decision=await f.strategy.reply({...base,text:`Tell me more about ${name}`});
  expect(decision.text).toContain(`${i+1} Fictional Street`);expect(decision.text).toContain(`https://maps.app.goo.gl/fixture${i}`);expect(decision.text).toContain(`BTC phone: ${phones[i]}`);
  expect(decision.text).not.toMatch(/09999999999|9 AM/);for(const phone of phones.filter(p=>p!==phones[i]))expect(decision.text).not.toContain(phone);
  expect(decision.sources.map(s=>s.id)).toEqual(['btc-faq',`branch-${i}`]);expect(f.complete).not.toHaveBeenCalled();
 });
 it.each([['كوربة',0],['سيتي ستارز',1],['نوكس',2],['ميفيدا',3],['المعادي',4],['أركان',5],['الاسكندرية',6],['المنصورة',7]] as const)('resolves the Arabic branch selection %s without switching the BTC phone',async(text,i)=>{
  const decision=await fixture().strategy.reply({...base,text});expect(decision.text).toContain(phones[i]);expect(decision.text).toContain(`https://maps.app.goo.gl/fixture${i}`);
 });
 it('uses the last selected branch for a phone follow-up',async()=>{
  const decision=await fixture().strategy.reply({...base,text:'And the phone number?',history:[{role:'user',content:'BTC'},{role:'user',content:'IRAM Korba'},{role:'assistant',content:'Here are the branch details.'}]});expect(decision.text).toContain(phones[0]);expect(decision.text).not.toContain(phones[1]);
 });
 it('does not silently treat a jewelry-only branch as eligible for BTC',async()=>{
  const decision=await fixture().strategy.reply({...base,text:'IRAM ZIA address and BTC phone'});
  expect(decision.text).toContain('not listed for BTC');expect(decision.text).not.toMatch(/9 Fictional|fixture8|09999999999/);expect(decision.text.split('\n').filter(l=>l.startsWith('• '))).toHaveLength(8);
 });
 it('does not join NOX to ZIA even when they share a city',async()=>{
  const missingNox=records.filter(s=>s.id!=='branch-2');const decision=await fixture([makeFaq(),...missingNox]).strategy.reply({...base,text:'IRAM Nox'});
  expect(decision.text).toContain(phones[2]);expect(decision.text).toContain('not confirmed');expect(decision.text).not.toMatch(/https:|Fictional/);
 });
 it('does not guess between duplicate branch identities',async()=>{
  const duplicate={...records[0],id:'duplicate',label:'D1',content:JSON.stringify({category:'branch',value:{name:'IRAM Korba (Other site)',address:'Wrong address',mapsUrl:'https://maps.app.goo.gl/wrong'}})};
  const decision=await fixture([makeFaq(),...records,duplicate]).strategy.reply({...base,text:'Korba'});
  expect(decision.text).toContain(phones[0]);expect(decision.text).not.toMatch(/https:|Wrong address|Fictional/);
 });
 it('uses only the matching menu address, even if an FAQ contains another address/link',async()=>{
  const faq=makeFaq(names.map((n,i)=>`${n}: ${phones[i]}`).join('\n')+'\nOld address: 999 Wrong Street https://maps.app.goo.gl/old\n'+hours);
  const decision=await fixture([faq,...records]).strategy.reply({...base,text:'Korba'});
  expect(decision.text).toContain('1 Fictional Street');expect(decision.text).toContain('fixture0');expect(decision.text).not.toContain('999 Wrong');expect(decision.text).not.toContain('/old');
 });
 it('uses current FAQ entries after an edit instead of a previously cached model list',async()=>{
  const f=fixture([makeFaq(`IRAM Korba: ${phones[0]}\n${hours}`),...records]);
  f.reserve.mockResolvedValue({status:'completed',decision:{action:'answer',text:'IRAM ZIA and El Kawthar offer BTC.',reason:'approved_knowledge',sources:[]} as AgentDecision});
  const decision=await f.strategy.reply(base);expect(decision.text.split('\n').filter(l=>l.startsWith('• '))).toHaveLength(1);expect(decision.text).not.toMatch(/ZIA|Kawthar/);expect(f.reserve).not.toHaveBeenCalled();
 });
 it('keeps ineligible branch records and generic directory FAQs out of other BTC model requests',()=>{
  const generic={...makeFaq(),id:'generic',label:'G1',content:JSON.stringify({question:'Where are your branches?',answer:'IRAM ZIA and IRAM El Kawthar.'})};
  const selected=selectKnowledge({...base,text:'What is the BTC price?'},[makeFaq(),...records,generic]).sources;
  expect(selected).toContainEqual(makeFaq());expect(selected.some(s=>['branch-8','branch-9','generic'].includes(s.id))).toBe(false);
 });
 it('fails closed for malformed or conflicting FAQ rows rather than using the general directory',async()=>{
  for(const sources of [[makeFaq('IRAM Korba: not a phone'),...records],[makeFaq(),{...makeFaq(`IRAM Korba: 01299999999\n${hours}`),id:'conflict'},...records],records]){
   const f=fixture(sources),decision=await f.strategy.reply(base);expect(decision.reason).toBe('missing_business_information');expect(decision.text).not.toMatch(/ZIA|Kawthar/);expect(f.complete).not.toHaveBeenCalled();
  }
 });
 it('parses Arabic digits, bullet rows and spacing while keeping the saved phone association',()=>{
  const catalog=btcCatalog([makeFaq('• IRAM Korba : ٠١٢٠٠٠٠٠٠٠١\n'+hours)]);
  expect(catalog?.entries).toEqual([{name:'IRAM Korba',phone:phones[0]}]);
  expect(btcBranchRecords({name:'IRAM Mansoura',phone:phones[7]},records).map(s=>s.id)).toEqual(['branch-7']);
  expect(btcBranchRecords({name:'ارم كوربة',phone:phones[0]},records).map(s=>s.id)).toEqual(['branch-0']);
 });
});
