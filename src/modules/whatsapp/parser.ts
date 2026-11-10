import { z } from 'zod';
import type { DeliveryStatus, IncomingMessage, IdentityChange, OutboundEcho } from '../messaging/types';
import { phonePattern, bsuidPattern } from './identity';

const phone=z.string().regex(phonePattern),bsuid=z.string().regex(bsuidPattern);
function directCustomerTurn(value:unknown) {
  if(!value||typeof value!=='object')return true; // Invalid ordinary messages still fail validation.
  const item=value as Record<string,unknown>;
  const context=item.context;
  return !('group_id' in item)&&item.is_echo!==true&&!(context&&typeof context==='object'&&'group_id' in context);
}
const timestamp=z.string().regex(/^\d{1,12}$/).refine(v=>Number(v)<=253402300799);
const message=z.object({
  id:z.string().min(1),from:phone.optional(),from_user_id:bsuid.optional(),timestamp,
  type:z.string().min(1),text:z.object({body:z.string().max(16384)}).optional(),
  image:z.object({id:z.string().regex(/^\d{1,100}$/),caption:z.string().max(16384).optional()}).optional(),
  location:z.object({latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)}).optional(),
  system:z.object({type:z.string(),wa_id:phone.optional(),user_id:bsuid.optional(),previous_user_id:bsuid.optional()}).optional(),
}).refine(v=>(v.type!=='text'||v.text!==undefined)&&(v.type!=='location'||v.location!==undefined));
const messageValue=z.object({
    metadata:z.object({phone_number_id:z.string()}).optional(),
    contacts:z.array(z.object({wa_id:phone.optional(),user_id:bsuid.optional(),profile:z.object({name:z.string().optional(),username:z.string().max(35).optional()}).optional()})).optional(),
    messages:z.array(z.unknown()).transform(items=>items.filter(directCustomerTurn)).pipe(z.array(message)).optional(),
    statuses:z.array(z.object({id:z.string(),status:z.string(),timestamp,errors:z.array(z.object({code:z.number()})).optional()})).optional(),
  });
const echo=z.object({
  id:z.string().min(1),to:phone.optional(),to_user_id:bsuid.optional(),timestamp,
  type:z.string().min(1),text:z.object({body:z.string().max(16384)}).optional(),
  image:z.object({id:z.string().regex(/^\d{1,100}$/),caption:z.string().max(16384).optional()}).optional(),
}).refine(v=>(v.to!==undefined||v.to_user_id!==undefined)&&(v.type!=='text'||v.text!==undefined));
const echoValue=z.object({
  metadata:z.object({phone_number_id:z.string()}),
  message_echoes:z.array(echo),
});
const payload=z.object({object:z.literal('whatsapp_business_account'),entry:z.array(z.object({changes:z.array(z.object({
  field:z.string(),value:z.unknown(),
}))}))});
type WebhookEvent={kind:'message';value:IncomingMessage}|{kind:'identity';value:IdentityChange}|{kind:'echo';value:OutboundEcho};
export function parseWebhook(input:unknown):{messages:IncomingMessage[];statuses:DeliveryStatus[];identityChanges:IdentityChange[];echoes:OutboundEcho[];events:WebhookEvent[]} {
  const data=payload.parse(input),messages:IncomingMessage[]=[],statuses:DeliveryStatus[]=[],identityChanges:IdentityChange[]=[],echoes:OutboundEcho[]=[],events:WebhookEvent[]=[];
  for(const entry of data.entry)for(const change of entry.changes){
    if(change.field==='smb_message_echoes'){
      const value=echoValue.parse(change.value),phoneNumberId=value.metadata.phone_number_id;
      for(const m of value.message_echoes){
        const outbound:OutboundEcho={phoneNumberId,providerMessageId:m.id,to:m.to??m.to_user_id!,userId:m.to_user_id,
          occurredAt:new Date(Number(m.timestamp)*1000).toISOString(),type:m.type,
          mediaId:m.type==='image'?m.image?.id:undefined,text:m.type==='text'?m.text!.body:m.type==='image'?m.image?.caption??null:null};
        echoes.push(outbound);events.push({kind:'echo',value:outbound});
      }
      continue;
    }
    if(change.field!=='messages')continue;
    if(change.value&&typeof change.value==='object'&&'group_id' in change.value)continue;
    // History and group/state events are not customer turns. App-origin echoes
    // use the dedicated branch above so they can never invoke the assistant.
    const value=messageValue.parse(change.value),phoneNumberId=value.metadata?.phone_number_id;
    if(!phoneNumberId&&(value.messages?.length||value.statuses?.length))throw new Error('Missing phone number ID');
    if(!phoneNumberId)continue;
    for(const m of value.messages??[]){
      const occurredAt=new Date(Number(m.timestamp)*1000).toISOString();
      if(m.type==='system'){
        const s=m.system;
        if(s&&['user_changed_number','user_changed_user_id'].includes(s.type)){
          const previousIdentifier=s.previous_user_id??m.from;
          if(!previousIdentifier||!s.user_id)throw new Error('Missing identity change identifiers');
          const identity={phoneNumberId,providerMessageId:m.id,previousIdentifier,newPhone:s.wa_id,newUserId:s.user_id,occurredAt};
          identityChanges.push(identity);events.push({kind:'identity',value:identity});
        }
        continue; // System notifications never open a reply window or invoke the agent.
      }
      if(!m.from&&!m.from_user_id)throw new Error('Missing sender identifier');
      const matches=(value.contacts??[]).filter(c=>(m.from&&c.wa_id===m.from)||(m.from_user_id&&c.user_id===m.from_user_id));
      if(matches.length>1)throw new Error('Ambiguous sender identity');
      const contact=matches[0];
      if(contact&&((m.from&&contact.wa_id&&m.from!==contact.wa_id)||(m.from_user_id&&contact.user_id&&m.from_user_id!==contact.user_id)))throw new Error('Conflicting sender identity');
      const userId=m.from_user_id??contact?.user_id;
      const incoming={phoneNumberId,providerMessageId:m.id,from:m.from??contact?.wa_id??userId!,userId,
        username:contact?.profile?.username,displayName:contact?.profile?.name,occurredAt,type:m.type,mediaId:m.type==='image'?m.image?.id:undefined,text:m.type==='location'?`geo:${m.location!.latitude},${m.location!.longitude}`:m.type==='text'?m.text!.body:m.type==='image'?m.image?.caption??null:null};
      messages.push(incoming);events.push({kind:'message',value:incoming});
    }
    for(const s of value.statuses??[]){
      if(!['sent','delivered','read','failed'].includes(s.status))continue;
      statuses.push({phoneNumberId,providerMessageId:s.id,status:s.status as DeliveryStatus['status'],occurredAt:new Date(Number(s.timestamp)*1000).toISOString(),errorCode:s.errors?.[0]?.code.toString()});
    }
  }
  return {messages,statuses,identityChanges,echoes,events};
}
