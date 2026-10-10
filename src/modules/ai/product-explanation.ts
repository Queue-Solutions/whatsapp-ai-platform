import type {MessageContext} from '../messaging/types';

const normalize=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[إأآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/سبايك/g,'سبائك');

const btc=/\bbtc\b|\bbullion\b|\bgold (?:bars?|coins?)\b|سبائك|سبيكه/;
const jewelry=/\bjewel(?:ry|lery)\b|مجوهرات|مشغولات|الماس/;
const explanation=/\b(?:what (?:is|does)|what's|meaning of|mean|define|explain|difference|different|compare|versus|vs\.?)\b|(?:يعني ايه|يعني ماذا|ما معني|ما معنى|ايه هو|ايه هي|ما هو|ما هي|الفرق|فرق|اشرح)/;

/** A product explanation is informational, not a request for links or a branch directory. */
export function isProductExplanationRequest(text:string):boolean {
  const normalized=normalize(text);
  if(!btc.test(normalized))return false;
  const definition=/\b(?:what (?:is|does)|what's|meaning of|define|explain)\b.{0,24}\bbtc\b|\bbtc\b.{0,24}\b(?:mean|means)\b|(?:يعني ايه|يعني ماذا|ما معني|ما معنى|ايه|ما هو|ما هي|اشرح).{0,18}\bbtc\b|\bbtc\b.{0,18}(?:يعني|معني|معنى)/.test(normalized);
  return definition||(jewelry.test(normalized)&&explanation.test(normalized));
}

export function isProductDifferenceFollowUp(context:MessageContext):boolean {
  if(isProductExplanationRequest(context.text??''))return true;
  const current=normalize(context.text??'').trim();
  if(!/^(?:what(?:'s| is) the difference|difference|how are they different|ايه الفرق|ما الفرق|الفرق ايه|فرق ايه)[.!،,؟? ]*$/.test(current))return false;
  const previous=[...(context.history??[])].reverse().find(message=>message.role==='assistant')?.content??'';
  const normalized=normalize(previous);
  return btc.test(normalized)&&jewelry.test(normalized);
}
