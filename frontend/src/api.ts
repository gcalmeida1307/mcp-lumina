import { authHeaders } from './auth';
import type { ConversationTurn, Run, TraceStep } from '../../core/types';
export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, { ...init, headers: { ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...await authHeaders(), ...init?.headers } });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error('Sua sessão expirou. Entre novamente.');
    throw new Error(result.error ?? 'Não foi possível concluir a operação.');
  }
  return response.status === 204 ? undefined as T : response.json();
}
export async function ask(question: string, domain: string, agent: boolean, history: ConversationTurn[], conversationId: string, onStep: (s: TraceStep) => void, signal?: AbortSignal): Promise<Run> {
  const response = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...await authHeaders() },
    body: JSON.stringify({ question, domain, agent, history, conversationId }), signal
  });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error ?? 'Erro ao consultar.'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Streaming indisponível.');
  const decoder = new TextDecoder(); let pending = '', result: Run | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      pending += decoder.decode(value, { stream: true });
      const events = pending.split('\n\n'); pending = events.pop() ?? '';
      for (const event of events) {
        const kind = event.split('\n').find(l => l.startsWith('event: '))?.slice(7);
        const data = event.split('\n').find(l => l.startsWith('data: '))?.slice(6);
        if (!data) continue;
        const parsed = JSON.parse(data);
        if (kind === 'step') onStep(parsed);
        if (kind === 'result') result = parsed;
        if (kind === 'error') throw new Error(parsed.error);
      }
    }
  } finally { await reader.cancel(); }
  if (!result) throw new Error('A conexão foi interrompida antes da resposta.');
  return result;
}
