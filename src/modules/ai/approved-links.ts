import type {KnowledgeSource,AgentDecision} from './contracts';
import type {MessageContext} from '../messaging/types';
import {normalizeIntent} from './branch-scope';
import {sourceRef} from './branch-dialogue';
import {replyLanguage} from './language';

const canonicalLinkRequest=/^(?:Send the online shopping and official website links\.|ابعت روابط الشراء أونلاين والموقع الرسمي\.)$/;

/** Direct requests should receive the approved destinations immediately, without an offer/confirmation turn. */
export function requestsApprovedLinks(text:string):boolean {
  if(canonicalLinkRequest.test(text))return true;
  const normalized=normalizeIntent(text);
  const social=/(?:\b(?:website|web site|instagram|facebook|social (?:media|network|accounts?|pages?)|official (?:site|accounts?|pages?)|links?)\b|موقع|الموقع|انستجرام|انستغرام|فيسبوك|فيس بوك|سوشيال ميديا|مواقع التواصل|حسابات التواصل|صفحاتكم|روابطكم)/.test(normalized);
  if(social)return true;
  const collection=/(?:\b(?:show|see|view|browse|look at|photos?|pictures?|designs?|catalog(?:ue)?|collection|jewel(?:ry|lery))\b|اشوف|أشوف|نشوف|شوف|وريني|صور|تصاميم|تشكيله|تشكيلة|كوليكشن|مجوهرات)/.test(normalized);
  const request=/(?:\b(?:can|could|want|wanna|would like|where|what|send|show|see|view|browse|have|your)\b|ممكن|عايز|عاوز|حابب|فين|ايه|ابعت|ابعث|وريني|عندكم|بتبيعوا|اشوف|أشوف)/.test(normalized);
  const branchRequest=/(?:\b(?:branch|branches|location|address|hours|nearest|closest)\b|فرع|فروع|عنوان|عناوين|مواعيد|اقرب|أقرب)/.test(normalized);
  return collection&&request&&!branchRequest;
}

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
  if(!requestsApprovedLinks(context.text??''))return null;
  const relevant=sources.filter(source=>/(?:online|website|social|facebook|instagram|اون ?لاين|موقع|روابط|فيسبوك|انستجرام)/.test(normalizeIntent(source.content)))
    .map(source=>({source,urls:sourceUrls(source).filter(url=>{try{const u=new URL(url);return !/(?:^|\.)(?:google\.com|maps\.google\.com|maps\.app\.goo\.gl|goo\.gl)$/.test(u.hostname);}catch{return false;}})})).filter(s=>s.urls.length);
  if(!relevant.length)return null;
  const urls=[...new Set(relevant.flatMap(s=>s.urls))];
  const ar=replyLanguage(context.text??'')==='ar';
  const linkLine=(url:string)=>{
    let host='';try{host=new URL(url).hostname.toLowerCase();}catch{}
    const label=host.includes('instagram')?(ar?'إنستجرام':'Instagram'):host.includes('facebook')?(ar?'فيسبوك':'Facebook'):(ar?'موقعنا':'Website');
    return `${label}: ${url}`;
  };
  const text=`${ar?'تقدر تشوف تشكيلاتنا وكل جديد هنا:':'You can view our collections and latest designs here:'}\n\n${urls.map(linkLine).join('\n\n')}`;
  if(text.length>4096)return null;
  return {action:'answer',reason:'approved_knowledge',text,sources:relevant.map(s=>sourceRef(s.source))};
}
