import assert from 'node:assert/strict';
import test from 'node:test';
import type { Chunk, Run } from '../core/types.js';
import type { Store } from '../data/storage/database.js';
import { rankCandidates, diversify, retrieve } from '../core/rag/retrieval.js';
import { contextualizeQuestion } from '../core/orchestrator/context.js';
import { config } from '../gateway/config.js';
import { orchestrate } from '../core/orchestrator/graph.js';

const chunks: Chunk[] = [
  { id: 'ethics', documentId: 'ethics', domain: 'medicina', title: 'Ética médica', text: 'Ética, sigilo e deveres do médico. Registros em prontuário.', index: 0, vector: [1, 0], embeddingModel: 'test' },
  { id: 'records', documentId: 'records', domain: 'medicina', title: 'Prontuário', text: 'Prontuário eletrônico digital e ética na medicina.', index: 0, vector: [1, 0], embeddingModel: 'test' },
  { id: 'flu', documentId: 'cid', domain: 'medicina', title: 'CID-10-SUBCATEGORIAS.CSV', text: 'Influenza [gripe]. Classificação da gripe no capítulo respiratório.', index: 0 },
  { id: 'flu2', documentId: 'groups', domain: 'medicina', title: 'CID-10-GRUPOS.CSV', text: 'Grupo de influenza [gripe] e pneumonia.', index: 0 }
];
const history = [{ question: 'Pode falar sobre ética e prontuário?', answer: 'Ética e prontuário. '.repeat(100) }];
const fakeStore = () => ({ cacheNamespace: crypto.randomUUID(), revision: async () => 1, chunks: async (domain: string) => chunks.filter(chunk => chunk.domain === domain), saveRun: async (_run: Run) => {}, audit: async () => {} } as unknown as Store);

test('topic switch retrieves unembedded flu documents, not old fully embedded ethics', () => {
  const query = contextualizeQuestion('Você não consegue falar sobre a gripe?', history);
  const results = diversify(rankCandidates(query, chunks, [1, 0], 'test'));
  assert.deepEqual(new Set(results.map(item => item.chunk.documentId)), new Set(['cid', 'groups']));
});
test('explicit file topic is matched in document titles, not only repeated mentions in other books', () => {
  const results = rankCandidates('Você consegue me falar sobre o cid? 10.', chunks);
  assert.equal(results[0].chunk.documentId, 'cid');
  assert.ok(results.every(item => item.chunk.title.startsWith('CID-10')));
});
test('complete orchestration uses the new topic and respects the domain', async t => {
  const original = { LLM_MODEL: config.LLM_MODEL, EMBEDDING_MODEL: config.EMBEDDING_MODEL };
  t.after(() => Object.assign(config, original)); config.LLM_MODEL = ''; config.EMBEDDING_MODEL = '';
  const store = fakeStore();
  const run = await orchestrate(store, { id: 'tester', roles: ['viewer'], domains: ['medicina'] }, 'Conseguem me explicar de forma mais clara a questão da gripe?', 'medicina', false, history);
  assert.equal(run.status, 'completed'); assert.match(run.answer, /gripe/);
  assert.ok(run.sources.length > 0); assert.ok(run.sources.every(source => ['cid', 'groups'].includes(source.documentId)));
  assert.deepEqual(await retrieve(store, 'gripe', 'direito'), []);
});
test('embedding service failure does not disable lexical search', async t => {
  const original = { EMBEDDING_MODEL: config.EMBEDDING_MODEL, EMBEDDING_BASE_URL: config.EMBEDDING_BASE_URL };
  t.after(() => Object.assign(config, original)); Object.assign(config, { EMBEDDING_MODEL: 'test', EMBEDDING_BASE_URL: 'http://127.0.0.1:11434/v1' });
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  const results = await retrieve(fakeStore(), 'gripe', 'medicina');
  assert.equal(mock.mock.callCount(), 1); assert.equal(results[0].documentId, 'cid');
});
