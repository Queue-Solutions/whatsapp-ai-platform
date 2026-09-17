import type { ReplyStrategy, MessageContext } from '../messaging/types';
export type CustomerAgent = ReplyStrategy;
export type AgentAction = 'answer' | 'clarify' | 'unavailable' | 'handoff' | 'suppress';
export interface SourceReference { id: string; kind: 'faq' | 'fact'; updatedAt: string }
export interface KnowledgeSource extends SourceReference { label: string; content: string }
export interface AgentDecision {
  text: string;
  action: AgentAction;
  reason: string;
  sources: SourceReference[];
  attentionSummary?: string;
  followUp?: import('./follow-up').FollowUpDetails;
  usage?: { model: string; inputTokens: number; outputTokens: number; costNano: number };
}
export interface KnowledgeRetriever {
  search(input: Pick<MessageContext,'tenantId'> & { query: string; locale?: string }): Promise<Array<{
    sourceId: string; content: string; updatedAt: string;
  }>>;
}
export interface ConversationAssessment {
  tenantId: string; conversationId: string;
  leadIntent: { score: number; reason: string } | null;
  inferredSentiment: 'positive' | 'neutral' | 'negative' | null;
}
export interface CustomerSatisfactionResponse {
  tenantId: string; conversationId: string; score: 1|2|3|4|5; sourceMessageId: string; receivedAt: string;
}
