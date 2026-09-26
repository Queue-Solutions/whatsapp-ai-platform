import {createClient} from '@supabase/supabase-js';
import {z} from 'zod';
import {analyticsGranularitySchema,analyticsReportSchema} from '@/modules/admin/analytics';
import {buildAnalyticsWorkbook} from '@/modules/admin/analytics-workbook';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
const requestSchema=z.object({tenant:z.string().uuid(),from:z.iso.datetime(),to:z.iso.datetime(),granularity:analyticsGranularitySchema}).strict();
function bearer(request:Request){const value=request.headers.get('authorization');return value?.startsWith('Bearer ')?value.slice(7):null;}
function filename(name:string){const slug=name.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50).toLowerCase()||'business';return `${slug}-chat-analytics.xlsx`;}

export async function POST(request:Request){
  const token=bearer(request);if(!token)return Response.json({error:'Please sign in again.'},{status:401});
  const input=requestSchema.safeParse(await request.json().catch(()=>null));if(!input.success)return Response.json({error:'Choose a valid analytics period.'},{status:400});
  const from=new Date(input.data.from),to=new Date(input.data.to);if(to<=from||to.getTime()-from.getTime()>2*366*86400000)return Response.json({error:'Choose a date range of two years or less.'},{status:400});
  const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_PUBLISHABLE_KEY;if(!url||!key)return Response.json({error:'Analytics export is not configured.'},{status:503});
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{headers:{Authorization:`Bearer ${token}`}}});
  const user=await db.auth.getUser(token);if(user.error||!user.data.user)return Response.json({error:'Please sign in again.'},{status:401});
  const [analytics,tenant]=await Promise.all([
    db.rpc('get_chat_analytics',{p_tenant:input.data.tenant,p_from:input.data.from,p_to:input.data.to,p_granularity:input.data.granularity}),
    db.from('tenants').select('name').eq('id',input.data.tenant).single(),
  ]);
  if(analytics.error||tenant.error)return Response.json({error:'Could not load analytics for this business.'},{status:403});
  const report=analyticsReportSchema.safeParse(analytics.data);if(!report.success)return Response.json({error:'Analytics data is unavailable.'},{status:503});
  const bytes=await buildAnalyticsWorkbook(report.data,{business:tenant.data.name,from:input.data.from,to:input.data.to,granularity:input.data.granularity});
  return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${filename(tenant.data.name)}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
