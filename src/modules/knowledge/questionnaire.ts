import { z } from 'zod';

export const starterQuestions = [
  ['about', 'What does your business do, and which products or services do you offer?'],
  ['services', 'Which services or products are available at each branch?'],
  ['prices', 'What prices or price ranges may we share with customers?'],
  ['appointments', 'How can customers book, change or cancel an appointment?'],
  ['walk_ins', 'Do customers need an appointment, or are walk-ins welcome?'],
  ['payments', 'Which payment methods do you accept? Are deposits required?'],
  ['delivery', 'Do you offer delivery? Which areas, fees and delivery times apply?'],
  ['returns', 'What are your return, exchange, cancellation and refund policies?'],
  ['offers', 'Are there any current offers? What are their conditions and expiry dates?'],
  ['preparation', 'What should customers bring or prepare before their visit?'],
  ['accessibility', 'What parking and accessibility facilities are available at each branch?'],
  ['contact', 'How can customers contact your team or request help from a person?'],
] as const;

export const branchFields = [
  ['name', 'What is this branch called?'],
  ['city', 'Which city is this branch in?'],
  ['address', 'What is the full street address?'],
  ['hours', 'What are the opening and closing times for each day?'],
  ['exceptions', 'Are there weekly closing days or special holiday hours?'],
  ['phone', 'What is the branch contact number?'],
  ['mapsUrl', 'What is the Google Maps link for this location?'],
] as const;

const text = z.string().max(10000);
export const branchSchema = z.object({
  name: z.string().max(200), city: z.string().max(100).optional(), address: text, hours: text,
  exceptions: text, phone: z.string().max(100),
  mapsUrl: z.string().max(2048).refine(value => {
    if (!value.trim()) return true;
    try {
      const url = new URL(value);
      const host = url.hostname;
      return url.protocol === 'https:' && !url.username && !url.password && (
        host === 'maps.app.goo.gl' || (host === 'goo.gl' && url.pathname.startsWith('/maps')) ||
        host === 'maps.google.com' || (['google.com', 'www.google.com'].includes(host) && url.pathname.startsWith('/maps'))
      );
    } catch { return false; }
  }, 'Use an HTTPS Google Maps link, or leave this field blank.'),
});
export type BranchValue = z.infer<typeof branchSchema>;
export type Faq = { id: string; question: string; answer: string; is_published: boolean; updated_at?: string };
export type Branch = { id: string; fact_key: string; value: BranchValue; is_published: boolean; updated_at?: string };
export const emptyBranch = (): BranchValue => ({ name: '', city: '', address: '', hours: '', exceptions: '', phone: '', mapsUrl: '' });

export function validateFaq(faq: Faq, publish: boolean) {
  if (!faq.question.trim() || faq.question.length > 1000 || faq.answer.length > 10000)
    throw new Error('Add a question (up to 1,000 characters) and keep the answer under 10,000 characters.');
  if (publish && !faq.answer.trim()) throw new Error('Add an answer before approving this question.');
}
export function validateBranch(value: BranchValue, publish: boolean) {
  const parsed = branchSchema.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  if (publish && (!value.name.trim() || !value.address.trim() || !value.hours.trim()))
    throw new Error('Add the branch name, address and opening hours before approving it.');
}

// A stable tenant/locale-scoped ID keeps repeated starter saves from creating duplicates.
export async function starterFaqs(tenantId: string, locale: string): Promise<Faq[]> {
  return Promise.all(starterQuestions.map(async ([key, question]) => {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`queue-faq-v1:${tenantId}:${locale}:${key}`)));
    hash[6] = (hash[6] & 15) | 80; hash[8] = (hash[8] & 63) | 128;
    const hex = Array.from(hash.slice(0, 16), n => n.toString(16).padStart(2, '0')).join('');
    const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    return { id, question, answer: '', is_published: false };
  }));
}
