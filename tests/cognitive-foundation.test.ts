import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelRegistry, type ModelProvider } from '../core/llmops/models.js';
import { createChatProvider } from '../core/llmops/registry.js';
import { interpret } from '../core/orchestrator/interpreter.js';
import { accumulateEvidence } from '../core/orchestrator/investigation.js';
import { describeDocument, enrichResource } from '../core/resources.js';
import { validateOperation } from '../core/agents/operations.js';

function model(id: string, local: boolean, invoke: ModelProvider['invoke'], family = id): ModelProvider {
  return { id, local, family, provider: local ? 'ollama' : 'openai', model: id,
    capabilities: { text: true, structuredOutput: true, vision: false, coding: false, toolUse: false, longContext: false, embeddings: false }, invoke };
}
const response = (text = '{}') => ({ text, inputTokens: 1, outputTokens: 2 });
const request = { messages: [{ role: 'user' as const, content: 'test' }] };

test('LOCAL blocks cloud even during failure and missing capability', async () => {
  let cloudCalls = 0;
  const registry = new ModelRegistry({ mode: 'LOCAL', allowRemote: true, allowFallback: true })
    .register(model('cloud', false, async () => { cloudCalls++; return response(); }))
    .register(model('local', true, async () => { throw new Error('offline'); }));
  await assert.rejects(registry.understand(request), /offline/);
  await assert.rejects(registry.vision(request), /Nenhum modelo/);
  assert.equal(cloudCalls, 0);
});

test('HYBRID prefers local and uses exactly one authorized fallback', async () => {
  const calls: string[] = [];
  const registry = new ModelRegistry({ mode: 'HYBRID', allowRemote: true, allowFallback: true })
    .register(model('cloud', false, async () => { calls.push('cloud'); return response(); }))
    .register(model('local', true, async () => { calls.push('local'); throw Error('offline'); }));
  assert.equal((await registry.understand(request)).modelId, 'cloud');
  assert.deepEqual(calls, ['local', 'cloud']);
});

test('ENSEMBLE never fans out; review requires different declared model family', async () => {
  const calls: string[] = [];
  const registry = new ModelRegistry({ mode: 'ENSEMBLE', allowRemote: true, allowFallback: false, crossFamilyReview: true });
  for (const [id, family] of [['a', 'qwen'], ['b', 'qwen'], ['c', 'claude']]) {
    registry.register(model(id, id === 'a', async () => { calls.push(id); return response(); }, family));
  }
  await registry.reason(request);
  assert.deepEqual(calls, ['a']);
  assert.equal((await registry.review(request, 'a')).modelId, 'c');
  await assert.rejects(registry.review(request, 'unknown'), /família/);
});

test('JSON protocol validation and capability routing fail closed', async () => {
  const registry = new ModelRegistry().register(model('local', true, async () => response('natural text')));
  assert.equal((await registry.respond(request)).text, 'natural text');
  await assert.rejects(registry.structured(request), SyntaxError);
  await assert.rejects(registry.code(request), /Nenhum modelo/);
  await assert.rejects(registry.review(request, 'local'), /não autorizada/);
});

test('text adapter omits JSON response_format; structured adapter requests it', async t => {
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
  });
  const registry = new ModelRegistry().register(createChatProvider({ ...model('local', true, async () => response()), baseUrl: 'http://127.0.0.1:11434/v1' }));
  await registry.respond(request);
  await registry.structured(request);
  assert.equal(bodies[0].response_format, undefined);
  assert.deepEqual(bodies[1].response_format, { type: 'json_object' });
});

const doc = describeDocument({ id: 'a', name: 'A.pdf', domain: 'test', hash: 'hash', status: 'ready', createdAt: '', owner: 'u', size: 1, chunks: 1, stages: [] });
const understanding = {
  interaction: 'knowledge', objective: 'Continuar análise', subjects: [{ id: 'a' }], referencedResources: [],
  constraints: [], needsKnowledge: true, needsTools: false, needsVision: false, needsCode: false,
  needsContext: true, uncertainty: [], suggestedOperations: [{ name: 'READ', objective: 'Ler original', resourceIds: ['a'], parameters: {} }]
};
test('Interpreter retains mixed greeting context and validates available resources', async () => {
  let sent = '';
  const registry = new ModelRegistry().register(model('local', true, async input => {
    sent = input.messages[1].content;
    return response(JSON.stringify(understanding));
  }));
  const input = { message: 'Bom dia. Continue aquela análise do documento.', history: [{ question: 'Analise A.pdf', answer: 'Resposta anterior' }], resources: [doc], domain: 'test' };
  assert.equal((await interpret(registry, input)).understanding.needsContext, true);
  assert.match(sent, /Analise A.pdf/);
  await assert.rejects(interpret(registry, { ...input, domain: 'other' }), /referência indisponível/);
});

test('resource inference cannot overwrite declared metadata or invent authority', () => {
  const updated = enrichResource(doc, { status: 'imagined', authority: 'official' });
  assert.equal(updated.metadata.status.value, 'ready');
  assert.equal(updated.authority, undefined);
  assert.equal(updated.metadata.authority.origin, 'inferred');
});

test('operation contracts do not grant execution or cross-scope access', () => {
  const operation = { name: 'EXECUTE', objective: 'action', resourceIds: ['a'] };
  assert.throws(() => validateOperation(operation, ['READ'], ['a']), /não autorizada/);
  assert.throws(() => validateOperation(operation, ['EXECUTE'], []), /não autorizado/);
  assert.throws(() => validateOperation({ ...operation, name: 'LEGAL_COMPARE' }, ['COMPARE'], ['a']));
});

test('investigation preserves more than ten originals including low-score observations', () => {
  const evidence = Array.from({ length: 25 }, (_, i) => ({ id: String(i), documentId: 'a', title: 'A', text: `Original ${i}`, chunk: i + 1, score: i / 100 }));
  const result = accumulateEvidence([], [evidence, [{ ...evidence[0], score: 1 }]]);
  assert.equal(result.length, 25);
  assert.equal(result[0].score, 1);
  assert.equal(result[24].text, 'Original 24');
});

test('cancellation prevents fallback and embedding spaces are never silently switched', async () => {
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  const registry = new ModelRegistry().register(model('local', true, async () => { calls++; return response(); }));
  await assert.rejects(registry.respond({ ...request, signal: abort.signal }));
  assert.equal(calls, 0);
  await assert.rejects(registry.embed(['text']), /Nenhum modelo/);
});

test('Graph opt-in calls Interpreter once and preserves social fast path', async t => {
  const { config } = await import('../gateway/config.js');
  const { orchestrate } = await import('../core/orchestrator/graph.js');
  const original = { COGNITIVE_INTERPRETER: config.COGNITIVE_INTERPRETER, LLM_PROVIDER: config.LLM_PROVIDER, LLM_MODEL: config.LLM_MODEL, EMBEDDING_MODEL: config.EMBEDDING_MODEL, MODEL_MODE: config.MODEL_MODE };
  t.after(() => Object.assign(config, original));
  Object.assign(config, { COGNITIVE_INTERPRETER: true, LLM_PROVIDER: 'ollama', LLM_MODEL: 'test', EMBEDDING_MODEL: '', MODEL_MODE: 'LOCAL' });
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.match(body.messages[0].content, /Interpreter/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...understanding, objective: 'Localizar prazo', subjects: [], needsContext: false, suggestedOperations: [] }) } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
  });
  const store = {
    cacheNamespace: crypto.randomUUID(), documents: async () => [], chunks: async () => [],
    revision: async () => 1, saveRun: async () => {}, audit: async () => {}
  } as unknown as import('../data/storage/database.js').Store;
  const principal = { id: 'u', roles: ['viewer'], domains: ['test'] };
  const greeting = await orchestrate(store, principal, 'Bom dia.', 'test', false);
  assert.equal(greeting.status, 'completed');
  assert.equal(fetch.mock.callCount(), 0);
  const run = await orchestrate(store, principal, 'Qual é o prazo?', 'test', false);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(run.status, 'abstained');
  assert.equal(run.inputTokens, 10);
  assert.ok(run.steps.some(step => step.name === 'Entender' && step.detail.includes('Interpreter')));
});
