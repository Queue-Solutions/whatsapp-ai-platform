import type { ReplyStrategy, MessageContext } from '../messaging/types';
/** Future OpenAI adapter implements ReplyStrategy; echo remains the development default. */
export type CustomerAgent = ReplyStrategy;
export interface AgentDecision {
  text:string;
  handoffRequested:boolean;
  sourceIds:string[];
  usage:{model:string;inputTokens:number;outputTokens:number};
}
export interface KnowledgeRetriever {
  search(input:Pick<MessageContext,'tenantId'> & {query:string;locale?:string}):Promise<Array<{
    sourceId:string;content:string;updatedAt:string;
  }>>;
}
/** Explicit customer ratings and inferred signals must remain separate. */
export interface ConversationAssessment {
  tenantId:string;conversationId:string;
  leadIntent:{score:number;reason:string}|null;
  inferredSentiment:'positive'|'neutral'|'negative'|null;
}
export interface CustomerSatisfactionResponse {
  tenantId:string;conversationId:string;score:1|2|3|4|5;sourceMessageId:string;receivedAt:string;
}
