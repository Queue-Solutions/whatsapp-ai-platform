import type {AgentDecision,KnowledgeSource} from './contracts';
import type {MessageContext} from '../messaging/types';
import {activeBranchRecord,branchData,sourceRef} from './branch-dialogue';
import {matchingBranches,normalizeIntent} from './branch-scope';
import {replyLanguage} from './language';

type ServiceBranch={name?:string;btcEnabled?:boolean;maintenanceEnabled?:boolean};

const btc=/\bbtc\b|\bbullion\b|سبائك|سبيكه/;
const jewelry=/\bjewel(?:ry|lery)\b|مجوهرات|مشغولات/;
const maintenance=/\b(?:maintenance|repair|repairs)\b|صيانه|تصليح/;
const allServices=/\b(?:which|what) services\b|\bservices (?:does|do|are)\b|(?:ايه|ما هي) الخدمات|الخدمات (?:المتاحه|الموجوده)/;
const contrast=/\b(?:only|also|both|or|as well|too)\b|(?:بس|فقط|كمان|ايضا|أيضا|ولا|الاتنين|الاثنين|كلاهما)/;
const standaloneBoth=/^(?:both|all|الاتنين|الاثنين|كلاهما)[.!،,؟? ]*$/;

function joined(items:string[],ar:boolean){
  if(items.length<2)return items[0]??'';
  return ar?`${items.slice(0,-1).join('، ')} و${items.at(-1)}`:`${items.slice(0,-1).join(', ')} and ${items.at(-1)}`;
}

/** Answer service availability from one structured branch record, without guessing or opening a directory. */
export function branchServicesReply(context:MessageContext,sources:KnowledgeSource[]):AgentDecision|null {
  const text=normalizeIntent(context.text??'');
  const mentioned={jewelry:jewelry.test(text),btc:btc.test(text),maintenance:maintenance.test(text)};
  const count=Object.values(mentioned).filter(Boolean).length;
  const broad=allServices.test(text);
  const directMatches=matchingBranches(context.text??'',sources);
  const lastAssistant=[...(context.history??[])].reverse().find(message=>message.role==='assistant')?.content??'';
  const contextualBoth=standaloneBoth.test(text)&&jewelry.test(normalizeIntent(lastAssistant))&&btc.test(normalizeIntent(lastAssistant));
  const asksComparison=(count>=2&&(contrast.test(text)||/[?؟]/.test(text)))||(mentioned.btc&&contrast.test(text))||broad;
  const source=directMatches.length===1&&asksComparison?directMatches[0]:contextualBoth?activeBranchRecord(context,sources):null;
  const value=source?branchData(source) as unknown as ServiceBranch|null:null;
  if(!source||!value?.name?.trim())return null;

  const ar=replyLanguage(context.text??lastAssistant)==='ar';
  const includeAll=broad||mentioned.maintenance;
  const available=ar?['المجوهرات']:['jewelry'];
  const unavailable:string[]=[];
  if(mentioned.btc||contextualBoth||includeAll){
    if(value.btcEnabled===true)available.push(ar?'خدمة BTC والسبائك':'BTC / bullion service');
    else unavailable.push(ar?'خدمة BTC والسبائك':'BTC / bullion service');
  }
  if(includeAll){
    if(value.maintenanceEnabled===true)available.push(ar?'خدمة الصيانة':'maintenance service');
    else unavailable.push(ar?'خدمة الصيانة':'maintenance service');
  }
  const name=value.name.trim();
  const textReply=ar
    ? `${name} يقدم ${joined(available,true)}.${unavailable.length?` أما ${joined(unavailable,true)} فغير مفعلة لهذا الفرع حاليًا.`:''}`
    : `${name} offers ${joined(available,false)}.${unavailable.length?` ${joined(unavailable,false)} ${unavailable.length===1?'is':'are'} not currently enabled for this branch.`:''}`;
  return {action:'answer',reason:'approved_knowledge',text:textReply,sources:[sourceRef(source)]};
}
