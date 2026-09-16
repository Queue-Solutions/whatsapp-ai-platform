import type { KnowledgeSource } from './contracts';
import type { MessageContext } from '../messaging/types';
import { MAX_KNOWLEDGE_BYTES } from './config';
import { buildRequest } from './openai';

// Local ranking only: no additional model calls, embeddings or outside knowledge.
const topics = [
  'branch branches location locations address addresses store stores فرع الفرع فروع الفروع فروعكم افرع عنوان العنوان عناوين عناوينكم مكان اماكن فين',
  'hours opening open close closing time times مواعيد ساعات يفتح يقفل فاتحين',
  'price prices pricing cost costs سعر اسعار بكام كام تكلفه',
  'contact phone telephone call number تواصل تليفون تلفون هاتف رقم',
  'delivery shipping deliver توصيل شحن',
  'return returns refund refunds exchange استرجاع استبدال',
  'appointment appointments book booking reservation حجز موعد',
  'payment payments pay cash card دفع كاش فيزا',
  'offer offers discount discounts sale عروض خصم خصومات',
  'service services product products خدمه خدمات منتج منتجات',
];
const stopWords = new Set('a an the is are do does i we you your ur our and or to for of in on at it what which can please about me my this that اي ايه هو هي هل من في علي لو انا انت عندكم ممكن'.split(' '));
function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .match(/[\p{L}\p{N}]+/gu)?.filter(word => !stopWords.has(word) && word.length > 1) ?? []);
}
const topicTokens = topics.map(tokens);
function expand(words: Set<string>) {
  const result = new Set(words);
  for (const group of topicTokens) if ([...words].some(word => group.has(word))) {
    for (const word of group) result.add(word);
  }
  return result;
}
function searchable(source: KnowledgeSource) {
  try {
    const data = JSON.parse(source.content);
    return { words: tokens(source.content), title: tokens(String(data.question ?? data.value?.name ?? '')),
      branch: source.kind === 'fact' && data.category === 'branch' };
  } catch {
    return { words: tokens(source.content), title: new Set<string>(), branch: false };
  }
}
export function selectKnowledge(context: MessageContext, available: KnowledgeSource[]) {
  const query = tokens(context.text ?? '');
  const expanded = expand(query);
  // Previous customer messages help resolve short follow-ups, but never outrank the latest question.
  const history = expand(tokens((context.history ?? []).filter(message => message.role === 'user').slice(-2).map(message => message.content).join(' ')));
  const indexed = available.map(source => ({ source, ...searchable(source) }));
  const frequency = new Map<string, number>();
  for (const entry of indexed) for (const word of entry.words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const branchQuery = [...query].some(word => topicTokens[0].has(word));
  const ranked = indexed.map(entry => {
    let score = branchQuery && entry.branch ? 1000 : 0;
    for (const word of entry.words) {
      const rarity = 1 + Math.log(1 + available.length / (frequency.get(word) ?? 1));
      score += rarity * (query.has(word) ? 30 : expanded.has(word) ? 8 : history.has(word) ? 1 : 0);
      if (entry.title.has(word) && query.has(word)) score += 50 * rarity;
    }
    return { ...entry, score };
  }).sort((a, b) => b.score - a.score || a.source.label.localeCompare(b.source.label, 'en', { numeric: true }));
  const sources: KnowledgeSource[] = [];
  const coverage = (selected: KnowledgeSource[]) => ({
    omittedSourceCount: available.length - selected.length,
    branchDirectoryComplete: indexed.filter(entry => entry.branch).every(entry => selected.includes(entry.source)),
  });
  for (const entry of ranked) {
    if (sources.length === 40) break;
    const candidate = [...sources, entry.source];
    if (Buffer.byteLength(JSON.stringify(candidate.map(({ label, content }) => ({ label, content }))), 'utf8') > MAX_KNOWLEDGE_BYTES) continue;
    // Include escaping, history, instructions and schema in the final request bound.
    try { buildRequest(context, candidate, coverage(candidate)); } catch { continue; }
    sources.push(entry.source);
  }
  // Keep whole records, versions and labels intact; never truncate a policy or its exceptions.
  return { sources, coverage: coverage(sources) };
}
