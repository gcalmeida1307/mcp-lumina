import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../gateway/config.js';
import { orchestrate } from '../core/orchestrator/graph.js';
import type { Store } from '../data/storage/database.js';

const principal = { id: 'test', domains: ['test'], roles: ['viewer'] };
function setup(t: any, cognitive: boolean) {
  const original = { ...config };
  t.after(() => Object.assign(config, original));
  Object.assign(config, { COGNITIVE_INTERPRETER: cognitive, MODEL_MODE: 'LOCAL', LLM_PROVIDER: 'ollama', LLM_MODEL: 'synthetic', EMBEDDING_MODEL: '' });
  return {
    cacheNamespace: crypto.randomUUID(), revision: async () => 1,
    documents: async () => [], chunks: async () => [],
    saveRun: async () => {}, audit: async () => {}
  } as unknown as Store;
}
function reply(data: unknown) {
  return new Response(JSON.stringify({ message: { content: typeof data === 'string' ? data : JSON.stringify(data) }, prompt_eval_count: 1, eval_count: 1 }));
}

const question = 'A lógica Fuzzy e a Inteligência Artificial, o que podemos tirar de aproveito de uma e de outra?';
for (const scenario of ['failed Interpreter', 'conversation Interpreter', 'router declines retrieval'] as const) {
  test(`${scenario}: conceptual question retrieves actual passages before generation`, async t => {
    const store = setup(t, scenario !== 'router declines retrieval');
    const chunks = [
      { id: 'fuzzy-7', documentId: 'fuzzy', title: 'Fuzzy.pdf', domain: 'test', index: 6, page: 9, text: 'A lógica Fuzzy representa graus de pertinência com regras interpretáveis.' },
      { id: 'ia-12', documentId: 'ia', title: 'IA.pdf', domain: 'test', index: 11, page: 15, text: 'A Inteligência Artificial aprende padrões a partir de dados.' }
    ];
    t.mock.method(store, 'documents', async () => chunks.map(chunk => ({ id: chunk.documentId, name: chunk.title, domain: 'test', status: 'ready', chunks: 20, hash: chunk.id, owner: 'test', createdAt: '', size: 100, stages: [] })));
    let retrieved = false, generated = 0;
    t.mock.method(store, 'chunks', async (domain: string) => { assert.equal(domain, 'test'); retrieved = true; return chunks; });
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const system: string = body.messages[0].content;
      const input = JSON.parse(body.messages[1].content);
      if (system.includes('Interpreter')) return reply(scenario === 'failed Interpreter' ? { wrong: 'contract' } : {
        interaction: 'conversation', objective: question, subjects: [], referencedResources: [], constraints: [],
        needsKnowledge: false, needsTools: false, needsVision: false, needsCode: false, needsContext: false, uncertainty: [], suggestedOperations: []
      });
      if (system.includes('analisador de intenção')) return reply({ mode: 'question', intents: ['explain'], capabilities: { retrieval: false, planning: false, crossDocument: false, validation: false, preserveContext: false }, confidence: 'high', reason: 'conceitual' });
      assert.equal(retrieved, true, 'knowledge must be consulted before answering');
      if (system.includes('revisor')) return reply({ verdict: 'pass', claims: [{ text: 'Síntese das duas abordagens', citations: [1, 2], verdict: 'pass', reason: 'Sustentado pelos trechos.' }], gaps: [] });
      generated++;
      assert.equal(input.sources.length, 2);
      for (const chunk of chunks) assert.ok(input.sources.some((source: any) => source.documentId === chunk.documentId && source.text === chunk.text));
      return reply({ answer: 'Fuzzy oferece regras interpretáveis e IA aprende padrões [1] [2].', citations: [1, 2], abstain: false, findings: [] });
    });
    const run = await orchestrate(store, principal, question, 'test', false);
    assert.equal(run.status, 'completed');
    assert.notEqual(run.workflow, 'direct-answer-v1');
    assert.equal(generated, 1);
    assert.deepEqual(new Set(run.sources.map(source => source.id)), new Set(chunks.map(chunk => chunk.id)));
    assert.ok(run.sources.some(source => source.page === 15 && source.chunk === 12));
    assert.match(run.answer, /\[1\].*\[2\]/);
    assert.ok(run.steps.some(step => /retrieval=true/.test(step.detail)));
  });
}

test('empty retrieval declares the gap instead of silently generating general knowledge', async t => {
  const store = setup(t, true);
  const chunks = t.mock.method(store, 'chunks', async () => []);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    assert.match(JSON.parse(String(init?.body)).messages[0].content, /Interpreter/);
    return reply({ wrong: 'contract' });
  });
  const run = await orchestrate(store, principal, question, 'test', false);
  assert.equal(chunks.mock.callCount(), 1);
  assert.equal(run.status, 'abstained');
  assert.deepEqual(run.sources, []);
});

test('legacy documentary answer accepts ordinary inline citations on the first generation', async t => {
  const store = setup(t, false);
  t.mock.method(store, 'chunks', async () => [{ id: 'c', documentId: 'd', title: 'Guia.pdf', domain: 'test', index: 0, text: 'A aprendizagem coletiva exige experimentação.' }]);
  let generations = 0, reviews = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const system = body.messages[0].content;
    if (system.includes('analisador de intenção')) return reply({ mode: 'question', intents: ['lookup'], capabilities: { retrieval: true, planning: false, crossDocument: false, validation: true, preserveContext: false }, confidence: 'high', reason: 'documental' });
    if (system.includes('revisor independente')) {
      reviews++;
      return reply({ verdict: 'pass', claims: [{ text: 'Exige experimentação', citations: [1], verdict: 'pass', reason: 'Consta no trecho.' }] });
    }
    generations++;
    return reply({ answer: 'A aprendizagem coletiva exige experimentação [1].', citations: [1], abstain: false, findings: [] });
  });
  const run = await orchestrate(store, principal, 'O que o documento diz sobre aprendizagem coletiva?', 'test', false);
  assert.equal(run.status, 'completed');
  assert.match(run.answer, /\[1\]/);
  assert.equal(generations, 1);
  assert.equal(reviews, 1);
});

test('concept comparison can be grounded in one document without a false two-document requirement', async t => {
  const store = setup(t, true);
  t.mock.method(store, 'chunks', async () => [{ id: 'c', documentId: 'd', title: 'Sistemas.pdf', domain: 'test', index: 4, page: 6, text: 'Fuzzy usa regras interpretáveis. Inteligência Artificial aprende padrões de dados.' }]);
  let generations = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const system: string = body.messages[0].content;
    if (system.includes('Interpreter')) return reply({ wrong: 'contract' });
    if (system.includes('planejador')) return reply({ queries: ['Fuzzy Inteligência Artificial'] });
    if (system.includes('revisor')) return reply({ verdict: 'pass', claims: [{ text: 'Comparação', citations: [1], verdict: 'pass', reason: 'Ambos os conceitos constam no trecho.' }] });
    generations++;
    return reply({ answer: 'Fuzzy usa regras; IA aprende padrões [1].', citations: [1], abstain: false, findings: [] });
  });
  const run = await orchestrate(store, principal, 'Compare lógica Fuzzy e Inteligência Artificial.', 'test', false);
  assert.equal(run.status, 'completed');
  assert.equal(generations, 1);
  assert.equal(run.sources[0].page, 6);
});

test('invented inline citations remain rejected even when the declared array is valid', async t => {
  const store = setup(t, true);
  t.mock.method(store, 'chunks', async () => [{ id: 'c', documentId: 'd', title: 'Guia.pdf', domain: 'test', index: 0, text: 'A aprendizagem exige experimentação.' }]);
  let generations = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const system: string = body.messages[0].content;
    if (system.includes('Interpreter')) return reply({ wrong: 'contract' });
    if (system.includes('assistente de IA de uso geral')) return new Response(JSON.stringify({ message: { content: 'Complemento geral.' } }));
    assert.doesNotMatch(system, /revisor/);
    generations++;
    if (generations === 2) assert.match(JSON.parse(body.messages[1].content).retry.reason, /Citações/);
    return reply({ answer: 'Exige experimentação [1]. Outra afirmação [99].', citations: [1], abstain: false });
  });
  const run = await orchestrate(store, principal, 'O que o documento diz sobre aprendizagem?', 'test', false);
  assert.equal(generations, 2);
  assert.equal(run.status, 'abstained');
  assert.match(run.answer, /Motivo da validação: Citações/);
  assert.doesNotMatch(run.answer, /Outra afirmação/);
});
