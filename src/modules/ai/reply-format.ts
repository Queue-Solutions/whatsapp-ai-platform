/** Customer-facing house style. Keep URLs intact apart from encoding forbidden punctuation. */
export function formatReply(text:string) {
  const urls:string[]=[];
  let value=text.replace(/https?:\/\/[^\s<>]+/g,url=>{urls.push(url.replace(/;/g,'%3B').replace(/؛/g,'%D8%9B'));return `\u0000${urls.length-1}\u0000`;});
  value=value.replace(/(?<![\p{L}])(?:إيرام|ايرام|إرم|أرم|آرم|ارام|ارم)(?![\p{L}])/gu,'IRAM');
  value=value.replace(/\biram\b/gi,'IRAM');
  value=value.replace(/[;؛]+[ \t]*/g,'\n').replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n')
    .replace(/[ \t]+(?=(?:[•●]|\d+[.)])\s)/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  return value.replace(/\u0000(\d+)\u0000/g,(_,i)=>urls[Number(i)]);
}
function restrainBrandEmojis(text:string){
  let used=false;
  return text.replace(/(?:[\u{1F000}-\u{1FAFF}]|[\u2764\u2728])\uFE0F?/gu,emoji=>{
    const normalized=emoji.replace(/\uFE0F/g,'');
    if(used||!['✨','💎','🤍'].includes(normalized))return '';
    used=true;return normalized;
  }).replace(/[ \t]{2,}/g,' ').replace(/ +\n/g,'\n');
}
/** Remove new-conversation pleasantries from ordinary mid-conversation business replies. */
export function formatBusinessReply(text:string) {
  return restrainBrandEmojis(formatReply(text)
    .replace(/^(?:(?:hi|hello|hey)(?: there)?|welcome to IRAM|thank(?:s| you) for (?:contacting|reaching out to) IRAM(?: Jewelry)?)[!,. 🤍💎✨]*(?:\n+|$)/i,'')
    .replace(/^(?:اهلا|أهلا|مرحب(?:ا|ًا))(?: بيك)?(?: في IRAM)?[!،,. 🤍💎✨]*(?:\n+|$)/u,'')
    .replace(/^شكر(?:ا|ًا) لتواصلك مع IRAM(?: Jewelry)?[!،,. 🤍💎✨]*(?:\n+|$)/u,'')
    .replace(/\n+(?:مع أطيب التحيات،?|Best regards,?)\n+IRAM(?: Jewelry)?[.!]*$/iu,'')
    .trim()).trim();
}
export function formatBranchReply(text:string, lines:string[] = []) {
  return lines.length ? `${text.trim()}\n\n${lines.map(line=>`• ${line.replace(/\s+/g,' ').trim()}`).join('\n\n')}` : text;
}
