import { equalSecret } from '../whatsapp/security';
import { acceptanceCases, checkAcceptance, type AcceptanceCaseId } from './acceptance';
import type { AgentDecision } from './contracts';
import type { MessageContext } from '../messaging/types';
import type { KnowledgeSource } from './contracts';
export async function handleAcceptance(request: Request, options: {
  secret?: string; enabled: boolean;
  resolveTenant: () => Promise<string>;
  run: (context: MessageContext, sources: KnowledgeSource[]) => Promise<AgentDecision>;
}) {
  if (!options.secret || options.secret.length < 32) return new Response('Not configured', { status: 503 });
  if (!equalSecret(request.headers.get('authorization') ?? '', `Bearer ${options.secret}`)) return new Response('Unauthorized', { status: 401 });
  if (!options.enabled) return new Response('Not enabled', { status: 404 });
  try {
    const reader = request.body?.getReader(); if (!reader) return new Response('Case required', { status: 400 });
    let body = ''; let size = 0; const decoder = new TextDecoder();
    while (true) { const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 1024) { await reader.cancel(); return new Response('Too large', { status: 413 }); }
      body += decoder.decode(value, { stream: true });
    }
    const input = JSON.parse(body + decoder.decode());
    if (!input || typeof input.case !== 'string' || !Object.hasOwn(acceptanceCases,input.case) || Object.keys(input).some(k => k !== 'case')) return new Response('Invalid case', { status: 400 });
    const id = input.case as AcceptanceCaseId; const fixture = acceptanceCases[id];
    const tenant = await options.resolveTenant();
    const decision = await options.run({ tenantId: tenant, conversationId: 'isolated-acceptance',
      requestKey: `acceptance:v1:${id}`, text: fixture.text, type: 'text', eligible: true,
      history: 'history' in fixture ? fixture.history : [],
    }, fixture.sources);
    return Response.json({ case: id, checks: checkAcceptance(id,decision), decision }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return new Response('Acceptance unavailable', { status: 503 }); }
}
