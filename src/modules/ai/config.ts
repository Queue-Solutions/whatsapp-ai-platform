export const AI_MODEL = 'gpt-4.1-mini-2025-04-14';
export const PROMPT_VERSION = 'approved-knowledge-v11-btc-catalog';
export const MAX_INPUT_TOKENS = 24000;
export const MAX_OUTPUT_TOKENS = 650;
// Byte-level input bound + large framing/schema margin underpins the reservation.
export const MAX_REQUEST_BYTES = 22000;
export const MAX_KNOWLEDGE_BYTES = 8500;
export const RESERVED_NANO = MAX_INPUT_TOKENS * 400 + MAX_OUTPUT_TOKENS * 1600;
export function readAiMode(source: Record<string,string|undefined> = process.env) {
  const mode = source.WHATSAPP_REPLY_MODE ?? 'echo';
  if (mode !== 'echo' && mode !== 'ai') throw new Error('Invalid reply mode');
  return mode;
}
export function readAiKey(source: Record<string,string|undefined> = process.env) {
  const key = source.OPENAI_API_KEY;
  if (!key || key.length < 20) throw new Error('OpenAI is not configured');
  return key;
}
