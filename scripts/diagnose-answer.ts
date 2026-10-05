import { Store } from '../data/storage/database.js';
import { orchestrate } from '../core/orchestrator/graph.js';

// Read the configured corpus without saving diagnostic conversations or memories.
const store = new Store();
store.saveRun = async () => {};
store.saveEvaluation = async () => {};
store.saveReview = async () => {};
store.saveMemory = async () => {};
store.audit = async () => {};
try {
  const run = await orchestrate(store, { id: 'diagnostic', domains: ['direito'], roles: ['viewer'] },
    'Me fala sobre a cláusula 23 e 31 do SAAE_2026_2027 e veja as divergências que possam ter com o VADE.',
    'direito', false, [], undefined, step => console.log(JSON.stringify(step)));
  console.log(JSON.stringify({ status: run.status, answer: run.answer,
    sources: run.sources.map(source => ({ title: source.title, chunk: source.chunk, page: source.page,
      clause23: /Cláusula 23/.test(source.text), clause31: /Cláusula 31/.test(source.text) })) }));
} finally { await store.close(); }
