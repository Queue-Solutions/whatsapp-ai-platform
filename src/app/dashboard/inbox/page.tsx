import { Dashboard } from '../ui';
export const dynamic='force-dynamic';
export default function InboxPage(){
  const key=process.env.SUPABASE_PUBLISHABLE_KEY??'';const url=process.env.SUPABASE_URL??'';
  return <Dashboard config={key.startsWith('sb_publishable_')&&/^https:\/\//.test(url)?{url,key}:null} view="inbox"/>;
}
