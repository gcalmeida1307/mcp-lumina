import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../gateway/config.js';
import { mentionedDocuments, contentQuery, planningExcerpts } from '../core/rag/document-scope.js';
import { retrieve } from '../core/rag/retrieval.js';
import { orchestrate } from '../core/orchestrator/graph.js';
import { answerSchema, formatCitedAnswer } from '../core/llmops/evidence.js';
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
  readChunks: async (domain: string, ids: string[], offset = 0, limit = 4) => chunks.filter(c => c.domain === domain && ids.includes(c.documentId)).sort((a,b) => a.index - b.index).slice(offset, offset + limit),
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

test('comparison uses cognitive scope and collects again after reviewer feedback', async t => {
  const original = { COGNITIVE_INTERPRETER: config.COGNITIVE_INTERPRETER, MODEL_MODE: config.MODEL_MODE, LLM_PROVIDER: config.LLM_PROVIDER, LLM_MODEL: config.LLM_MODEL, EMBEDDING_MODEL: config.EMBEDDING_MODEL };
  t.after(() => Object.assign(config, original));
  Object.assign(config, { COGNITIVE_INTERPRETER: true, MODEL_MODE: 'LOCAL', LLM_PROVIDER: 'ollama', LLM_MODEL: 'synthetic', EMBEDDING_MODEL: '' });
  let generation = 0, reviews = 0, decisions = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    const system: string = request.messages[0].content;
    const input = JSON.parse(request.messages[1].content);
    let data: unknown;
    if (system.includes('Interpreter')) {
      data = { interaction: 'knowledge', objective: 'Comparar registro de jornada', subjects: [{ id: 'a' }], referencedResources: [{ id: 'b' }], constraints: [], needsKnowledge: true, needsTools: false, needsVision: false, needsCode: false, needsContext: false, uncertainty: [], suggestedOperations: [{ name: 'READ', objective: 'Ler referência', resourceIds: ['b'], parameters: {} }] };
    } else if (system.startsWith('Selecione')) {
      decisions++;
      if (reviews === 1) assert.match(input.gaps.join(' '), /multa/);
      data = decisions === 2 ? { operation: { name: 'READ', objective: 'Verificar referência', resourceIds: ['b'], parameters: { offset: 1 } } } : { operation: null };
    } else if (system.includes('revisor de evidências')) {
      reviews++;
      data = { verdict: reviews === 1 ? 'fail' : 'pass', claims: [{ text: 'Comparação fictícia', citations: [1, 2], verdict: reviews === 1 ? 'fail' : 'pass', reason: reviews === 1 ? 'Remova a conclusão sem suporte sobre multa.' : 'Ambos sustentam o registro.' }], gaps: reviews === 1 ? ['Verificar suporte para multa'] : [] };
    } else {
      generation++;
      assert.ok(input.sources.every((s: any) => ['a', 'b'].includes(s.documentId)));
      if (generation === 2) assert.match(input.gaps.join(' '), /multa/);
      data = { answer: generation === 1 ? 'Existe multa. [1] [2]' : 'Ambos mencionam registro de jornada. [1] [2]', citations: [1, 2], abstain: false, findings: [{ leftCitation: 1, rightCitation: 2, relation: 'registro', condition: 'nos trechos', conclusion: 'Ambos mencionam registro.' }] };
    }
    return new Response(JSON.stringify({ message: { content: JSON.stringify(data) }, prompt_eval_count: 1, eval_count: 1 }));
  });
  const run = await orchestrate(fakeStore(), { id: 'test', domains: ['direito'], roles: ['viewer'] }, 'Quando comparo SAAE_2026_2027.pdf com VADE, quais problemas posso ter?', 'direito', false);
  assert.equal(generation, 2);
  assert.equal(reviews, 2);
  assert.equal(run.workflow, 'cognitive-investigation-v1');
  assert.equal(run.status, 'completed');
  assert.doesNotMatch(run.answer, /multa/);
  assert.deepEqual(new Set(run.sources.map(s => s.documentId)), new Set(['a', 'b']));
});

test('formatting preserves valid inline provenance and removes invented citations', () => {
  assert.equal(formatCitedAnswer('Primeiro [1]. Segundo [2]. Inválido [99].', [1,2]), 'Primeiro [1]. Segundo [2]. Inválido.');
});

test('citation metadata is recovered only from explicit inline references', () => {
  const parsed = answerSchema.parse({ answer: 'Afirmação [1, 2].', abstain: false });
  assert.equal(parsed.answer, 'Afirmação [1] [2].');
  assert.deepEqual(parsed.citations, [1, 2]);
  assert.deepEqual(answerSchema.parse({ answer: 'Sem referência.', abstain: false }).citations, []);
  assert.deepEqual(answerSchema.parse({ answer: 'Inválida [99].', abstain: false }).citations, [99]);
});

test('failed Interpreter preserves named scope and repairs the actual validation failure', async t => {
  const original = { ...config };
  t.after(() => Object.assign(config, original));
  Object.assign(config, { COGNITIVE_INTERPRETER: true, MODEL_MODE: 'LOCAL', LLM_PROVIDER: 'ollama', LLM_MODEL: 'synthetic', EMBEDDING_MODEL: '' });
  let generations = 0, reviews = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    const system: string = request.messages[0].content;
    const input = JSON.parse(request.messages[1].content);
    let data: unknown;
    if (system.includes('Interpreter')) data = { wrong: 'contract' };
    else if (system.includes('planejador')) {
      assert.equal(input.documentExcerpts.length, 2);
      data = { queries: ['SAAE jornada horas adicionais', 'VADE jornada horas adicionais'] };
    } else if (system.includes('revisor')) {
      reviews++;
      data = { verdict: 'pass', claims: [{ text: 'Registro de jornada', citations: [1, 2], verdict: 'pass', reason: 'Os trechos sustentam.' }] };
    } else {
      generations++;
      assert.equal(input.routing.task, 'compare');
      assert.ok(input.sources.every((source: any) => ['a', 'b'].includes(source.documentId)));
      assert.ok(input.sources.every((source: any) => !source.text.includes('Capa')));
      const left = input.sources.find((source: any) => source.documentId === 'a').citation;
      const right = input.sources.find((source: any) => source.documentId === 'b').citation;
      if (generations === 1) data = { answer: 'Registro de jornada.', abstain: 'false' };
      else {
        assert.match(input.retry.reason, /abstain/);
        data = { answer: `Ambos tratam do registro de jornada [${left}, ${right}].`, abstain: false,
          findings: [{ leftCitation: left, rightCitation: right, relation: 'compatibilidade', condition: 'nos trechos', conclusion: 'Registro em ambos.' }] };
      }
    }
    return new Response(JSON.stringify({ message: { content: JSON.stringify(data) }, prompt_eval_count: 1, eval_count: 1 }));
  });
  const run = await orchestrate(fakeStore(), { id: 'test', domains: ['direito'], roles: ['viewer'] },
    'Me fala sobre a cláusula 23 e 31 do SAAE_2026_2027 e veja as divergências que possam ter com o VADE.', 'direito', false);
  assert.equal(run.status, 'completed');
  assert.equal(generations, 2);
  assert.equal(reviews, 1);
  assert.ok(run.steps.some(step => /Formato da resposta inválido/.test(step.detail)));
});
