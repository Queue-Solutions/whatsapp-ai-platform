import type { Environment } from "@/config/env";
import type { MessageSender, PreparedReply } from "../messaging/types";
import { allowedRecipient, bsuidPattern } from './identity';
export class SendError extends Error {
  constructor(public readonly ambiguous: boolean, public readonly code: string) { super(code); }
}
export class MetaMessageSender implements MessageSender {
  constructor(private env: Environment, private request: typeof fetch = fetch) {}
  async send(reply: PreparedReply): Promise<string> {
    if (this.env.WHATSAPP_MODE !== "test" || reply.phone_number_id !== this.env.WHATSAPP_TEST_PHONE_NUMBER_ID ||
      !allowedRecipient(reply.recipient,reply.recipient_aliases??[],this.env.WHATSAPP_TEST_RECIPIENTS)) throw new SendError(false, "test_guard_rejected");
    let response: Response;
    try {
      response = await this.request(`https://graph.facebook.com/${this.env.META_GRAPH_API_VERSION}/${reply.phone_number_id}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
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
