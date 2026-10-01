import { config, generationEnabled } from '../../gateway/config.js';
import { ProviderHttpError } from './errors.js';
import { ModelRegistry, type ModelProvider, type ModelRequest } from './models.js';

/** Provider-specific transport stays here; consumers select capabilities. */
export function createChatProvider(options: Omit<ModelProvider, 'invoke' | 'embed'> & { baseUrl: string; apiKey?: string }): ModelProvider {
  return { ...options, async invoke(input: ModelRequest) {
    // Safety net for a local-only setup with no fallback; with a fallback configured, the local
    // candidate is now blacklisted after a single slow/failed attempt and never retried (see models.ts).
    const timeout = AbortSignal.timeout(options.local ? 180000 : 60000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    if (options.provider === 'ollama') {
      // Reasoning models (e.g. Qwen3) emit a separate "thinking" trace that can consume the whole
      // token budget and leave content empty; the OpenAI-compatible shim has no way to disable it,
      // so the native API is used here with think:false.
      const host = options.baseUrl.replace(/\/v1\/?$/, '');
      const response = await fetch(host.replace(/\/$/, '') + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model, stream: false, think: false,
          messages: [...input.messages, ...(input.images?.length ? [{ role: 'user', content: '', images: input.images.map(image => image.base64) }] : [])],
          ...(input.format === 'json' ? { format: 'json' } : {}),
          // Default Ollama context (4096) truncates the larger evidence payloads sent during investigation.
          options: { temperature: input.temperature ?? 0, num_predict: input.maxTokens ?? 3000, num_ctx: 8192 }
        }), signal, redirect: 'error'
      });
      if (!response.ok) { await response.body?.cancel(); throw new ProviderHttpError(response.status); }
      const result: any = await response.json();
      const text = result.message?.content;
      if (typeof text !== 'string' || !text.length) throw new Error('Resposta vazia do provedor.');
      return { text, inputTokens: Number(result.prompt_eval_count ?? 0), outputTokens: Number(result.eval_count ?? 0) };
    }
    const messages = input.format === 'json'
      ? [...input.messages, { role: 'system' as const, content: 'Retorne somente JSON válido, sem markdown.' }]
      : input.messages;
    const anthropic = options.provider === 'anthropic';
    const body = anthropic ? {
      model: options.model, system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
      messages: [...messages.filter(m => m.role !== 'system'), ...(input.images?.length ? [{ role: 'user', content: input.images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } })) }] : [])],
      temperature: input.temperature ?? 0, max_tokens: input.maxTokens ?? 3000
    } : {
      model: options.model,
      messages: [...messages, ...(input.images?.length ? [{ role: 'user', content: input.images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } })) }] : [])],
      temperature: input.temperature ?? 0, max_tokens: input.maxTokens ?? 3000,
      ...(input.format === 'json' ? { response_format: { type: 'json_object' } } : {})
    };
    const response = await fetch(options.baseUrl.replace(/\/$/, '') + (anthropic ? '/v1/messages' : '/chat/completions'), {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(anthropic ? { 'x-api-key': options.apiKey ?? '', 'anthropic-version': '2023-06-01' } : options.apiKey ? { Authorization: 'Bearer ' + options.apiKey } : {}) },
      body: JSON.stringify(body), signal, redirect: 'error'
    });
    if (!response.ok) { await response.body?.cancel(); throw new ProviderHttpError(response.status); }
    const result: any = await response.json();
    const text = anthropic ? result.content?.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') : result.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.length) throw new Error('Resposta vazia do provedor.');
    return { text, inputTokens: Number(result.usage?.input_tokens ?? result.usage?.prompt_tokens ?? 0), outputTokens: Number(result.usage?.output_tokens ?? result.usage?.completion_tokens ?? 0) };
  } };
}

/** Optional providers can also be registered explicitly by the composition root. */
export function configuredModels() {
  const registry = new ModelRegistry({ mode: config.MODEL_MODE, allowRemote: config.MODEL_ALLOW_REMOTE, allowFallback: config.MODEL_ALLOW_FALLBACK, fallbackTimeoutMs: config.MODEL_FALLBACK_TIMEOUT_MS });
  const capabilities = { text: true, structuredOutput: true, vision: config.MODEL_VISION, coding: config.MODEL_CODING, toolUse: false, longContext: false, embeddings: false };
  if (generationEnabled()) {
    const local = config.LLM_PROVIDER === 'ollama';
    registry.register(createChatProvider({ id: 'primary', provider: config.LLM_PROVIDER, model: config.LLM_MODEL,
      family: config.MODEL_FAMILY || undefined, local, capabilities,
      baseUrl: local ? config.OLLAMA_BASE_URL : config.LLM_PROVIDER === 'anthropic' ? config.ANTHROPIC_BASE_URL : config.LLM_BASE_URL,
      apiKey: local ? '' : config.LLM_PROVIDER === 'anthropic' ? config.ANTHROPIC_API_KEY : config.LLM_API_KEY }));
  }
  if (config.LLM_PROVIDER !== 'ollama' && config.OLLAMA_MODEL) {
    registry.register(createChatProvider({ id: 'local', provider: 'ollama', model: config.OLLAMA_MODEL,
      family: config.OLLAMA_MODEL_FAMILY || undefined, local: true,
      capabilities: { ...capabilities, vision: false, coding: false }, baseUrl: config.OLLAMA_BASE_URL }));
  }
  return registry;
}
