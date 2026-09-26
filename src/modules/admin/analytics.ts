import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';

export const analyticsGranularitySchema=z.enum(['day','week','month']);
export type AnalyticsGranularity=z.infer<typeof analyticsGranularitySchema>;

const summarySchema=z.object({
  customers:z.coerce.number().int().nonnegative(),chats:z.coerce.number().int().nonnegative(),inboundMessages:z.coerce.number().int().nonnegative(),
  spamOrFraud:z.coerce.number().int().nonnegative(),abuseOrSexualHarassment:z.coerce.number().int().nonnegative(),
  complaints:z.coerce.number().int().nonnegative(),contactRequests:z.coerce.number().int().nonnegative(),knowledgeGaps:z.coerce.number().int().nonnegative(),
});
const seriesSchema=z.object({period:z.string(),customers:z.coerce.number(),spamOrFraud:z.coerce.number(),abuseOrSexualHarassment:z.coerce.number(),complaints:z.coerce.number(),contactRequests:z.coerce.number()});
const customerSchema=z.object({id:z.string().uuid(),name:z.string(),phone:z.string().nullable(),username:z.string().nullable(),firstContact:z.string().nullable(),lastContact:z.string().nullable(),
  inboundMessages:z.coerce.number(),chats:z.coerce.number(),spamOrFraud:z.coerce.number(),abuseOrSexualHarassment:z.coerce.number(),complaints:z.coerce.number(),contactRequests:z.coerce.number(),knowledgeGaps:z.coerce.number()});
const recommendationSchema=z.object({kind:z.enum(['faq_gap','complaint_theme']),topic:z.string(),mentions:z.coerce.number(),customers:z.coerce.number(),lastSeen:z.string(),reason:z.string()});
export const analyticsReportSchema=z.object({summary:summarySchema,series:z.array(seriesSchema),customers:z.array(customerSchema),recommendations:z.array(recommendationSchema)});
export type AnalyticsReport=z.infer<typeof analyticsReportSchema>;
export type AnalyticsCustomer=z.infer<typeof customerSchema>;
export type AnalyticsRecommendation=z.infer<typeof recommendationSchema>;

export class AnalyticsRepository{
  constructor(private db:SupabaseClient){}
  async report(tenant:string,from:string,to:string,granularity:AnalyticsGranularity):Promise<AnalyticsReport>{
    const {data,error}=await this.db.rpc('get_chat_analytics',{p_tenant:tenant,p_from:from,p_to:to,p_granularity:granularity});
    if(error)throw new Error('Could not load analytics. Check your access and try again.');
    const parsed=analyticsReportSchema.safeParse(data);
    if(!parsed.success)throw new Error('Analytics data is unavailable. Ask your administrator to apply the latest database update.');
    return parsed.data;
  }
  async download(tenant:string,from:string,to:string,granularity:AnalyticsGranularity){
    const {data,error}=await this.db.auth.getSession();
    if(error||!data.session)throw new Error('Please sign in again.');
    const response=await fetch('/api/dashboard/analytics/export',{method:'POST',headers:{Authorization:`Bearer ${data.session.access_token}`,'Content-Type':'application/json'},
      body:JSON.stringify({tenant,from,to,granularity}),signal:AbortSignal.timeout(60000)});
    if(!response.ok){const result=await response.json().catch(()=>({}));throw new Error(typeof result.error==='string'?result.error:'Could not create the Excel report.');}
    const blob=await response.blob();const url=URL.createObjectURL(blob);const link=document.createElement('a');
    link.href=url;link.download=filenameFromDisposition(response.headers.get('content-disposition'))??'chat-analytics.xlsx';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
}

export function filenameFromDisposition(value:string|null){
  const match=value?.match(/filename="([^"]+)"/i);return match?.[1]??null;
}
