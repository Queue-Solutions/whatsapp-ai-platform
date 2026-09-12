import { Dashboard } from './ui';
export const dynamic = 'force-dynamic';
export default function DashboardPage() {
  // Only the deliberately public key crosses the server/client boundary.
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? '';
  const url = process.env.SUPABASE_URL ?? '';
  const configured = key.startsWith('sb_publishable_') && /^https:\/\//.test(url);
  return <Dashboard config={configured ? { url, key } : null} />;
}
