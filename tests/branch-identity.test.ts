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
