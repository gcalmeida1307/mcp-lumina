import { config, embeddingsEnabled, generationEnabled } from '../../gateway/config.js';
export type Message = { role: 'system' | 'user'; content: string };
async function request(path: string, body: unknown, baseUrl = config.LLM_BASE_URL, apiKey = config.LLM_API_KEY, timeoutMs = 60000, signal?: AbortSignal) {
  const response = await fetch(baseUrl.replace(/\/$/, '') + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), redirect: 'error'
  });
  if (!response.ok) throw new Error('Provedor de IA retornou HTTP ' + response.status + '. Verifique a configuração no servidor.');
  return response.json() as Promise<any>;
}
async function anthropicRequest(messages: Message[], maxTokens: number, model = config.LLM_MODEL) {
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const response = await fetch(config.ANTHROPIC_BASE_URL.replace(/\/$/, '') + '/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, system, messages: messages.filter(message => message.role !== 'system'), temperature: 0, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(60000), redirect: 'error'
  });
  if (!response.ok) throw new Error('Provedor de IA retornou HTTP ' + response.status + '. Verifique a configuração no servidor.');
  return response.json() as Promise<any>;
}
export async function generate(messages: Message[], maxTokens = 3000, model = config.LLM_MODEL) {
  if (!generationEnabled()) throw new Error('Modelo de geração não configurado.');
  const result = config.LLM_PROVIDER === 'anthropic' ? await anthropicRequest(messages, maxTokens, model) : await request('/chat/completions', {
    model, messages, temperature: 0,
    response_format: { type: 'json_object' }, max_tokens: maxTokens
  }, config.LLM_PROVIDER === 'ollama' ? config.OLLAMA_BASE_URL : config.LLM_BASE_URL, config.LLM_PROVIDER === 'ollama' ? '' : config.LLM_API_KEY, config.LLM_PROVIDER === 'ollama' ? 180000 : 60000);
  const content = config.LLM_PROVIDER === 'anthropic' ? result.content?.find((block: any) => block.type === 'text')?.text : result.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Resposta vazia do provedor.');
  let data: unknown;
  try { data = JSON.parse(content); } catch { throw new Error('O modelo não retornou JSON válido.'); }
  return { data, inputTokens: Number(result.usage?.input_tokens ?? result.usage?.prompt_tokens ?? 0), outputTokens: Number(result.usage?.output_tokens ?? result.usage?.completion_tokens ?? 0) };
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
