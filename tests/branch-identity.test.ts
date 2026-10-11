import {describe,expect,it} from 'vitest';
import {branchRecord} from '../src/modules/ai/branch-identity';
import type {KnowledgeSource} from '../src/modules/ai/contracts';

describe('branch records',()=>{
  it('reads a branch from the single knowledge catalog',()=>{
    const source:KnowledgeSource={id:'branch',label:'B1',kind:'fact',updatedAt:'2026-10-12',
      content:JSON.stringify({category:'branch',value:{name:'IRAM Korba',city:'Heliopolis',address:'Test address',hours:'11am–10pm'}})};
    expect(branchRecord(source)).toMatchObject({name:'IRAM Korba',city:'Heliopolis'});
  });

  it('rejects malformed and non-branch knowledge',()=>{
    const faq:KnowledgeSource={id:'faq',label:'F1',kind:'faq',updatedAt:'2026-10-12',content:'{}'};
    const malformed:KnowledgeSource={id:'bad',label:'K1',kind:'fact',updatedAt:'2026-10-12',content:'not-json'};
    expect(branchRecord(faq)).toBeNull();
    expect(branchRecord(malformed)).toBeNull();
  });
});
