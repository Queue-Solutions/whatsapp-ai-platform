import { z } from 'zod';
import type { DeliveryStatus, IncomingMessage, IdentityChange } from '../messaging/types';
import { phonePattern, bsuidPattern } from './identity';

const phone=z.string().regex(phonePattern),bsuid=z.string().regex(bsuidPattern);
const timestamp=z.string().regex(/^\d{1,12}$/).refine(v=>Number(v)<=253402300799);
const message=z.object({
  id:z.string().min(1),from:phone.optional(),from_user_id:bsuid.optional(),timestamp,
  type:z.string().min(1),text:z.object({body:z.string().max(16384)}).optional(),
  system:z.object({type:z.string(),wa_id:phone.optional(),user_id:bsuid.optional(),previous_user_id:bsuid.optional()}).optional(),
}).refine(v=>v.type!=='text'||v.text!==undefined);
const payload=z.object({object:z.literal('whatsapp_business_account'),entry:z.array(z.object({changes:z.array(z.object({
  field:z.string(),value:z.object({
    metadata:z.object({phone_number_id:z.string()}).optional(),
    contacts:z.array(z.object({wa_id:phone.optional(),user_id:bsuid.optional(),profile:z.object({name:z.string().optional(),username:z.string().max(35).optional()}).optional()})).optional(),
    messages:z.array(message).optional(),
    statuses:z.array(z.object({id:z.string(),status:z.string(),timestamp,errors:z.array(z.object({code:z.number()})).optional()})).optional(),
  }),
}))}))});
type InboundEvent={kind:'message';value:IncomingMessage}|{kind:'identity';value:IdentityChange};
export function parseWebhook(input:unknown):{messages:IncomingMessage[];statuses:DeliveryStatus[];identityChanges:IdentityChange[];events:InboundEvent[]} {
  const data=payload.parse(input),messages:IncomingMessage[]=[],statuses:DeliveryStatus[]=[],identityChanges:IdentityChange[]=[],events:InboundEvent[]=[];
  for(const entry of data.entry)for(const change of entry.changes){
    if(change.field!=='messages')continue;
    const value=change.value,phoneNumberId=value.metadata?.phone_number_id;
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
        username:contact?.profile?.username,displayName:contact?.profile?.name,occurredAt,type:m.type,text:m.type==='text'?m.text!.body:null};
      messages.push(incoming);events.push({kind:'message',value:incoming});
    }
    for(const s of value.statuses??[]){
      if(!['sent','delivered','read','failed'].includes(s.status))continue;
      statuses.push({phoneNumberId,providerMessageId:s.id,status:s.status as DeliveryStatus['status'],occurredAt:new Date(Number(s.timestamp)*1000).toISOString(),errorCode:s.errors?.[0]?.code.toString()});
    }
  }
  return {messages,statuses,identityChanges,events};
}
