import type { AgentDecision } from '../ai/contracts';
export interface IncomingMessage {
  phoneNumberId: string;
  providerMessageId: string;
  from: string;
  displayName?: string;
  occurredAt: string;
  type: string;
  text: string | null;
}
export interface DeliveryStatus {
  phoneNumberId: string;
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  occurredAt: string;
  errorCode?: string;
}
export interface MessageJob {
  id: string;
  tenant_id: string;
  inbound_message_id: string;
  lease_token: string;
  automation_epoch?: number;
}
export interface PreparedReply {
  outbound_id: string;
  phone_number_id: string;
  recipient: string;
  body: string;
}
export interface MessageContext {
  followUp?: import('../ai/follow-up').FollowUpContext;
  requestKey?: string;
  eligible?: boolean;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  tenantId: string;
  conversationId: string;
  text: string | null;
  type: string;
}
export interface MessagingRepository {
  ingest(message: IncomingMessage): Promise<void>;
  recordStatus(status: DeliveryStatus): Promise<void>;
  claim(): Promise<MessageJob | null>;
  context(job: MessageJob): Promise<MessageContext>;
  prepare(job: MessageJob, text: string): Promise<PreparedReply | null>;
  prepareDecision?(job: MessageJob, decision: AgentDecision): Promise<PreparedReply | null>;
  complete(job: MessageJob, providerMessageId: string): Promise<void>;
  fail(job: MessageJob, state: "failed" | "needs_review", code: string): Promise<void>;
}
export interface ReplyStrategy { reply(context: MessageContext): Promise<string | AgentDecision> }
export interface MessageSender { send(reply: PreparedReply): Promise<string> }
