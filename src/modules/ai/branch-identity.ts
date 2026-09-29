import type {KnowledgeSource} from './contracts';
import {locationWords} from './branch-scope';

export function branchRecord(source:KnowledgeSource):Record<string,string>|null {
  try{
    const data=JSON.parse(source.content);
    return source.kind==='fact'&&data.category==='branch'&&data.value&&typeof data.value==='object'?data.value:null;
  }catch{return null;}
}

function mapIdentity(value:string|undefined){
  if(!value?.trim())return '';
  try{
    const url=new URL(value.trim());
    url.hash='';
    for(const key of [...url.searchParams.keys()])if(key==='g_st'||key.startsWith('utm_'))url.searchParams.delete(key);
    url.searchParams.sort();
    url.hostname=url.hostname.toLowerCase();
    url.pathname=url.pathname.replace(/\/$/,'');
    return url.toString();
  }catch{return value.trim().toLowerCase().replace(/[?#].*$/,'').replace(/\/$/,'');}
}
function coordinateIdentity(value:Record<string,string>){
  const latitude=Number(value.latitude),longitude=Number(value.longitude);
  return value.latitude?.trim()&&value.longitude?.trim()&&Number.isFinite(latitude)&&Number.isFinite(longitude)
    ?`${latitude.toFixed(6)},${longitude.toFixed(6)}`:'';
}
function nameIdentity(value:Record<string,string>){
  const ignored=new Set(['iram','tjh','branch','store','mall','hotel','the','el','al','فرع','الفرع','فندق','مول']);
  return locationWords(value.name??'').filter(word=>!ignored.has(word)).join(' ');
}
function sameBranch(first:KnowledgeSource,second:KnowledgeSource){
  const a=branchRecord(first),b=branchRecord(second);if(!a||!b)return false;
  const mapA=mapIdentity(a.mapsUrl),mapB=mapIdentity(b.mapsUrl);
  if(mapA&&mapB&&mapA===mapB)return true;
  const coordinateA=coordinateIdentity(a),coordinateB=coordinateIdentity(b);
  if(coordinateA&&coordinateB)return coordinateA===coordinateB;
  if(mapA&&mapB)return false;
  if(first.identityKey&&second.identityKey&&first.identityKey===second.identityKey)return true;
  const nameA=nameIdentity(a),nameB=nameIdentity(b);
  return !!nameA&&nameA===nameB;
}
function completeness(source:KnowledgeSource){
  const value=branchRecord(source);if(!value)return 0;
  return ['name','city','address','hours','mapsUrl','latitude','longitude'].filter(key=>value[key]?.trim()).length;
}

/** Collapse translated records for one physical location without merging conflicting mapped locations. */
export function deduplicateBranches(sources:KnowledgeSource[],preferredLocale?:string){
  const branches=sources.filter(source=>branchRecord(source));
  const parent=branches.map((_,index)=>index);
  const root=(index:number):number=>parent[index]===index?index:(parent[index]=root(parent[index]));
  const union=(a:number,b:number)=>{a=root(a);b=root(b);if(a!==b)parent[b]=a;};
  for(let first=0;first<branches.length;first++)for(let second=first+1;second<branches.length;second++){
    if(sameBranch(branches[first],branches[second]))union(first,second);
  }
  const groups=new Map<number,KnowledgeSource[]>();
  branches.forEach((source,index)=>{const key=root(index),group=groups.get(key)??[];group.push(source);groups.set(key,group);});
  return [...groups.values()].map(group=>{
    const selected=group.slice().sort((a,b)=>
      Number(b.locale===preferredLocale)-Number(a.locale===preferredLocale)||completeness(b)-completeness(a)
    )[0];
    if(group.length<2)return selected;
    try{
      const data=JSON.parse(selected.content);
      // Keep the preferred localized record for customer-facing fields, while
      // retaining the other approved localization as search-only metadata.
      // This prevents a blank translated city from hiding a branch that has a
      // complete city in its paired record.
      const searchAliases=group.map(source=>branchRecord(source)).filter((value):value is Record<string,string>=>!!value)
        .map(value=>({name:value.name??'',city:value.city??'',address:value.address??''}));
      return {...selected,content:JSON.stringify({...data,searchAliases})};
    }catch{return selected;}
  });
}

/** Keep non-branch knowledge intact while exposing one localized record per physical branch. */
export function deduplicateBranchKnowledge(sources:KnowledgeSource[],preferredLocale?:string){
  const selected=new Set(deduplicateBranches(sources,preferredLocale).map(source=>source.id));
  return sources.filter(source=>!branchRecord(source)||selected.has(source.id));
}
