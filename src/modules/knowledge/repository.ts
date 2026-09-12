import type { SupabaseClient } from '@supabase/supabase-js';
import { branchSchema } from './questionnaire';
/** Always tenant-scoped; callers must resolve the tenant from authenticated membership or channel. */
export class KnowledgeRepository {
  constructor(private db:SupabaseClient){}
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
