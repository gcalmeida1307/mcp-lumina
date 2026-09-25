// Synthetic, offline benchmark. Never reads or modifies the application's data.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../data/storage/database.js';
import { KnowledgeWorker } from '../core/knowledge/worker.js';
import { config } from '../gateway/config.js';
import { retrieve } from '../core/rag/retrieval.js';

config.EMBEDDING_MODEL = ''; config.KNOWLEDGE_ENABLED = true;
const directory = await mkdtemp(join(tmpdir(), 'lumina-benchmark-'));
const store = new Store('', directory);
const worker = new KnowledgeWorker(store);
try {
  await store.init();
  for (let i = 0; i < 40; i++) {
    const document = { id: `doc-${i}`, name: `Documento ${i}`, domain: 'medicina', hash: `hash-${i}`, owner: 'benchmark', createdAt: new Date().toISOString(), size: 1000, chunks: 25, stages: [], status: 'processing' as const };
    await store.putDocument(document);
    await store.transaction(async () => {
      for (let j = 0; j < 25; j++) await store.addChunk({ id: `${document.id}:${j}`, documentId: document.id, domain: document.domain, title: document.name, index: j, text: 'A classificação respiratória organiza grupos de influenza e pneumonia para consulta documental e acompanhamento institucional. '.repeat(4) });
    });
    await store.putDocument({ ...document, status: 'ready' });
  }
  for (let i = 0; i < 40; i++) await worker.tick();
  const samples: Record<string, number[]> = { base: [], knowledge: [] };
  const release = worker.budget.enterChat();
  for (let i = 0; i < 70; i++) {
    for (const enabled of i % 2 ? [true, false] : [false, true]) {
      config.KNOWLEDGE_ENABLED = enabled;
      const start = performance.now();
      const results = await retrieve(store, `influenza pneumonia consulta ${i}`, 'medicina');
      if (results.length !== 10) throw new Error('Unexpected retrieval result count');
      if (i >= 10) samples[enabled ? 'knowledge' : 'base'].push(performance.now() - start);
    }
  }
  release();
  const stats = (values: number[]) => {
    values.sort((a, b) => a - b);
    return { medianMs: +values[Math.floor(values.length / 2)].toFixed(2), p95Ms: +values[Math.floor(values.length * .95)].toFixed(2) };
  };
  console.log(JSON.stringify({ documents: 40, chunks: 1000, samplesPerMode: 60, base: stats(samples.base), knowledge: stats(samples.knowledge), scope: 'SQLite, uncached retrieval, no external model; not an end-to-end chat SLA' }, null, 2));
} finally {
  await worker.close(); await store.close();
  await rm(directory, { recursive: true, force: true });
}
