import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../gateway/config.js';
import { mentionedDocuments, contentQuery, planningExcerpts } from '../core/rag/document-scope.js';
import { retrieve } from '../core/rag/retrieval.js';
import { routeMessage } from '../core/orchestrator/taskRouter.js';
import { orchestrate } from '../core/orchestrator/graph.js';
import { formatCitedAnswer } from '../core/llmops/evidence.js';
import type { Chunk, DocumentRecord } from '../core/types.js';
import type { Store } from '../data/storage/database.js';

const docs: DocumentRecord[] = [
  { id: 'a', name: 'Saae_2026_2027.pdf', domain: 'direito', status: 'ready', chunks: 2, hash: 'a', owner: 'test', createdAt: '', size: 100, stages: [] },
  { id: 'b', name: 'Vade_mecum_Senado_Federal_3ed.pdf', domain: 'direito', status: 'ready', chunks: 2, hash: 'b', owner: 'test', createdAt: '', size: 100, stages: [] }
];
const chunks: Chunk[] = [
  { id: 'cover', documentId: 'b', title: docs[1].name, domain: 'direito', index: 0, text: 'Capa. Senado Federal. Vade Mecum.' },
  { id: 'rule', documentId: 'b', title: docs[1].name, domain: 'direito', index: 1, text: 'Regra fictícia: registrar a jornada e as horas adicionais.' },
  { id: 'clause', documentId: 'a', title: docs[0].name, domain: 'direito', index: 0, text: 'Cláusula fictícia: registrar a jornada e as horas adicionais.' },
  { id: 'unrelated', documentId: 'c', title: 'Matematica.pdf', domain: 'direito', index: 0, text: 'Problemas com horas adicionais e jornada.' },
  { id: 'other-domain', documentId: 'b', title: docs[1].name, domain: 'medicina', index: 2, text: 'jornada jornada horas horas' }
];
const fakeStore = () => ({ cacheNamespace: crypto.randomUUID(), revision: async () => 1,
  documents: async () => docs, chunks: async (domain: string) => chunks.filter(c => c.domain === domain),
  saveRun: async () => {}, audit: async () => {}
} as unknown as Store);

test('explicit filenames and unique abbreviations scope comparison without ambiguous aliases', () => {
  const question = 'Quando olho pro SAAE_2026_2027.pdf e comparo com o VADE, quais problemas posso ter?';
  assert.deepEqual(mentionedDocuments(question, docs).map(d => d.id), ['a', 'b']);
  assert.doesNotMatch(contentQuery(question, docs), /saae|2026|2027|vade|pdf/);
  assert.deepEqual(mentionedDocuments('VADE', [...docs, { ...docs[1], id: 'duplicate', name: 'Vade_alternativo.pdf' }]), []);
  assert.equal(planningExcerpts(docs, chunks)[0].passages[0].text, chunks[2].text);
});

test('scoped retrieval selects content rather than covers and isolates both documents and domains', async t => {
  const original = config.EMBEDDING_MODEL;
  t.after(() => { config.EMBEDDING_MODEL = original; });
  config.EMBEDDING_MODEL = '';
  const store = fakeStore();
  const result = await retrieve(store, 'jornada horas adicionais', 'direito', ['b']);
  assert.deepEqual(result.map(s => s.id), ['rule']);
  assert.equal(result[0].title, docs[1].name);
  const otherScope = await retrieve(store, 'jornada horas adicionais', 'direito', ['a']);
  assert.deepEqual(otherScope.map(s => s.id), ['clause']);
  assert.deepEqual(await retrieve(store, 'jornada horas adicionais', 'direito', []), []);
});

test('comparo uses comparison and repairs reviewer failures with specific feedback', async t => {
  const original = { LLM_PROVIDER: config.LLM_PROVIDER, LLM_MODEL: config.LLM_MODEL, LLM_API_KEY: config.LLM_API_KEY, EMBEDDING_MODEL: config.EMBEDDING_MODEL };
  t.after(() => Object.assign(config, original));
  Object.assign(config, { LLM_PROVIDER: 'openai', LLM_MODEL: 'synthetic', LLM_API_KEY: 'synthetic', EMBEDDING_MODEL: '' });
  let generation = 0, reviews = 0;
 t.mock.method(
  globalThis,
  'fetch',
  async (_url: string | URL | Request, init?: RequestInit) =>  {
    const request = JSON.parse(String(init?.body));
    const system: string = request.messages[0].content;
    const input = JSON.parse(request.messages[1].content);
    let data: unknown;
    if (system.startsWith('Decomponha')) {
      assert.equal(input.documentExcerpts.length, 2);
      assert.match(JSON.stringify(input.documentExcerpts), /Cláusula fictícia/);
      data = { queries: ['Saae_2026_2027.pdf jornada horas adicionais', 'Vade_mecum_Senado_Federal_3ed.pdf jornada horas adicionais'] };
    } else if (system.startsWith('Você é um revisor')) {
      reviews++;
      data = { verdict: reviews === 1 ? 'fail' : 'pass', claims: [{ text: 'Comparação fictícia', citations: [1, 2], verdict: reviews === 1 ? 'fail' : 'pass', reason: reviews === 1 ? 'Remova a conclusão sem suporte sobre multa.' : 'Ambos os trechos sustentam a comparação.' }] };
    } else {
      generation++;
      assert.ok(input.sources.every((s: any) => ['a','b'].includes(s.documentId)));
      if (generation === 2) {
        assert.match(input.retry.previousAnswer, /multa/);
        assert.match(input.retry.issues[0].reason, /Remova a conclusão/);
      }
      data = { answer: generation === 1 ? 'Existe multa. [1] [2]' : 'Ambos os trechos mencionam registro de jornada. [1] [2]', citations: [1, 2], abstain: false, findings: [{ leftCitation: 1, rightCitation: 2, relation: 'registro', condition: 'aplicação das regras fictícias', conclusion: 'Ambos mencionam registro.' }] };
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }], usage: {} }));
  });
  const question = 'Quando comparo o SAAE_2026_2027.pdf com o VADE, quais problemas posso ter?';
  assert.equal((await routeMessage(question)).task, 'compare');
  const run = await orchestrate(fakeStore(), { id: 'test', domains: ['direito'], roles: ['viewer'] }, question, 'direito', false);
  assert.equal(generation, 2);
  assert.equal(reviews, 2);
  assert.equal(run.status, 'completed');
  assert.doesNotMatch(run.answer, /multa/);
  assert.deepEqual(new Set(run.sources.map(s => s.documentId)), new Set(['a','b']));
});

test('formatting preserves valid inline provenance and removes invented citations', () => {
  assert.equal(formatCitedAnswer('Primeiro [1]. Segundo [2]. Inválido [99].', [1,2]), 'Primeiro [1]. Segundo [2]. Inválido.\n\nFontes: [1], [2]');
});
