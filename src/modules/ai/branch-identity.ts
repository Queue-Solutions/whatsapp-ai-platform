import type {KnowledgeSource} from './contracts';

export function branchRecord(source:KnowledgeSource):Record<string,string>|null {
  try{
    const data=JSON.parse(source.content);
    return source.kind==='fact'&&data.category==='branch'&&data.value&&typeof data.value==='object'?data.value:null;
  }catch{return null;}
}
