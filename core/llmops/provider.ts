import { ProviderHttpError } from './errors.js';
import { config, embeddingsEnabled, generationEnabled } from '../../gateway/config.js';
export type Message = { role: 'system' | 'user'; content: string };
async function request(path: string, body: unknown, baseUrl = config.LLM_BASE_URL, apiKey = config.LLM_API_KEY, timeoutMs = 60000, signal?: AbortSignal) {
  const response = await fetch(baseUrl.replace(/\/$/, '') + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), redirect: 'error'
  });
  if (!response.ok) { await response.body?.cancel(); throw new ProviderHttpError(response.status); }
  return response.json() as Promise<any>;
}
export { configuredModels, createChatProvider } from './registry.js';
import { createChatProvider } from './registry.js';
export async function generate(messages: Message[], maxTokens = 3000, model = config.LLM_MODEL) {
  if (!generationEnabled()) throw new Error('Modelo de geração não configurado.');
  // Compatibility entry point: selected legacy provider, no automatic fallback.
  const local = config.LLM_PROVIDER === 'ollama';
  const provider = createChatProvider({
    id: 'legacy', provider: config.LLM_PROVIDER, model, local,
    capabilities: { text: true, structuredOutput: true, vision: false, coding: false, toolUse: false, longContext: false, embeddings: false },
    baseUrl: local ? config.OLLAMA_BASE_URL : config.LLM_PROVIDER === 'anthropic' ? config.ANTHROPIC_BASE_URL : config.LLM_BASE_URL,
    apiKey: local ? '' : config.LLM_PROVIDER === 'anthropic' ? config.ANTHROPIC_API_KEY : config.LLM_API_KEY
  });
  const result = await provider.invoke({ messages, maxTokens, format: 'json' });
  let data: unknown;
  try { data = JSON.parse(result.text); } catch { throw new Error('O modelo não retornou JSON válido.'); }
  return { data, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}
export async function embed(texts: string[], options: { attempts?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<number[][]> {
  if (!embeddingsEnabled()) return [];
  // A local endpoint (e.g. Ollama) keeps embeddings offline, off the paid chat provider; CPU inference is slower, so allow more time and a retry.
  const baseUrl = config.EMBEDDING_BASE_URL || config.LLM_BASE_URL;
  const apiKey = config.EMBEDDING_BASE_URL ? config.EMBEDDING_API_KEY : config.LLM_API_KEY;
  const timeoutMs = options.timeoutMs ?? (config.EMBEDDING_BASE_URL ? 180000 : 60000);
  let result: any;
  for (let attempt = 1; ; attempt++) {
    try { result = await request('/embeddings', { model: config.EMBEDDING_MODEL, input: texts }, baseUrl, apiKey, timeoutMs, options.signal); break; }
    catch (error) { if (attempt >= (options.attempts ?? 3)) throw error; await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); }
  }
  if (!Array.isArray(result.data) || result.data.length !== texts.length) throw new Error('Quantidade inválida de embeddings.');
  const sorted = [...result.data].sort((a, b) => a.index - b.index);
  const vectors = sorted.map((d, i) => {
    if (d.index !== i || !Array.isArray(d.embedding) || !d.embedding.length || !d.embedding.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))) throw new Error('Embedding inválido.');
    return d.embedding as number[];
  });
  if (vectors.some(v => v.length !== vectors[0].length)) throw new Error('Dimensões de embeddings inconsistentes.');
  return vectors;
}
