import { ModelConfigurationError, ModelOutputError } from './errors.js';

export type ModelCapabilities = {
  text: boolean; vision: boolean; structuredOutput: boolean; toolUse: boolean;
  longContext: boolean; coding: boolean; embeddings: boolean;
};
export type ModelRole = 'understand' | 'structured' | 'reason' | 'vision' | 'code' | 'respond' | 'review';
export type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type ModelRequest = {
  messages: ModelMessage[]; maxTokens?: number; temperature?: number; signal?: AbortSignal;
  format?: 'text' | 'json'; images?: { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string }[];
  /** Validate the consumer's contract before accepting a candidate's JSON. */
  validate?: (data: unknown) => unknown;
};
export type ModelResult = { text: string; data?: unknown; inputTokens: number; outputTokens: number };
export type ModelProvider = {
  id: string; provider: 'ollama' | 'openai' | 'anthropic' | 'gemini'; model: string;
  /** Explicit family, e.g. llama, qwen, gpt, claude, gemini. Transport is not a family. */
  family?: string; local: boolean; capabilities: ModelCapabilities;
  invoke(request: ModelRequest): Promise<ModelResult>;
  embed?(texts: string[]): Promise<number[][]>;
};
export type ModelPolicy = {
  mode: 'LOCAL' | 'HYBRID' | 'ENSEMBLE'; allowRemote: boolean; allowFallback: boolean;
  routes?: Partial<Record<ModelRole | 'embed', string>>;
  /** Cross-family review is opt-in even in ENSEMBLE. No voting or automatic fan-out. */
  crossFamilyReview?: boolean;
  /** Leave time for an authorized fallback within the overall investigation budget. */
  fallbackTimeoutMs?: number;
};
const capability: Record<ModelRole, keyof ModelCapabilities> = {
  understand: 'structuredOutput', structured: 'structuredOutput', reason: 'text',
  vision: 'vision', code: 'coding', respond: 'text', review: 'structuredOutput'
};
export class ModelRegistry {
  private entries = new Map<string, ModelProvider>();
  private failed = new Set<string>();
  constructor(readonly policy: ModelPolicy = { mode: 'LOCAL', allowRemote: false, allowFallback: false }) {}
  register(model: ModelProvider) {
    if (this.entries.has(model.id)) throw new Error(`Modelo duplicado: ${model.id}`);
    if (model.capabilities.embeddings && !model.embed) throw new Error('Capacidade embeddings sem implementação.');
    this.entries.set(model.id, model);
    return this;
  }
  private candidates(role: ModelRole | 'embed', request?: ModelRequest, author?: string) {
    const family = author ? this.entries.get(author)?.family : undefined;
    if (author && (!this.policy.crossFamilyReview || !family)) throw new Error('Revisão entre famílias não autorizada ou família desconhecida.');
    const required = role === 'embed' ? 'embeddings' : capability[role];
    const allowed = [...this.entries.values()].filter(model =>
      (model.local || (this.policy.mode !== 'LOCAL' && this.policy.allowRemote)) &&
      model.capabilities[required] && (!request?.images?.length || model.capabilities.vision) &&
      (request?.format !== 'json' || model.capabilities.structuredOutput) &&
      (!author || (model.family && model.family !== family))
    ).sort((a, b) => Number(b.local) - Number(a.local));
    const preferred = this.policy.routes?.[role];
    if (preferred) {
      const index = allowed.findIndex(model => model.id === preferred);
      if (index < 0) throw new Error(`Rota indisponível ou proibida: ${role}`);
      allowed.unshift(...allowed.splice(index, 1));
    }
    if (!allowed.length) {
      const blockedRemote = [...this.entries.values()].some(model => !model.local && model.capabilities[required]) &&
        (this.policy.mode === 'LOCAL' || !this.policy.allowRemote);
      throw new ModelConfigurationError(blockedRemote
        ? 'Nenhum modelo autorizado: a política atual bloqueia o provedor remoto configurado. Configure um modelo local ou, para usar o provedor remoto, defina MODEL_MODE=HYBRID e MODEL_ALLOW_REMOTE=true e reinicie a API.'
        : 'Nenhum modelo autorizado com capacidade para ' + role + '. Verifique a configuração dos modelos no servidor e reinicie a API.');
    }
    return allowed;
  }
  async run(role: ModelRole, request: ModelRequest, author?: string) {
    if (author && role !== 'review') throw new Error('Família independente somente em revisão.');
    const format = ['understand', 'structured', 'review'].includes(role) ? 'json' : request.format ?? 'text';
    const input = { ...request, format } as ModelRequest;
    // A registry belongs to one investigation. Do not spend its budget retrying
    // the same timed-out provider at every interpretation/generation/review step.
    const candidates = this.candidates(role, input, author).sort((a, b) => Number(this.failed.has(a.id)) - Number(this.failed.has(b.id)));
    for (let i = 0; i < candidates.length; i++) {
      input.signal?.throwIfAborted();
      // Only a local candidate needs a short leash before falling back; a remote candidate is the
      // reliable option and should get the real remaining budget regardless of its position in the list.
      const canFallback = this.policy.allowFallback && candidates[i].local && i < candidates.length - 1;
      const attemptTimeout = canFallback ? AbortSignal.timeout(this.policy.fallbackTimeoutMs ?? 30000) : undefined;
      const signal = attemptTimeout
        ? input.signal ? AbortSignal.any([input.signal, attemptTimeout]) : attemptTimeout
        : input.signal;
      let error: unknown;
      // With no further fallback left, retry this same candidate once on a malformed reply before giving up.
      const attempts = i === candidates.length - 1 ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const result = await candidates[i].invoke({ ...input, signal });
          signal?.throwIfAborted();
          // Validate the protocol even when a custom adapter returns only text.
          if (format === 'json') {
            try {
              result.data = JSON.parse(result.text);
              if (input.validate) result.data = input.validate(result.data);
            } catch { throw new ModelOutputError(); }
          }
          return { ...result, modelId: candidates[i].id, family: candidates[i].family };
        } catch (caught) {
          error = caught;
          if (!(caught instanceof ModelOutputError) || input.signal?.aborted) break;
        }
      }
      // Local inference is a single serialized slot: a client-side abort does not free it, so a
      // stale request keeps the server busy. Never risk queuing behind it again this investigation.
      if (candidates[i].local || attemptTimeout?.aborted || error instanceof ModelOutputError) this.failed.add(candidates[i].id);
      if (input.signal?.aborted || !this.policy.allowFallback || i === candidates.length - 1) throw error;
    }
    throw new Error('Nenhum modelo disponível.');
  }
  understand(request: ModelRequest) { return this.run('understand', request); }
  structured(request: ModelRequest) { return this.run('structured', request); }
  reason(request: ModelRequest) { return this.run('reason', request); }
  vision(request: ModelRequest) { return this.run('vision', request); }
  code(request: ModelRequest) { return this.run('code', request); }
  respond(request: ModelRequest) { return this.run('respond', request); }
  review(request: ModelRequest, author: string) { return this.run('review', request, author); }
  async embed(texts: string[]) {
    // Embedding spaces cannot be silently switched by fallback.
    return this.candidates('embed')[0].embed!(texts);
  }
}
