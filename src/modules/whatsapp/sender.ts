import type { Environment } from "@/config/env";
import { asConnection, type WhatsAppConnection } from '@/config/whatsapp-connections';
import type { MessageSender, PreparedReply } from "../messaging/types";
import { allowedRecipient, bsuidPattern } from './identity';
export class SendError extends Error {
  constructor(public readonly ambiguous: boolean, public readonly code: string) { super(code); }
}
export class MetaMessageSender implements MessageSender {
  private connection: WhatsAppConnection;
  constructor(input: Environment | WhatsAppConnection, private request: typeof fetch = fetch) {
    this.connection = asConnection(input);
  }
  async send(reply: PreparedReply): Promise<string> {
    const connection = this.connection;
    const validMode = connection.mode === 'test' || (connection.mode === 'pilot' && !!connection.tenantId && reply.tenant_id === connection.tenantId);
    if (!validMode || !connection.sendEnabled || reply.phone_number_id !== connection.phoneNumberId ||
      !allowedRecipient(reply.recipient,reply.recipient_aliases??[],connection.recipients)) {
      throw new SendError(false, connection.mode === 'test' ? 'test_guard_rejected' : 'pilot_guard_rejected');
    }
    let response: Response;
    try {
      response = await this.request(`https://graph.facebook.com/${connection.graphVersion}/${reply.phone_number_id}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${connection.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual",
          ...(bsuidPattern.test(reply.recipient)?{recipient:reply.recipient}:{to:reply.recipient}),
          type: "text", text: { preview_url: false, body: reply.body } }),
        signal: AbortSignal.timeout(8000),
      });
    } catch { throw new SendError(true, "network_outcome_unknown"); }
    if (!response.ok) {
      let code = `meta_http_${response.status}`;
      // Keep only numeric provider codes; response text can contain private data.
      try {
        const data = await response.json();
        if (Number.isSafeInteger(data.error?.code)) code += `_code_${data.error.code}`;
        if (Number.isSafeInteger(data.error?.error_subcode)) code += `_subcode_${data.error.error_subcode}`;
      } catch { /* Non-JSON errors retain the HTTP status. */ }
      throw new SendError(response.status >= 500, code);
    }
    try {
      const data = await response.json();
      if (typeof data.messages?.[0]?.id !== "string") throw new Error();
      return data.messages[0].id;
    } catch { throw new SendError(true, "meta_response_unknown"); }
  }
}

/** Manual replies select credentials only after the database has prepared a guarded send. */
export class ConfiguredMetaMessageSender implements MessageSender {
  constructor(private connections: WhatsAppConnection[], private request: typeof fetch = fetch) {}
  async send(reply: PreparedReply): Promise<string> {
    const connection = this.connections.find(c => c.phoneNumberId === reply.phone_number_id
      && (c.mode === 'test' || c.tenantId === reply.tenant_id));
    if (!connection) throw new SendError(false, 'channel_guard_rejected');
    return new MetaMessageSender(connection, this.request).send(reply);
  }
}
