import { authHeaders } from './auth';
import type { ConversationTurn, Run, TraceStep } from '../../core/types';
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
function chatError(payload: { error?: string; requestId?: string }, fallback = 'Erro ao consultar.') {
  return new Error((payload.error ?? fallback) + (payload.requestId ? ' Referência: ' + payload.requestId : ''));
}
export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, { ...init, headers: { ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...await authHeaders(), ...init?.headers } });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) throw new ApiError('Sua sessão expirou. Entre novamente.', 401);
    throw new ApiError(result.error ?? 'Não foi possível concluir a operação.', response.status);
  }
  return response.status === 204 ? undefined as T : response.json();
}
export async function ask(question: string, domain: string, agent: boolean, history: ConversationTurn[], conversationId: string, onStep: (s: TraceStep) => void, signal?: AbortSignal): Promise<Run> {
  const response = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...await authHeaders() },
    // The server restores trusted history by owner, domain and conversation ID.
    body: JSON.stringify({ question, domain, agent, conversationId }), signal
  });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw response.status === 401 ? new Error('Sua sessão expirou. Entre novamente.') : chatError(error); }
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
        if (kind === 'error') throw chatError(parsed);
      }
    }
  } finally { await reader.cancel(); }
  if (!result) throw new Error('A conexão foi interrompida antes da resposta.');
  return result;
}
