import { describe, expect, it } from 'vitest';
import { emptyBranch, starterFaqs, validateBranch, validateFaq } from '../src/modules/knowledge/questionnaire';

describe('business knowledge approval', () => {
  it('starts with blank answers and stable tenant/locale-scoped starter identities', async () => {
    const first = await starterFaqs('tenant-a','en');
    expect(first).toHaveLength(12);
    expect(first.every(f => f.answer === '' && !f.is_published)).toBe(true);
    expect(await starterFaqs('tenant-a','en')).toEqual(first);
    expect((await starterFaqs('tenant-b','en')).map(f => f.id)).not.toEqual(first.map(f => f.id));
    expect((await starterFaqs('tenant-a','ar')).map(f => f.id)).not.toEqual(first.map(f => f.id));
  });
  it('allows blank drafts but never approves blank answers', async () => {
    const [faq] = await starterFaqs('tenant-a','en');
    expect(() => validateFaq(faq, false)).not.toThrow();
    expect(() => validateFaq({ ...faq, answer: ' \n ' }, true)).toThrow('Add an answer');
    expect(() => validateFaq({ ...faq, answer: 'نرحب بكم' }, true)).not.toThrow();
  });
  it('keeps branch and map answers blank and requires essential facts for approval', () => {
    const branch = emptyBranch();
    expect(Object.values(branch).every(v => v === '')).toBe(true);
    expect(() => validateBranch(branch, false)).not.toThrow();
    expect(() => validateBranch(branch, true)).toThrow('branch name');
    expect(() => validateBranch({ ...branch, name: 'فرع اختبار', address: 'عنوان اختباري', hours: 'مواعيد اختبارية' }, true)).not.toThrow();
  });
  it('accepts Google Maps share links but rejects executable and misleading URLs', () => {
    for (const mapsUrl of ['https://maps.app.goo.gl/example','https://www.google.com/maps/place/example','https://goo.gl/maps/example'])
      expect(() => validateBranch({ ...emptyBranch(), mapsUrl }, false)).not.toThrow();
    for (const mapsUrl of ['javascript:alert(1)','https://google.com.evil.test/maps','http://google.com/maps','https://user:pass@google.com/maps'])
      expect(() => validateBranch({ ...emptyBranch(), mapsUrl }, false)).toThrow('Google Maps');
  });
});

import { KnowledgeRepository } from '../src/modules/knowledge/repository';
import { KnowledgeEditor, gapFaqId } from '../src/modules/admin/knowledge-editor';
import type { SupabaseClient } from '@supabase/supabase-js';
import { vi } from 'vitest';

it('gives each tenant/message a stable FAQ identity and preserves an existing approved answer', async()=>{
  const id=await gapFaqId('tenant-a','message-1');
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  expect(await gapFaqId('tenant-a','message-1')).toBe(id);
  expect(await gapFaqId('tenant-b','message-1')).not.toBe(id);
  expect(await gapFaqId('tenant-a','message-2')).not.toBe(id);
  const saved={id,question:'Parking?',answer:'Confirmed parking information',is_published:true,locale:'en'};
  const q={select:vi.fn(),eq:vi.fn(),maybeSingle:vi.fn().mockResolvedValue({data:saved,error:null})};
  q.select.mockReturnValue(q);q.eq.mockReturnValue(q);
  const editor=new KnowledgeEditor({from:()=>q} as unknown as SupabaseClient);
  expect(await editor.faqForGap('tenant-a','message-1','Original question')).toEqual(saved);
  expect(q.eq).toHaveBeenCalledWith('tenant_id','tenant-a');expect(q.eq).toHaveBeenCalledWith('id',id);
  q.maybeSingle.mockResolvedValueOnce({data:null,error:null});
  expect(await editor.faqForGap('tenant-a','message-1','فيه ركنة؟')).toMatchObject({id,answer:'',is_published:false,locale:'ar'});
  q.maybeSingle.mockResolvedValueOnce({data:{...saved,deleted_at:'2026-09-17'},error:null});
  await expect(editor.faqForGap('tenant-a','message-1','Parking?')).rejects.toThrow('deleted');
});

it('excludes empty published answers and incomplete branches even if stored outside the editor', async () => {
  const makeQuery = (data: unknown[]) => {
    const query = { select: vi.fn(), eq: vi.fn(), then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve) };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query); return query;
  };
  const facts = makeQuery([
    { category: 'branch', value: emptyBranch() },
    { category: 'branch', value: { ...emptyBranch(), name: 'Test branch', address: 'Test address', hours: 'Test hours' } },
    { category: 'contact', value: 'Approved contact instructions' },
  ]);
  const faqs = makeQuery([{question:'Payments?', answer:'   '}, {question:'Services?', answer:'Approved test answer'}]);
  const db = { from: (table: string) => table === 'faqs' ? faqs : facts } as unknown as SupabaseClient;
  const result = await new KnowledgeRepository(db).published('tenant-a', 'ar');
  expect(result.facts).toHaveLength(2); expect(result.faqs).toHaveLength(1);
  for (const query of [facts, faqs]) {
    expect(query.eq).toHaveBeenCalledWith('tenant_id','tenant-a');
    expect(query.eq).toHaveBeenCalledWith('locale','ar');
    expect(query.eq).toHaveBeenCalledWith('is_published',true);
  }
});

it('does not report success when RLS or the network rejects a save', async () => {
  const query = { upsert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: null, error: { code: '42501' } }) };
  query.upsert.mockReturnValue(query); query.select.mockReturnValue(query);
  const db = { from: () => query } as unknown as SupabaseClient;
  const [faq] = await starterFaqs('tenant-a','en');
  await expect(new KnowledgeEditor(db).saveFaq('tenant-a','en',faq,false)).rejects.toThrow('Could not save');
  expect(query.upsert).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 'tenant-a', locale: 'en', answer: '', is_published: false }), { onConflict: 'id' });
});

it('keeps deleted starter FAQs out of the editor after reloading', async () => {
  const [starter] = await starterFaqs('tenant-a', 'en');
  const query = (data: unknown[]) => {
    const q = { select: vi.fn(), eq: vi.fn(), order: vi.fn().mockResolvedValue({ data, error: null }) };
    q.select.mockReturnValue(q); q.eq.mockReturnValue(q); return q;
  };
  const faqs = query([{ ...starter, deleted_at: '2026-09-15T12:00:00Z' }]);
  const facts = query([]);
  const db = { from: (table: string) => table === 'faqs' ? faqs : facts } as unknown as SupabaseClient;
  const result = await new KnowledgeEditor(db).load('tenant-a', 'en');
  expect(result.faqs).toHaveLength(11);
  expect(result.faqs.some(f => f.id === starter.id)).toBe(false);
});

it('removes FAQ content and approval when deleting even an unsaved starter', async () => {
  const q = { upsert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: { id: 'faq-id' }, error: null }) };
  q.upsert.mockReturnValue(q); q.select.mockReturnValue(q);
  const db = { from: () => q } as unknown as SupabaseClient;
  await new KnowledgeEditor(db).deleteFaq('tenant-a', 'ar', 'faq-id');
  expect(q.upsert).toHaveBeenCalledWith({ id: 'faq-id', tenant_id: 'tenant-a', locale: 'ar', question: '', answer: '', is_published: false, deleted_at: expect.any(String) }, { onConflict: 'id' });
  q.single.mockResolvedValue({ data: null, error: null } as never);
  await expect(new KnowledgeEditor(db).deleteFaq('tenant-a', 'ar', 'faq-id')).rejects.toThrow('Could not delete');
});

it('scopes branch deletion and reports denied or failed deletes without false success', async () => {
  const q = { delete: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: { id: 'branch-id' }, error: null }) };
  q.delete.mockReturnValue(q); q.eq.mockReturnValue(q); q.select.mockReturnValue(q);
  const db = { from: () => q } as unknown as SupabaseClient;
  await new KnowledgeEditor(db).deleteBranch('tenant-a', 'ar', 'branch-id');
  for (const pair of [['tenant_id', 'tenant-a'], ['locale', 'ar'], ['category', 'branch'], ['id', 'branch-id']]) expect(q.eq).toHaveBeenCalledWith(...pair);
  q.single.mockResolvedValue({ data: null, error: null } as never);
  await expect(new KnowledgeEditor(db).deleteBranch('tenant-a', 'ar', 'branch-id')).rejects.toThrow('Could not delete');
  q.single.mockRejectedValue(new Error('Network unavailable'));
  await expect(new KnowledgeEditor(db).deleteBranch('tenant-a', 'ar', 'branch-id')).rejects.toThrow('Network unavailable');
});
