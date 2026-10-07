import type {AgentDecision,KnowledgeSource} from './contracts';
import type {MessageContext} from '../messaging/types';
import {branchData,orderedBranchSources,productIntent,sourceRef} from './branch-dialogue';
import {matchingBranches,normalizeIntent} from './branch-scope';
import {replyLanguage} from './language';
import {isRepairEnquiry,repairBranchCatalog,repairBranchRecords} from './repair-faq';
import {btcBranchRecords,btcCatalog} from './btc-branches';

type Period={open:number;close:number};
type Schedule=Map<number,Period[]>;
const dayNames=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const dayNamesAr=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const dayPatterns=[
  /^(?:sunday|sun|الاحد)(?=\s|$|:)/,/^(?:monday|mon|الاثنين)(?=\s|$|:)/,/^(?:tuesday|tue|الثلاثاء)(?=\s|$|:)/,
  /^(?:wednesday|wed|الاربعاء)(?=\s|$|:)/,/^(?:thursday|thu|الخميس)(?=\s|$|:)/,/^(?:friday|fri|الجمعه)(?=\s|$|:)/,/^(?:saturday|sat|السبت)(?=\s|$|:)/,
];

export function asksIfBranchOpenNow(text:string){
  const value=normalizeIntent(text);
  return /\b(?:open|opened)\s+(?:right\s+)?now\b|\bcurrently\s+open\b|\b(?:is|are)\b.{0,70}\bopen(?:ed)?\s+(?:right\s+)?(?:now|today)\b|(?:فاتح|فاتحين|مفتوح|مفتوحين|شغال|شغالين).{0,25}(?:دلوقتي|حاليا|الان|الآن)|(?:دلوقتي|حاليا|الان|الآن).{0,25}(?:فاتح|فاتحين|مفتوح|مفتوحين|شغال|شغالين)/.test(value);
}

function dayAt(value:string){
  for(let index=0;index<dayPatterns.length;index++){
    const match=value.match(dayPatterns[index]);if(match)return {day:index,length:match[0].length};
  }
  return null;
}
function parseTime(hourText:string,minuteText:string|undefined,marker:string|undefined){
  let hour=Number(hourText);const minute=Number(minuteText??0);if(hour>23||minute>59)return null;
  const suffix=marker?.replace(/\./g,'').trim();
  if(suffix&&/^(?:pm|م|مساء|مساءا)$/.test(suffix)){if(hour<12)hour+=12;}
  else if(suffix&&/^(?:am|ص|صباح|صباحا)$/.test(suffix)){if(hour===12)hour=0;}
  else if(hour<=12)return null;
  return hour*60+minute;
}
function parsePeriod(value:string):Period|null{
  const match=value.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|صباحا?|مساءا?|ص|م)?\s*(?:to|until|through|[-–—]|الي|حتى)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|صباحا?|مساءا?|ص|م)?/i);
  if(!match)return null;
  const open=parseTime(match[1],match[2],match[3]),close=parseTime(match[4],match[5],match[6]);
  return open==null||close==null?null:{open,close};
}
function expandedDays(first:number,last:number){
  const result=[first];while(result[result.length-1]!==last&&result.length<7)result.push((result[result.length-1]+1)%7);return result;
}
export function parseWorkingHours(text:string):Schedule|null{
  const normalized=normalizeIntent(text).replace(/،/g,',')
    .replace(/,\s*(?:except|but|and)\s+(?=(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b)/gi,' | ')
    .replace(/،?\s*(?:ما عدا|عدا)\s+(?=(?:الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|السبت)(?:\s|$|:))/g,' | ');
  const schedule:Schedule=new Map();let parsed=0;
  for(let segment of normalized.split(/[|;؛\n]+/).map(value=>value.trim()).filter(Boolean)){
    segment=segment.replace(/^(?:btc\s+(?:service\s+)?(?:working\s+)?hours|maintenance\s+(?:working\s+)?hours|working\s+hours)\s*:\s*/,'');
    let days:number[]=[];
    const daily=segment.match(/^(?:daily|every day|all days|يوميا|كل يوم)(?=\s|$|:)/);
    if(daily){days=[0,1,2,3,4,5,6];segment=segment.slice(daily[0].length).trim();}
    else {
      segment=segment.replace(/^(?:from|من)\s+/,'');
      const first=dayAt(segment);if(!first)continue;
      segment=segment.slice(first.length).trim();
      const connector=segment.match(/^(?:to|through|until|[-–—]|الي|حتى)\s+/);
      if(connector){segment=segment.slice(connector[0].length);const last=dayAt(segment);if(!last)continue;days=expandedDays(first.day,last.day);segment=segment.slice(last.length).trim();}
      else days=[first.day];
    }
    segment=segment.replace(/^\s*[:,-]?\s*(?:from|من)?\s*/,'');
    const closed=/\b(?:closed|off)\b|مغلق|مقفول|اجازه|عطله/.test(segment),period=closed?null:parsePeriod(segment);
    if(!closed&&!period)continue;
    for(const day of days)schedule.set(day,period?[period]:[]);parsed++;
  }
  return parsed&&schedule.size===7?schedule:null;
}

function egyptTime(now:Date){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Africa/Cairo',weekday:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const get=(type:Intl.DateTimeFormatPartTypes)=>parts.find(part=>part.type===type)?.value??'';
  return {day:dayNames.indexOf(get('weekday')),minutes:Number(get('hour'))*60+Number(get('minute'))};
}
function timeText(minutes:number,ar:boolean){
  const normalized=((minutes%1440)+1440)%1440,hour24=Math.floor(normalized/60),minute=normalized%60,hour=hour24%12||12;
  return `${hour}:${String(minute).padStart(2,'0')} ${ar?(hour24<12?'صباحًا':'مساءً'):(hour24<12?'AM':'PM')}`;
}
function nextLabel(offset:number,day:number,minutes:number,ar:boolean){
  if(ar)return offset===0?`اليوم الساعة ${timeText(minutes,true)}`:offset===1?`غدًا الساعة ${timeText(minutes,true)}`:`يوم ${dayNamesAr[day]} الساعة ${timeText(minutes,true)}`;
  return offset===0?`today at ${timeText(minutes,false)}`:offset===1?`tomorrow at ${timeText(minutes,false)}`:`on ${dayNames[day]} at ${timeText(minutes,false)}`;
}
function statusText(name:string,schedule:Schedule,now:Date,ar:boolean){
  const local=egyptTime(now),timeline=local.minutes;
  const windows=[] as Array<{start:number;end:number;day:number;offset:number}>;
  for(let offset=-1;offset<=7;offset++){
    const day=(local.day+offset+7)%7;
    for(const period of schedule.get(day)??[])windows.push({start:offset*1440+period.open,end:offset*1440+period.close+(period.close<=period.open?1440:0),day,offset});
  }
  const active=windows.find(window=>window.start<=timeline&&window.end>timeline);
  if(active){
    const remaining=active.end-timeline,closes=timeText(active.end,ar);
    if(ar)return remaining<=90?`نعم، فرع ${name} مفتوح الآن، لكنه سيغلق الساعة ${closes}. إذا كنت تخطط للزيارة فمن الأفضل التوجه قريبًا. يسعدنا رؤيتك هناك.`:`نعم، فرع ${name} مفتوح الآن وسيغلق الساعة ${closes}. يسعدنا رؤيتك هناك.`;
    return remaining<=90?`Yes, ${name} is open now, but it closes at ${closes}. If you’re planning to visit, it’s best to head over soon. We can’t wait to see you there.`:`Yes, ${name} is open now and will close at ${closes}. We can’t wait to see you there.`;
  }
  const next=windows.filter(window=>window.start>timeline).sort((a,b)=>a.start-b.start)[0];
  if(!next)return ar?`فرع ${name} مغلق الآن. مواعيد العمل المحفوظة لا تتضمن موعد إعادة فتح قادم.`:`${name} is closed now. The saved schedule does not include a next opening time.`;
  const relativeOffset=Math.floor(next.start/1440),label=nextLabel(relativeOffset,next.day,next.start,ar);
  return ar?`للأسف، فرع ${name} مغلق الآن، وسيفتح مجددًا ${label}. يسعدنا رؤيتك هناك.`:`Unfortunately, ${name} is closed now. It will reopen ${label}. We can’t wait to see you there.`;
}

function recentRepairContext(context:MessageContext){
  return isRepairEnquiry(context.text??'')||(context.history??[]).slice(-4).some(message=>/maintenance branches and working hours|فروع الصيانه ومواعيد العمل/.test(normalizeIntent(message.content)));
}
function selectedBranch(context:MessageContext,sources:KnowledgeSource[]){
  for(const text of [context.text??'',...(context.history??[]).filter(message=>message.role==='user').slice(-4).reverse().map(message=>message.content)]){
    const matches=matchingBranches(text,sources);if(matches.length===1)return matches[0];
  }
  return null;
}

/** Answer live open/closed questions using Africa/Cairo time and an approved per-branch schedule. */
export function branchOpenNowReply(context:MessageContext,sources:KnowledgeSource[],now=new Date(),originalText=context.text??''):AgentDecision|null {
  if(!asksIfBranchOpenNow(originalText))return null;
  const branch=selectedBranch(context,sources);if(!branch)return null;
  const value=branchData(branch) as unknown as {name?:string;hours?:string;btcEnabled?:boolean;btcHours?:string;maintenanceEnabled?:boolean;maintenanceHours?:string}|null;
  if(!value?.name)return null;
  const originalContext={...context,text:originalText},repair=recentRepairContext(context)||recentRepairContext(originalContext),
    btc=!repair&&(productIntent(context)==='btc'||productIntent(originalContext)==='btc');let hours='',refs=[branch];
  if(repair){
    const catalog=repairBranchCatalog(sources),entry=catalog?.entries.find(item=>repairBranchRecords(item,sources).some(source=>source.id===branch.id));hours=entry?.hours??'';if(catalog)refs=[...refs,...catalog.sources];
  }else if(btc){
    const catalog=btcCatalog(sources),entry=catalog?.entries.find(item=>btcBranchRecords(item,sources).some(source=>source.id===branch.id));hours=entry?.hours??catalog?.hours.join(' ')??'';if(catalog)refs=[...refs,...catalog.sources];
  }else hours=value.hours?.trim()??'';
  if(!hours)return null;
  const ar=replyLanguage(originalText)==='ar',schedule=parseWorkingHours(hours);
  const text=schedule?statusText(value.name,schedule,now,ar):(ar
    ?`لا أستطيع تحديد حالة فرع ${value.name} الآن بدقة من صيغة المواعيد المحفوظة. مواعيد العمل: ${hours}`
    :`I can’t reliably determine whether ${value.name} is open right now from the saved schedule format. Working hours: ${hours}`);
  return {action:'answer',reason:'approved_knowledge',sources:orderedBranchSources([...new Map(refs.map(source=>[source.id,source])).values()]).map(sourceRef),text};
}
