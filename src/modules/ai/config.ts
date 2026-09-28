export const AI_MODEL = 'gpt-5.4-mini-2026-03-17';
export const AI_REASONING_EFFORT = 'none' as const;
export const PROMPT_VERSION = 'approved-knowledge-v21-gpt-5.4-mini';
export const MAX_INPUT_TOKENS = 24000;
export const MAX_OUTPUT_TOKENS = 2000;
export const INPUT_COST_NANO_PER_TOKEN = 750;
export const OUTPUT_COST_NANO_PER_TOKEN = 4500;
// Byte-level input bound + large framing/schema margin underpins the reservation.
export const MAX_REQUEST_BYTES = 22000;
export const MAX_KNOWLEDGE_BYTES = 8500;
export const RESERVED_NANO = MAX_INPUT_TOKENS * INPUT_COST_NANO_PER_TOKEN + MAX_OUTPUT_TOKENS * OUTPUT_COST_NANO_PER_TOKEN;
export function modelCostNano(inputTokens:number,outputTokens:number){
  return inputTokens*INPUT_COST_NANO_PER_TOKEN+outputTokens*OUTPUT_COST_NANO_PER_TOKEN;
}
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
