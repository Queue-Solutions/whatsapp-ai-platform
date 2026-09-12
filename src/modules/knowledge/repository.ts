import type { SupabaseClient } from '@supabase/supabase-js';
import type { KnowledgeSource } from '../ai/contracts';
import { branchSchema } from './questionnaire';
/** Always tenant-scoped; callers must resolve the tenant from authenticated membership or channel. */
export class KnowledgeRepository {
  constructor(private db:SupabaseClient){}
  async forAssistant(tenantId: string): Promise<KnowledgeSource[]> {
    const locales = await Promise.all(['en','ar'].map(locale => this.published(tenantId, locale)));
    const rows = locales.flatMap(data => [
      ...data.faqs.map(f => ({ id: f.id, kind: 'faq' as const, updatedAt: f.updated_at, content: JSON.stringify({ question: f.question, answer: f.answer }) })),
      ...data.facts.map(f => ({ id: f.id, kind: 'fact' as const, updatedAt: f.updated_at, content: JSON.stringify({ category: f.category, value: f.value }) })),
    ]).sort((a,b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    return rows.map((row,i) => ({ ...row, label: `K${i+1}` }));
  }
  async published(tenantId:string,locale:string){
    const [facts,faqs]=await Promise.all([
      this.db.from('business_facts').select('id,category,fact_key,value,updated_at').eq('tenant_id',tenantId).eq('locale',locale).eq('is_published',true),
      this.db.from('faqs').select('id,question,answer,updated_at').eq('tenant_id',tenantId).eq('locale',locale).eq('is_published',true),
    ]);
    if(facts.error || faqs.error)throw new Error('Knowledge unavailable');
    return {
      facts: facts.data.filter(fact => {
        if (fact.category !== 'branch') return true;
        const result = branchSchema.safeParse(fact.value);
        return result.success && !!result.data.name.trim() && !!result.data.address.trim() && !!result.data.hours.trim();
      }),
      faqs: faqs.data.filter(faq => faq.question.trim() && faq.answer.trim()),
    };
  }
}
