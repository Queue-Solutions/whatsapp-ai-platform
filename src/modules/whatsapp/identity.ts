export const phonePattern = /^\d{7,15}$/;
export const bsuidPattern = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/;
export const recipientPattern = /^(?:\d{7,15}|[A-Z]{2}\.[A-Za-z0-9]{1,128})$/;

const arabicDigits = '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
const asciiDigits = '01234567890123456789';

/** Canonical WhatsApp form for an Egyptian mobile: 201XXXXXXXXX. */
export function normalizeEgyptianMobile(value:string):string|null {
  const translated=[...value.normalize('NFKC')].map(char=>{
    const index=arabicDigits.indexOf(char);return index===-1?char:asciiDigits[index];
  }).join('');
  let digits=translated.replace(/\D/g,'');
  if(digits.startsWith('0020'))digits=digits.slice(2);
  if(/^01[0125]\d{8}$/.test(digits))digits=`20${digits.slice(1)}`;
  else if(/^1[0125]\d{8}$/.test(digits))digits=`20${digits}`;
  return /^201[0125]\d{8}$/.test(digits)?digits:null;
}

export function sameEgyptianMobile(left:string,right:string):boolean {
  const a=normalizeEgyptianMobile(left),b=normalizeEgyptianMobile(right);
  return a!==null&&a===b;
}

/** Aliases come only from a signed Meta webhook and the channel-scoped database mapping. */
export function allowedRecipient(recipient:string, aliases:string[], allowed:string[]) {
  if(!recipientPattern.test(recipient))return false;
  return [recipient,...aliases].some(id=>allowed.some(candidate=>id===candidate||sameEgyptianMobile(id,candidate)));
}
