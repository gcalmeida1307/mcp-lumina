import { setImmediate as yieldTurn } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { Store } from '../../data/storage/database.js';
import type { KnowledgeJob, StoredRelation } from '../../data/storage/knowledge.js';
import { tokenize } from '../../data/processing/text.js';
import { config, embeddingsEnabled } from '../../gateway/config.js';
import { embed } from '../llmops/provider.js';
import { documentRelations } from './relations.js';
import { validateSharedStatement, validatorVersion } from './validation.js';
import { BackgroundBudget } from './background.js';
import { knowledgeJobs, knowledgeDuration } from '../../observability/telemetry.js';

export class KnowledgeWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = false;
  private ticking = false;
  private lagMs = 0;
  private shutdown = new AbortController();
  constructor(private store: Store, readonly budget = new BackgroundBudget()) {}
  async seed(domain?: string, force = false) {
    const documents = (await this.store.documents(domain)).filter(document => document.status === 'ready');
    for (const document of documents) {
      await this.store.knowledge.enqueue(document, 'correlation', force);
      if (embeddingsEnabled()) await this.store.knowledge.enqueue(document, 'embedding', force);
      await yieldTurn();
    }
    return documents.length;
  }
  start() {
    if (this.timer || this.running || this.stopped) return;
    const due = performance.now() + config.KNOWLEDGE_POLL_MS;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.lagMs = performance.now() - due;
      this.running = this.tick().catch(error => {
        console.error(JSON.stringify({ event: 'knowledge.tick.failed', type: error instanceof Error ? error.name : 'Error' }));
      }).finally(() => { this.running = undefined; this.start(); });
    }, config.KNOWLEDGE_POLL_MS);
    this.timer.unref();
  }
  async close() { this.stopped = true; this.shutdown.abort(); clearTimeout(this.timer); await this.running; }
  async tick() {
    if (this.ticking || this.stopped || !config.KNOWLEDGE_ENABLED || this.budget.paused || this.lagMs > config.KNOWLEDGE_MAX_LAG_MS) return;
    this.ticking = true;
    try { await this.processNext(); } finally { this.ticking = false; }
  }
  private async processNext() {
    const job = await this.store.knowledge.claim(embeddingsEnabled());
    if (!job) return;
    const stop = knowledgeDuration.startTimer({ kind: job.kind });
    try {
      if (this.budget.paused) { await this.store.knowledge.finish(job, 'pending'); return; }
      if (job.kind === 'embedding') await this.embedding(job);
      else await this.correlate(job);
      knowledgeJobs.inc({ kind: job.kind, outcome: 'processed' });
    } catch (error) {
      if (this.budget.paused || this.stopped) await this.store.knowledge.finish(job, 'pending');
      else {
        const failed = job.attempts + 1 >= config.KNOWLEDGE_MAX_ATTEMPTS;
        await this.store.knowledge.finish(job, failed ? 'failed' : 'retry', job.cursor, error instanceof Error ? error.name : 'Error', Math.min(60000, 2000 * 2 ** job.attempts));
        knowledgeJobs.inc({ kind: job.kind, outcome: failed ? 'failed' : 'retry' });
      }
    } finally { stop(); }
  }
  private async embedding(job: KnowledgeJob) {
    const chunks = await this.store.knowledge.chunks(job.document_id, job.cursor, config.KNOWLEDGE_EMBEDDING_BATCH);
    const missing = chunks.filter(chunk => !chunk.vector?.length || chunk.embeddingModel !== config.EMBEDDING_MODEL);
    const vectors = missing.length ? await embed(missing.map(chunk => chunk.text), { attempts: 1, timeoutMs: config.KNOWLEDGE_EMBEDDING_TIMEOUT_MS, signal: AbortSignal.any([this.budget.signal, this.shutdown.signal]) }) : [];
    if (this.budget.paused) { await this.store.knowledge.finish(job, 'pending'); return; }
    await this.store.transaction(async () => {
      if (!await this.store.knowledge.owns(job)) return;
      for (let i = 0; i < missing.length; i++) await this.store.updateChunkVector(missing[i].id, vectors[i], config.EMBEDDING_MODEL);
      const done = chunks.length < config.KNOWLEDGE_EMBEDDING_BATCH;
      await this.store.knowledge.finish(job, done ? 'completed' : 'pending', chunks.at(-1)?.id ?? job.cursor, '', config.KNOWLEDGE_POLL_MS);
      if (missing.length) await this.store.bump(job.domain);
      if (done) {
        const document = await this.store.document(job.document_id);
        if (document) await this.store.knowledge.enqueue(document, 'correlation', true);
      }
    });
  }
  private async correlate(job: KnowledgeJob) {
    const document = await this.store.document(job.document_id);
    if (!document || document.status !== 'ready') { await this.store.knowledge.finish(job, 'completed'); return; }
    const chunks = await this.store.knowledge.sample(document);
    const frequencies = new Map<string, number>();
    for (const word of tokenize(document.name + ' ' + chunks.map(chunk => chunk.text.slice(0, 2500)).join(' '))) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    const terms = [...frequencies].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 60).map(([term]) => term);
    const candidates = await this.store.knowledge.candidates(document, terms, config.KNOWLEDGE_TOP_K);
    const relations: StoredRelation[] = [];
    for (const candidate of candidates) {
      await yieldTurn();
      if (this.budget.paused || this.stopped) { await this.store.knowledge.finish(job, 'pending'); return; }
      const target = await this.store.document(candidate.document_id);
      if (!target || target.status !== 'ready' || target.domain !== document.domain) continue;
      const targetChunks = await this.store.knowledge.sample(target);
      const relation = documentRelations([document, target], [...chunks, ...targetChunks])[0];
      if (!relation) continue;
      const evidence = validateSharedStatement(chunks, targetChunks);
      relations.push({ ...relation, validation: evidence ? 'validated' : 'candidate', evidence, version: validatorVersion, createdAt: new Date().toISOString(), sourceHash: document.hash, targetHash: target.hash });
    }
    await this.store.transaction(async () => {
      if (!await this.store.knowledge.owns(job)) return;
      await this.store.sql('DELETE FROM knowledge_relations WHERE source=? OR target=?', [document.id, document.id]);
      for (const relation of relations) {
        const target = await this.store.document(relation.target);
        if (target?.status === 'ready' && target.hash === relation.targetHash) await this.store.knowledge.saveRelation(relation, document.domain);
      }
      await this.store.knowledge.finish(job, 'completed');
      await this.store.bump(document.domain);
      await this.store.audit('knowledge-worker', 'knowledge.correlated', document.id);
    });
  }
}
