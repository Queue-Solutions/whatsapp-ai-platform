import type { SupabaseClient } from '@supabase/supabase-js';
import { branchSchema, starterFaqs, validateBranch, validateFaq, type Branch, type Faq } from '../knowledge/questionnaire';

export type Membership = { tenant_id: string; role: string; name: string };
/** All calls use the signed-in user's client and database RLS, never a service key. */
export class KnowledgeEditor {
  constructor(private readonly db: SupabaseClient) {}
  async memberships(): Promise<Membership[]> {
    const { data: user, error: authError } = await this.db.auth.getUser();
    if (authError || !user.user) throw new Error('Please sign in again.');
    const { data, error } = await this.db.from('tenant_memberships').select('tenant_id,role').eq('user_id', user.user.id);
    if (error) throw new Error('Could not load your business access. Please try again.');
    const { data: tenants, error: tenantError } = await this.db.from('tenants').select('id,name');
    if (tenantError) throw new Error('Could not load your businesses. Please try again.');
    return (data ?? []).map(m => ({ ...m, name: tenants?.find(t => t.id === m.tenant_id)?.name ?? 'Business' }));
  }
  async load(tenant: string, locale: string) {
    const [faqs, facts, templates] = await Promise.all([
      this.db.from('faqs').select('id,question,answer,is_published,updated_at').eq('tenant_id', tenant).eq('locale', locale).order('created_at'),
      this.db.from('business_facts').select('id,fact_key,value,is_published,updated_at').eq('tenant_id', tenant).eq('locale', locale).eq('category', 'branch').order('created_at'),
      starterFaqs(tenant, locale),
    ]);
    if (faqs.error || facts.error) throw new Error('Could not load your answers. Please try again.');
    const saved = faqs.data as Faq[];
    const merged = templates.map(t => saved.find(f => f.id === t.id) ?? t);
    merged.push(...saved.filter(f => !templates.some(t => t.id === f.id)));
    // Fail explicitly rather than silently overwrite an existing incompatible branch record.
    const branches: Branch[] = (facts.data ?? []).map(row => {
      const value = branchSchema.safeParse(row.value);
      if (!value.success) throw new Error('An existing branch uses a different format. Contact your administrator before editing.');
      return { ...row, value: value.data };
    });
    return { faqs: merged, branches };
  }
  async saveFaq(tenant: string, locale: string, faq: Faq, publish: boolean) {
    validateFaq(faq, publish);
    const { data, error } = await this.db.from('faqs').upsert({ id: faq.id, tenant_id: tenant, locale,
      question: faq.question.trim(), answer: faq.answer.trim(), is_published: publish }, { onConflict: 'id' })
      .select('id,question,answer,is_published,updated_at').single();
    if (error || !data) throw new Error('Could not save. Check your connection and owner/admin access, then try again.');
    return data as Faq;
  }
  async saveBranch(tenant: string, locale: string, branch: Branch, publish: boolean) {
    validateBranch(branch.value, publish);
    const { data, error } = await this.db.from('business_facts').upsert({ id: branch.id, tenant_id: tenant, locale,
      category: 'branch', fact_key: branch.fact_key, value: branch.value, is_published: publish }, { onConflict: 'id' })
      .select('id,fact_key,value,is_published,updated_at').single();
    if (error || !data) throw new Error('Could not save. Check your connection and owner/admin access, then try again.');
    return data as Branch;
  }
}
