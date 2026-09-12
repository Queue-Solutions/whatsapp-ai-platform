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
import { KnowledgeEditor } from '../src/modules/admin/knowledge-editor';
import type { SupabaseClient } from '@supabase/supabase-js';
import { vi } from 'vitest';

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
