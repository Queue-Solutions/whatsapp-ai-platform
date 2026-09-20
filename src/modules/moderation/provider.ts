import {z} from 'zod';
import type {Environment} from '../../config/env';
import type {MessageContext} from '../messaging/types';
export const blockedCategories=['sexual','sexual/minors','harassment','harassment/threatening','hate','hate/threatening'] as const;
export type ModerationResult={state:'clear'|'flagged'|'unavailable';categories:string[]};
export interface ContentModerator {check(context:MessageContext):Promise<ModerationResult>}
const categoriesSchema=z.object(Object.fromEntries(blockedCategories.map(c=>[c,z.boolean()])));
const responseSchema=z.object({results:z.array(z.object({categories:categoriesSchema})).length(1)});
const metadataSchema=z.object({url:z.url(),mime_type:z.enum(['image/jpeg','image/png','image/webp']),file_size:z.number().int().positive().max(5*1024*1024)});
function localAbuseCategories(text:string|null|undefined):string[]{
  if(!text?.trim())return [];
  const normalized=text.normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[إأآ]/g,'ا');
  const arabic=normalized.replace(/[^\p{Script=Arabic}]+/gu,' ').replace(/\s+/g,' ').trim();
  return /(?:^|\s)ا\s*ح\s*ا+(?:\s|$)/u.test(arabic)||/(?:^|\s)(?:و\s*)?ك\s*س\s*(?:ا\s*)?م\s*ك\s*م?(?:\s|$)/u.test(arabic)?['harassment']:[];
}
async function boundedBody(response:Response,max:number):Promise<Buffer>{
  if(!response.ok||!response.body||Number(response.headers.get('content-length'))>max)throw new Error('Content unavailable');
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw new Error('Content too large');chunks.push(value);}}finally{await reader.cancel();}
  return Buffer.concat(chunks);
}
/** Only selected abuse categories trigger a block. No raw provider response or media is logged or stored. */
export class OpenAiModerator implements ContentModerator {
  constructor(private key:string|undefined,private env:Environment,private fetcher:typeof fetch=fetch){}
  async check(context:MessageContext):Promise<ModerationResult>{
    if(context.type!=='text'&&context.type!=='image')return {state:'clear',categories:[]};
    const localCategories=localAbuseCategories(context.text);
    if(localCategories.length)return {state:'flagged',categories:localCategories};
    try{
      if(!this.key)throw new Error('Moderation not configured');
      const input:Array<{type:'text';text:string}|{type:'image_url';image_url:{url:string}}>=[];
      if(context.text?.trim())input.push({type:'text',text:context.text});
      if(context.type==='image')input.push({type:'image_url',image_url:{url:await this.imageDataUrl(context.mediaId)}});
      if(!input.length)throw new Error('Empty moderation input');
      const response=await this.fetcher('https://api.openai.com/v1/moderations',{method:'POST',headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'},
        body:JSON.stringify({model:'omni-moderation-latest',input}),signal:AbortSignal.timeout(12000),redirect:'error'});
      const result=responseSchema.parse(JSON.parse((await boundedBody(response,65536)).toString('utf8'))).results[0];
      const categories=blockedCategories.filter(c=>result.categories[c]);
      return {state:categories.length?'flagged':'clear',categories};
    }catch{return {state:'unavailable',categories:[]};}
  }
  private async imageDataUrl(mediaId:string|undefined){const {bytes,mime}=await this.image(mediaId);return `data:${mime};base64,${bytes.toString('base64')}`;}
  async image(mediaId:string|undefined):Promise<{bytes:Buffer;mime:string}>{
    if(!mediaId||!/^\d{1,100}$/.test(mediaId))throw new Error('Missing image');
    const headers={Authorization:`Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}`};
    const endpoint=`https://graph.facebook.com/${this.env.META_GRAPH_API_VERSION}/${mediaId}?phone_number_id=${this.env.WHATSAPP_TEST_PHONE_NUMBER_ID}`;
    const response=await this.fetcher(endpoint,{headers,signal:AbortSignal.timeout(8000),redirect:'error'});
    const metadata=metadataSchema.parse(JSON.parse((await boundedBody(response,16384)).toString('utf8')));
    const url=new URL(metadata.url);
    // Do not forward a bearer token to customer-controlled hosts or redirects.
    if(url.protocol!=='https:'||url.username||url.password||url.port||!(url.hostname==='lookaside.fbsbx.com'||url.hostname.endsWith('.fbcdn.net')))throw new Error('Invalid media host');
    const download=await this.fetcher(url,{headers,signal:AbortSignal.timeout(10000),redirect:'error'});
    if(download.headers.get('content-type')?.split(';')[0]!==metadata.mime_type)throw new Error('Invalid image type');
    const bytes=await boundedBody(download,5*1024*1024);
    if(bytes.length!==metadata.file_size)throw new Error('Incomplete image');
    return {bytes,mime:metadata.mime_type};
  }
}
