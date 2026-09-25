import {describe,it,expect,vi} from 'vitest';
import {GroundedStrategy} from '../src/modules/ai/grounded-strategy';
import {branchScope,matchingBranches} from '../src/modules/ai/branch-scope';
import {GeoLocations,coordinates,distanceKm,type LocationResolver} from '../src/modules/ai/branch-location';
import {parseWebhook} from '../src/modules/whatsapp/parser';
import type {KnowledgeSource} from '../src/modules/ai/contracts';
import type {MessageContext} from '../src/modules/messaging/types';
const branch=(id:string,name:string,city:string,latitude:string,longitude:string):KnowledgeSource=>({id,kind:'fact',label:id,updatedAt:'2026-09-20',content:JSON.stringify({category:'branch',value:{name,city,latitude,longitude,address:`${id} Test Road`,mapsUrl:`https://maps.google.com/?q=${latitude},${longitude}`}})});
const branches=[branch('b1','IRAM Korba','Heliopolis','30.09','31.32'),branch('b2','TJH City Stars','Nasr City','30.07','31.35'),branch('b3','Jewelry Only','Obour city','30.1914','31.450548')];
const faq:KnowledgeSource={id:'f8',label:'F8',kind:'faq',updatedAt:'2026-09-20',content:JSON.stringify({question:'What information can you provide about your bullion or BTC products?',answer:'IRAM Korba: 01200000001\nTJH City Stars: 01200000002\nBTC working hours: Daily from 12:00 PM to 8:30 PM, except Friday from 2:00 PM to 8:30 PM.'})};
const base:MessageContext={type:'text',text:'What’s the nearest one for me ?',tenantId:'tenant-a',conversationId:'c1',requestKey:'message:1',history:[{role:'user',content:'BTC'},{role:'assistant',content:'For BTC, these are the branches offering this service: IRAM Korba, TJH City Stars.'}]};
const cityHistory:MessageContext['history']=[...base.history!,{role:'user',content:base.text!},{role:'assistant',content:'Which city or area are you in? Or share your WhatsApp location or a Google Maps pin so I can find a nearby BTC branch.'}];
function fixture(sources=[faq,...branches]){
  const locations:LocationResolver={pin:vi.fn(async text=>coordinates(text)),area:vi.fn(async()=>({label:'Al-Obour',latitude:30.1914,longitude:31.450548}))};
  const complete=vi.fn(),reserve=vi.fn(),load=vi.fn(async()=>sources);
  return {locations,complete,reserve,load,strategy:new GroundedStrategy(load,{reserve,finish:vi.fn()},{complete},'whatsapp',locations)};
}
const classifiedNearest=(normalizedQuery:string,originEvidence='',originQuery='')=>({
  intent:'nearest_branch' as const,confidence:.99,language:'en' as const,product:'btc' as const,branchMode:'nearest' as const,
  branchDetail:'none' as const,branchLabels:[],originEvidence,originQuery,normalizedQuery,summary:'',
});
function classifiedFixture(normalizedQuery:string,locations?:LocationResolver,originEvidence='',originQuery=''){
  const resolver=locations??{pin:vi.fn(async text=>coordinates(text)),area:vi.fn(async()=>({label:'Al-Obour',latitude:30.1914,longitude:31.450548}))};
  const classifyIntent=vi.fn(async()=>({decision:classifiedNearest(normalizedQuery,originEvidence,originQuery),input:180,output:35}));
  const complete=vi.fn(),reserve=vi.fn(async()=>({status:'new' as const,id:'intent-reservation'})),finish=vi.fn();
  const strategy=new GroundedStrategy(async()=>[faq,...branches],{reserve,finish},{complete,classifyIntent},'whatsapp',resolver);
  return {strategy,locations:resolver,classifyIntent,complete,reserve,finish};
}
describe('nearest branch conversation',()=>{
  it.each(['What’s the nearest one for me ?','Which is closest?','أقرب واحد ليا؟'])('asks for origin immediately while preserving BTC: %s',async text=>{
    const f=fixture(),result=await f.strategy.reply({...base,text});
    expect(branchScope({...base,text},[faq,...branches])).toBe('detail');
    expect(result.reason).toBe('nearest_branch_location');expect(result.text).toContain('BTC');expect(result.text).not.toMatch(/clarify your request|jewelry or/);
    expect(f.complete).not.toHaveBeenCalled();expect(f.reserve).not.toHaveBeenCalled();expect(f.locations.area).not.toHaveBeenCalled();
  });
  it('never matches City Stars from the generic word city',()=>{
    expect(matchingBranches('Obour city',branches.slice(0,2))).toEqual([]);
    expect(matchingBranches('city',branches)).toEqual([]);
    expect(matchingBranches('City Stars',branches).map(s=>s.id)).toEqual(['b2']);
    expect(matchingBranches('Nasr City',branches).map(s=>s.id)).toEqual(['b2']);
  });
  it('geocodes an origin, measures eligible branches, and only sends details when selected',async()=>{
    const f=fixture(),result=await f.strategy.reply({...base,text:'Obour city',history:cityHistory});
    expect(f.locations.area).toHaveBeenCalledWith('Obour city',expect.any(Array));
    expect(result.text).toContain('straight-line');expect(result.text).toContain('approximate area centre');expect(result.text).toContain('OpenStreetMap');
    expect(result.text).not.toMatch(/Jewelry Only|Test Road|0120000000|https:/);
    const ranked=branches.slice(0,2).map(s=>({name:JSON.parse(s.content).value.name,distance:distanceKm({latitude:30.1914,longitude:31.450548},JSON.parse(s.content).value)})).sort((a,b)=>a.distance-b.distance);
    expect(result.text.indexOf(ranked[0].name)).toBeLessThan(result.text.indexOf(ranked[1].name));
    expect(f.complete).not.toHaveBeenCalled();expect(f.load).toHaveBeenCalledWith('tenant-a');
    const detail=await f.strategy.reply({...base,text:'TJH City Stars',history:[...cityHistory!,{role:'user',content:'Obour city'},{role:'assistant',content:result.text}]});
    expect(detail.text).toContain('b2 Test Road');expect(detail.text).toContain('01200000002');expect(detail.text).toContain('https://maps.google.com/');
  });
  it('extracts an area from a natural full request instead of asking for it again',async()=>{
    const f=fixture(),text='Thanks, what if im at obour city what would be the nearest branch for me that delivers BTC services ?';
    const result=await f.strategy.reply({...base,text,history:[]});
    expect(f.locations.area).toHaveBeenCalledWith('obour city',expect.any(Array));
    expect(result.text).toContain('straight-line');expect(result.reason).toBe('approved_knowledge');expect(f.complete).not.toHaveBeenCalled();
  });
  it.each([
    ['Told u, obour city !','obour city'],
    ['I already told you: Obour city.','Obour city'],
    ['قلتلك، مدينة العبور!','مدينة العبور'],
  ])('removes conversational correction text before geocoding: %s',async(text,expected)=>{
    const f=fixture(),result=await f.strategy.reply({...base,text,history:cityHistory});
    expect(f.locations.area).toHaveBeenCalledWith(expected,expect.any(Array));
    expect(result.reason).toBe('approved_knowledge');expect(f.complete).not.toHaveBeenCalled();
  });
  it('uses a native WhatsApp pin without sending it to a geocoder',async()=>{
    const f=fixture(),result=await f.strategy.reply({...base,type:'location',text:'geo:30.09,31.32',history:cityHistory});
    expect(result.text).toContain('IRAM Korba — Heliopolis — 0.0 km');expect(result.text).not.toContain('area centre');expect(f.locations.area).not.toHaveBeenCalled();
  });
  it('asks product first, then recovers the origin after the product answer',async()=>{
    const f=fixture();const question=await f.strategy.reply({...base,text:'Nearest branch in Obour city',history:[]});
    expect(question.reason).toBe('branch_product_clarification');
    const result=await f.strategy.reply({...base,text:'BTC',history:[{role:'user',content:'Nearest branch in Obour city'},{role:'assistant',content:question.text}]});
    expect(result.text).toContain('straight-line');expect(f.locations.area).toHaveBeenCalledWith('Obour city',expect.any(Array));
  });
  it('includes jewelry-only branches when the customer explicitly switches to jewelry',async()=>{
    const f=fixture(),result=await f.strategy.reply({...base,text:'Nearest jewelry branch in Obour city'});
    expect(result.text).toContain('Jewelry Only — Obour city — 0.0 km');
  });
  it('does not silently claim complete coverage with missing branch coordinates',async()=>{
    const missing={...branches[1],content:JSON.stringify({category:'branch',value:{name:'TJH City Stars',city:'Nasr City',address:'Missing coordinates',mapsUrl:''}})};
    const f=fixture([faq,branches[0],missing]),result=await f.strategy.reply({...base,text:'Obour city',history:cityHistory});
    expect(result.text).toContain('could be closer');expect(result.text).not.toContain('TJH City Stars');
  });
  it('asks for a pin on ambiguous or unavailable geocoding instead of invoking the model',async()=>{
    const f=fixture();vi.mocked(f.locations.area).mockResolvedValue(null);
    const result=await f.strategy.reply({...base,text:'Obour city',history:cityHistory});
    expect(result.action).toBe('clarify');expect(result.text).toContain('Google Maps pin');expect(result.text).not.toContain('City Stars');expect(f.complete).not.toHaveBeenCalled();
  });
  it('does not carry a proximity request into an unrelated price question',async()=>{
    const f=fixture();f.reserve.mockResolvedValue({status:'reserved'});
    await f.strategy.reply({...base,text:'What is the gold price?',history:cityHistory});
    expect(f.locations.area).not.toHaveBeenCalled();
  });
  it('retains tenant source loading and the existing ineligible guard',async()=>{
    const f=fixture(),result=await f.strategy.reply({...base,eligible:false});
    expect(result.action).toBe('suppress');expect(f.load).not.toHaveBeenCalled();expect(f.locations.area).not.toHaveBeenCalled();
  });
});
describe('location provider boundaries',()=>{
  it('uses place coordinates, never map viewport or untrusted URLs',()=>{
    expect(coordinates('https://www.google.com/maps/place/Test/@1,2,12z/data=!3d30.1!4d31.2')).toEqual({latitude:30.1,longitude:31.2});
    for(const input of ['https://www.google.com/maps/@1,2,12z','https://evil.test/?q=30,31','https://google.com.evil.test/maps?q=30,31','https://user:pass@maps.google.com/?q=30,31','geo:91,0','geo:0,181'])expect(coordinates(input)).toBeNull();
  });
  it('follows only bounded Google Maps redirects and caches successful public pins',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(null,{status:302,headers:{location:'https://www.google.com/maps/place/Test/data=!3d30!4d31'}}));
    const locations=new GeoLocations(fetcher);expect(await locations.pin('https://maps.app.goo.gl/test')).toEqual({latitude:30,longitude:31});
    await locations.pin('https://maps.app.goo.gl/test');expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockResolvedValue(new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}}));
    expect(await locations.pin('https://maps.app.goo.gl/other')).toBeNull();expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects similar place names and conflicting same-name cities',async()=>{
    const feature=(name:string,lat:number)=>({type:'Feature',geometry:{type:'Point',coordinates:[31,lat]},properties:{name,type:'city'}});
    const fetcher=vi.fn();
    fetcher.mockResolvedValue(Response.json({features:[feature('High City Al Obour Compound',30)]}));
    expect(await new GeoLocations(fetcher).area('Obour city',[{latitude:30,longitude:31}])).toBeNull();
    fetcher.mockResolvedValue(Response.json({features:[feature('Al-Obour',30),feature('Al-Obour',31)]}));
    expect(await new GeoLocations(fetcher).area('Obour city',[{latitude:30,longitude:31}])).toBeNull();
    fetcher.mockResolvedValue(Response.json({features:[feature('Al-Obour',30)]}));
    expect(await new GeoLocations(fetcher).area('Obour city',[{latitude:30,longitude:31}])).toMatchObject({latitude:30,longitude:31});
    expect(fetcher.mock.calls.at(-1)?.[0].searchParams.get('lang')).toBe('en');
    fetcher.mockResolvedValue(Response.json({features:[feature('العبور',30)]}));
    expect(await new GeoLocations(fetcher).area('مدينة العبور',[{latitude:30,longitude:31}])).toMatchObject({latitude:30,longitude:31});
    expect(fetcher.mock.calls.at(-1)?.[0].searchParams.has('lang')).toBe(false);
  });
  it('never sends unresolved pins, URLs or coordinates to city search',async()=>{
    const fetcher=vi.fn(),locations=new GeoLocations(fetcher);
    for(const text of ['https://maps.app.goo.gl/private-pin','geo:30,31','30.123,31.456','91,181'])expect(await locations.area(text,[{latitude:30,longitude:31}])).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('validates native coordinates without retaining arbitrary location payload fields',()=>{
    const payload=(location:unknown)=>({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:'9001'},messages:[{id:'loc1',from:'201000000001',timestamp:'1789900000',type:'location',location}]}}]}]});
    const parsed=parseWebhook(payload({latitude:30,longitude:31,name:'Ignored untrusted location name'}));
    expect(parsed.messages[0]).toMatchObject({type:'location',text:'geo:30,31'});
    expect(()=>parseWebhook(payload({latitude:91,longitude:31}))).toThrow();expect(()=>parseWebhook(payload(undefined))).toThrow();
  });
});

describe('semantic routing preserves raw nearest-branch locations',()=>{
  it('passes a typed city to the area resolver unchanged',async()=>{
    const f=classifiedFixture('Find the nearest BTC branch to Obour city.');
    const result=await f.strategy.reply({...base,text:'Obour city',requestKey:'semantic-city',history:cityHistory});
    expect(f.classifyIntent).toHaveBeenCalledOnce();expect(f.locations.area).toHaveBeenCalledWith('Obour city',expect.any(Array));
    expect(result.text).toContain('straight-line');expect(f.complete).not.toHaveBeenCalled();
  });
  it('passes native WhatsApp coordinates to the pin resolver unchanged',async()=>{
    const f=classifiedFixture('Find the nearest BTC branch using the shared location.');
    const result=await f.strategy.reply({...base,type:'location',text:'geo:30.09,31.32',requestKey:'semantic-native-pin',history:cityHistory});
    expect(f.locations.pin).toHaveBeenCalledWith('geo:30.09,31.32');expect(result.text).toContain('IRAM Korba — Heliopolis — 0.0 km');
    expect(f.locations.area).not.toHaveBeenCalled();expect(f.complete).not.toHaveBeenCalled();
  });
  it('passes a Google Maps short link to the pin resolver unchanged',async()=>{
    const link='https://maps.app.goo.gl/nHMGU2QsnEAnvA9W8?g_st=iw';
    const locations:LocationResolver={pin:vi.fn(async text=>text===link?{latitude:30.09,longitude:31.32}:coordinates(text)),area:vi.fn()};
    const f=classifiedFixture('Find the nearest BTC branch using the provided Google Maps pin.',locations);
    const result=await f.strategy.reply({...base,text:link,requestKey:'semantic-maps-link',history:cityHistory});
    expect(locations.pin).toHaveBeenCalledWith(link);expect(result.text).toContain('IRAM Korba — Heliopolis — 0.0 km');
    expect(locations.area).not.toHaveBeenCalled();expect(f.complete).not.toHaveBeenCalled();
  });
  it('uses grounded semantic extraction for natural wording and spelling correction',async()=>{
    const text='Could you check the closest BTC branch if I happen to be over by elobour city today?';
    const f=classifiedFixture('Find the nearest BTC branch to Obour City.',undefined,'elobour city','Obour City');
    const result=await f.strategy.reply({...base,text,requestKey:'semantic-natural-origin',history:[]});
    expect(f.locations.area).toHaveBeenCalledWith('Obour City',expect.any(Array));
    expect(result.text).toContain('straight-line');expect(f.complete).not.toHaveBeenCalled();
  });
  it('rejects a classifier location that is not evidenced by the customer message',async()=>{
    const f=classifiedFixture('Find the nearest BTC branch.',undefined,'Obour City','Obour City');
    const result=await f.strategy.reply({...base,text:'Which BTC branch is closest to me?',requestKey:'semantic-ungrounded-origin',history:[]});
    expect(result.reason).toBe('nearest_branch_location');expect(result.text).toContain('Which city or area');
    expect(f.locations.area).not.toHaveBeenCalled();expect(f.complete).not.toHaveBeenCalled();
  });
  it('rejects a semantically unrelated corrected place and safely falls back to the evidenced text',async()=>{
    const text='Find the nearest BTC branch if I am at Cairo.';
    const f=classifiedFixture('Find the nearest BTC branch to Obour City.',undefined,'Cairo','Obour City');
    const result=await f.strategy.reply({...base,text,requestKey:'semantic-wrong-correction',history:[]});
    expect(f.locations.area).toHaveBeenCalledWith('Cairo',expect.any(Array));
    expect(f.locations.area).not.toHaveBeenCalledWith('Obour City',expect.any(Array));
    expect(result.reason).toBe('approved_knowledge');expect(f.complete).not.toHaveBeenCalled();
  });
});
