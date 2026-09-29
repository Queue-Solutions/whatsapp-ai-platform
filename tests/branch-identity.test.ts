import {describe,expect,it} from 'vitest';
import {deduplicateBranches} from '../src/modules/ai/branch-identity';
import type {KnowledgeSource} from '../src/modules/ai/contracts';

function branch(id:string,name:string,mapsUrl='',locale?:string,identityKey?:string):KnowledgeSource {
  return {id,label:id,kind:'fact',updatedAt:'2026-09-28',locale,identityKey,
    content:JSON.stringify({category:'branch',value:{name,city:'Test city',address:'Test address',hours:'9–5',mapsUrl}})};
}

describe('canonical branch identity',()=>{
  it('collapses localized records by map identity and prefers the customer locale',()=>{
    const sources=[branch('en','Downtown showroom','https://maps.app.goo.gl/location?g_st=iw','en','branch:en'),
      branch('ar','فرع وسط البلد','https://maps.app.goo.gl/location','ar','branch:ar')];
    expect(deduplicateBranches(sources,'ar').map(source=>source.id)).toEqual(['ar']);
    expect(deduplicateBranches(sources,'en').map(source=>source.id)).toEqual(['en']);
  });
  it('retains approved alternate-language locations as search metadata',()=>{
    const english={...branch('en','IRAM ZIA','https://maps.app.goo.gl/zia','en','branch:en'),content:JSON.stringify({category:'branch',value:{name:'IRAM ZIA',city:'New Cairo',address:'South 90th Street',hours:'9–5',mapsUrl:'https://maps.app.goo.gl/zia'}})};
    const arabic={...branch('ar','ارم زايا','https://maps.app.goo.gl/zia','ar','branch:ar'),content:JSON.stringify({category:'branch',value:{name:'ارم زايا',city:'',address:'شارع التسعين الجنوبي',hours:'9–5',mapsUrl:'https://maps.app.goo.gl/zia'}})};
    const selected=deduplicateBranches([english,arabic],'ar')[0],data=JSON.parse(selected.content);
    expect(selected.id).toBe('ar');expect(data.value.city).toBe('');
    expect(data.searchAliases).toEqual(expect.arrayContaining([expect.objectContaining({name:'IRAM ZIA',city:'New Cairo'}),expect.objectContaining({name:'ارم زايا',city:''})]));
  });
  it('uses shared fact identity when translations have no common location fields',()=>{
    const sources=[branch('en','English display name','','en','branch:shared'),branch('ar','اسم عربي مختلف','','ar','branch:shared')];
    expect(deduplicateBranches(sources,'ar').map(source=>source.id)).toEqual(['ar']);
  });
  it('normalizes known bilingual branch names only as a fallback for mapless records',()=>{
    const sources=[branch('en','TJH Kempinski Hotel','','en','branch:en'),branch('ar','TJH فندق كمبينسكي','','ar','branch:ar')];
    expect(deduplicateBranches(sources,'ar').map(source=>source.id)).toEqual(['ar']);
  });
  it('never merges identically named records with conflicting map identities',()=>{
    const sources=[branch('one','IRAM Riverside','https://maps.app.goo.gl/one'),branch('two','IRAM Riverside','https://maps.app.goo.gl/two')];
    expect(deduplicateBranches(sources)).toHaveLength(2);
  });
});
