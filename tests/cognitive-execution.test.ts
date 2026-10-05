import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCognitive, evidenceWindow } from '../core/orchestrator/cognitive.js';
import { createInvestigation } from '../core/orchestrator/investigation.js';
import { describeDocument } from '../core/resources.js';
import { ModelRegistry } from '../core/llmops/models.js';
import type { Store } from '../data/storage/database.js';

function fixture(replies: unknown[]) {
  const calls: any[] = [], reads: any[] = [];
  const state = createInvestigation(['a', 'b', 'unrelated'].map(id => describeDocument({ id, name: id, domain: 'test', hash: id, status: 'ready', chunks: 4, owner: 'u', createdAt: '', size: 1, stages: [] })));
  state.understanding = { interaction: 'knowledge', objective: 'Compare os textos', subjects: [{ id: 'a' }], referencedResources: [{ id: 'b' }], constraints: [], needsKnowledge: true, needsContext: false, needsTools: false, needsVision: false, needsCode: false, uncertainty: [], suggestedOperations: [{ name: 'READ', objective: 'Ler referência', resourceIds: ['b'], parameters: {} }] };
  const models = new ModelRegistry().register({ id: 'local', provider: 'ollama', model: 'test', local: true,
    capabilities: { text: true, structuredOutput: true, vision: false, coding: false, embeddings: false, toolUse: false, longContext: false },
    invoke: async request => { calls.push(request); const reply = replies.shift(); assert.notEqual(reply, undefined, 'unexpected model call'); return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), inputTokens: 10, outputTokens: 5 }; }
  });
  const store = { readChunks: async (domain: string, ids: string[], offset: number) => {
    reads.push({ domain, ids, offset });
    return ids.map(id => ({ id: id + offset, documentId: id, domain, title: id, index: offset, text: 'Original ' + id + offset }));
  } } as unknown as Store;
  const input = { store, models, domain: 'test', question: 'Compare', conversation: '', investigation: state, runId: 'r', signal: AbortSignal.timeout(10000), inputTokens: 1, outputTokens: 1, step: () => {} };
  return { input, calls, reads, state };
}
const answer = { answer: 'Os textos são semelhantes [1] [2].', citations: [1, 2], abstain: false, findings: [{ leftCitation: 1, rightCitation: 2, relation: 'semelhança', condition: 'nos trechos', conclusion: 'semelhantes' }] };
const pass = { verdict: 'pass', claims: [{ text: 'semelhantes', citations: [1, 2], verdict: 'pass', reason: 'sustentado' }], gaps: [] };

test('document analysis falls back on malformed structured output and still requires verified citations', async () => {
  const f = fixture([]);
  const replies = [{ operation: null }, answer, pass];
  let localCalls = 0;
  const models = new ModelRegistry({ mode: 'HYBRID', allowRemote: true, allowFallback: true });
  const capabilities = { text: true, structuredOutput: true, vision: false, coding: false, embeddings: false, toolUse: false, longContext: false };
  models.register({ id: 'local', model: 'test', provider: 'ollama', local: true, capabilities, invoke: async () => {
    localCalls++;
    return { text: '{"unexpected":"value"}', inputTokens: 1, outputTokens: 1 };
  } });
  models.register({ id: 'remote', model: 'test', provider: 'openai', local: false, capabilities, invoke: async () => {
    assert.ok(replies.length, 'unexpected extra model call');
    return { text: JSON.stringify(replies.shift()), inputTokens: 1, outputTokens: 1 };
  } });
  const result = await executeCognitive({ ...f.input, models });
  assert.equal(result.accepted, true);
  assert.equal(result.review?.verdict, 'pass');
  assert.equal(localCalls, 1);
  assert.equal(replies.length, 0);
  assert.equal(new Set(result.sources.map(s => s.documentId)).size, 2);
});

test('cognitive execution reads both selected sides and returns to collection on review gaps', async () => {
  const f = fixture([{ operation: null }, answer, { ...pass, verdict: 'uncertain', gaps: ['Ler próxima passagem da referência'] },
    { operation: { name: 'READ', objective: 'resolver lacuna', resourceIds: ['b'], parameters: { offset: 1 } } }, answer, pass]);
  const result = await executeCognitive(f.input);
  assert.equal(result.accepted, true);
  assert.deepEqual(f.reads, [{ domain: 'test', ids: ['a'], offset: 0 }, { domain: 'test', ids: ['b'], offset: 0 }, { domain: 'test', ids: ['b'], offset: 1 }]);
  assert.ok(f.calls[3].messages[1].content.includes('Ler próxima passagem'));
  assert.equal(f.state.evidence.length, 3);
  assert.equal(result.inputTokens, 61);
  assert.ok(result.sources.every(s => ['a', 'b'].includes(s.documentId)));
});

test('cognitive execution searches each explicitly requested clause instead of reading the document opening', async () => {
  const f = fixture([{ operation: null }, answer, pass]);
  f.input.question = 'Explique as cláusulas 23 e 31 e compare com a referência';
  const chunks = [
    { id: 'a-23', documentId: 'a', domain: 'test', title: 'a', index: 22, text: 'Cláusula 23. Regras específicas de jornada.' },
    { id: 'a-31', documentId: 'a', domain: 'test', title: 'a', index: 30, text: 'Cláusula 31. Regras específicas de contribuição.' },
    { id: 'a-other', documentId: 'a', domain: 'test', title: 'a', index: 0, text: 'Texto introdutório sem as cláusulas solicitadas.' }
  ];
  Object.assign(f.input.store, {
    cacheNamespace: crypto.randomUUID(),
    revision: async () => 1,
    chunks: async (_domain: string, ids?: string[]) => chunks.filter(chunk => !ids || ids.includes(chunk.documentId))
  });

  const result = await executeCognitive(f.input);

  assert.equal(result.accepted, true);
  assert.ok(result.sources.some(source => source.id === 'a-23'));
  assert.ok(result.sources.some(source => source.id === 'a-31'));
  assert.ok(!f.reads.some(read => read.ids.includes('a')), 'the subject should be searched by clause, not read from offset zero');
});

test('cognitive operations cannot expand the selected scope or execute tools', async () => {
  for (const operation of [{ name: 'READ', resourceIds: ['unrelated'] }, { name: 'EXECUTE', resourceIds: ['a'] }]) {
    const f = fixture([{ operation: { ...operation, objective: 'test', parameters: {} } }]);
    const result = await executeCognitive(f.input);
    assert.equal(result.accepted, false);
    assert.equal(f.reads.length, 2);
  }
});

test('cognitive conversation skips all document reads', async () => {
  const f = fixture(['Pode reformular sua pergunta?']);
  Object.assign(f.state.understanding!, { interaction: 'conversation', needsKnowledge: false });
  const result = await executeCognitive(f.input);
  assert.equal(result.accepted, true);
  assert.equal(result.abstain, false);
  assert.deepEqual(result.sources, []);
  assert.equal(f.reads.length, 0);
});

test('cognitive budget and cancellation prevent further calls', async () => {
  const f = fixture([]);
  f.state.budget.maxSteps = 0;
  assert.equal((await executeCognitive(f.input)).accepted, false);
  assert.equal(f.reads.length, 0);
  const g = fixture([]);
  g.input.signal = AbortSignal.abort();
  assert.equal((await executeCognitive(g.input)).accepted, false);
  assert.equal(g.calls.length, 0);
});

test('prompt evidence is bounded without discarding originals or low scores', () => {
  const originals = Array.from({ length: 30 }, (_, i) => ({ id: String(i), documentId: i % 2 ? 'a' : 'b', title: '', text: 'x'.repeat(5000), chunk: i, score: 0.01 }));
  const window = evidenceWindow(originals);
  assert.ok(window.length <= 10);
  assert.ok(window.reduce((n, e) => n + e.text.length, 0) <= 24000);
  assert.equal(new Set(window.map(s => s.documentId)).size, 2);
  assert.equal(originals.length, 30);
  assert.equal(originals[0].text.length, 5000);
});

test('pasted text is read as original evidence without a storage call', async () => {
  const f = fixture([{ operation: null }, answer, pass]);
  const result = await executeCognitive({ ...f.input, inlineEvidence: ['a', 'b'].map(id => ({ id, documentId: id, title: id, text: 'Texto fornecido ' + id, chunk: 1, score: 1 })) });
  assert.equal(result.accepted, true);
  assert.equal(f.reads.length, 0);
  assert.ok(result.sources.every(s => s.text.startsWith('Texto fornecido')));
});

test('original reads enforce domain, readiness, scope and numeric pagination', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('../data/storage/database.js');
  const directory = await mkdtemp(join(tmpdir(), 'lumina-read-'));
  const store = new Store('', directory);
  await store.init();
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  for (const [id, domain, status] of [['a', 'test', 'ready'], ['b', 'other', 'ready'], ['pending', 'test', 'processing']] as const) {
    await store.putDocument({ id, domain, status, name: id, hash: id, chunks: 3, owner: 'u', createdAt: '', size: 1, stages: [] });
    for (const index of [10, 2, 1]) await store.addChunk({ id: id + index, documentId: id, domain, title: id, text: 'original', index });
  }
  assert.deepEqual((await store.readChunks('test', ['a', 'b', 'pending'], 1, 2)).map(c => c.index), [2, 10]);
  assert.deepEqual(await store.readChunks('test', ['b']), []);
  assert.deepEqual(await store.readChunks('test', []), []);
  await assert.rejects(store.readChunks('test', ['a'], -1), /inválida/);
  await assert.rejects(store.readChunks('test', ['a'], 0, 25), /inválida/);
});
