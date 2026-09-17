/** Customer-facing house style. Keep URLs intact apart from encoding forbidden punctuation. */
export function formatReply(text:string, arabic=false) {
  const urls:string[]=[];
  let value=text.replace(/https?:\/\/[^\s<>]+/g,url=>{urls.push(url.replace(/;/g,'%3B').replace(/؛/g,'%D8%9B'));return `\u0000${urls.length-1}\u0000`;});
  value=value.replace(/(?<![\p{L}])(?:إيرام|ايرام|إرم|أرم|آرم|ارام)(?![\p{L}])/gu,'ارم');
  if(arabic)value=value.replace(/\biram\b/gi,'ارم');
  value=value.replace(/[;؛]+[ \t]*/g,'\n').replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n')
    .replace(/[ \t]+(?=(?:[•●]|\d+[.)])\s)/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  return value.replace(/\u0000(\d+)\u0000/g,(_,i)=>urls[Number(i)]);
}
export function formatBranchReply(text:string, lines:string[] = []) {
  return lines.length ? `${text.trim()}\n\n${lines.map(line=>`• ${line.replace(/\s+/g,' ').trim()}`).join('\n\n')}` : text;
}
