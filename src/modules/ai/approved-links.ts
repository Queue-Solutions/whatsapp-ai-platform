import type {KnowledgeSource,AgentDecision} from './contracts';
import type {MessageContext} from '../messaging/types';
import {normalizeIntent} from './branch-scope';
import {sourceRef} from './branch-dialogue';
import {replyLanguage} from './language';

/** Remove prose/Markdown delimiters without removing balanced parentheses inside a URL. */
export function extractUrls(text:string):string[]{
  return (text.match(/https?:\/\/[^\s<>"\\]+/g)??[]).map(raw=>{
    let url=raw.replace(/[.,!؟،]+$/g,'');
    for(const [open,close] of [['(',')'],['[',']']] as const){
      while(url.endsWith(close)&&url.split(close).length>url.split(open).length)url=url.slice(0,-1);
    }
    return url;
  });
}
function strings(value:unknown):string[]{
  if(typeof value==='string')return [value];
  if(value&&typeof value==='object')return Object.values(value).flatMap(strings);
  return [];
}
export function sourceUrls(source:KnowledgeSource){
  try{return strings(JSON.parse(source.content)).flatMap(extractUrls);}catch{return extractUrls(source.content);}
}
function canonical(url:string){
  try{return new URL(url.replace(/%3B/gi,';').replace(/%D8%9B/gi,'؛')).href;}catch{return '';}
}
export function hasUnsupportedLink(text:string,sources:KnowledgeSource[]){
  const approved=new Set(sources.flatMap(sourceUrls).map(canonical).filter(Boolean));
  return extractUrls(text).some(url=>!approved.has(canonical(url)));
}
export function offeredLinks(context:MessageContext,sources:KnowledgeSource[]):AgentDecision|null {
  if(!/^(?:Send the online shopping and official website links\.|ابعت روابط الشراء أونلاين والموقع الرسمي\.)$/.test(context.text??''))return null;
  const relevant=sources.filter(source=>/(?:online|website|social|facebook|instagram|اون ?لاين|موقع|روابط|فيسبوك|انستجرام)/.test(normalizeIntent(source.content)))
    .map(source=>({source,urls:sourceUrls(source).filter(url=>{try{const u=new URL(url);return !/(?:^|\.)(?:google\.com|maps\.google\.com|maps\.app\.goo\.gl|goo\.gl)$/.test(u.hostname);}catch{return false;}})})).filter(s=>s.urls.length);
  if(!relevant.length)return null;
  const urls=[...new Set(relevant.flatMap(s=>s.urls))];
  const text=`${replyLanguage(context.text??'')==='ar'?'دي الروابط المتاحة:':'Here are the available links:'}\n\n${urls.join('\n\n')}`;
  if(text.length>4096)return null;
  return {action:'answer',reason:'approved_knowledge',text,sources:relevant.map(s=>sourceRef(s.source))};
}
