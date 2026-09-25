import { randomUUID } from 'node:crypto';
import type { Store } from './database.js';
import type { Chunk, DocumentRecord } from '../../core/types.js';
import type { MapRelation } from '../../core/knowledge/types.js';
import type { RelationEvidence } from '../../core/knowledge/validation.js';
import { validatorVersion } from '../../core/knowledge/validation.js';
import { config } from '../../gateway/config.js';

export type KnowledgeJob = { id: string; document_id: string; domain: string; kind: 'embedding' | 'correlation'; version: string; cursor: string; attempts: number; lease: string };
export type StoredRelation = MapRelation & { validation: 'candidate' | 'validated'; evidence?: RelationEvidence; version: string; createdAt: string; sourceHash: string; targetHash: string };
export class KnowledgeRepository {
  constructor(private store: Store) {}
  async init() {
    for (const query of [
      'CREATE INDEX IF NOT EXISTS chunks_document_id ON chunks(document_id,id)',
      `CREATE TABLE IF NOT EXISTS knowledge_jobs (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, domain TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, cursor TEXT NOT NULL, attempts INTEGER NOT NULL, available_at BIGINT NOT NULL, lease TEXT NOT NULL, lease_until BIGINT NOT NULL, error TEXT NOT NULL)`,
      'CREATE INDEX IF NOT EXISTS knowledge_jobs_due ON knowledge_jobs(status,available_at)',
      'CREATE TABLE IF NOT EXISTS knowledge_terms (document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, domain TEXT NOT NULL, term TEXT NOT NULL, PRIMARY KEY(document_id,term))',
      'CREATE INDEX IF NOT EXISTS knowledge_terms_lookup ON knowledge_terms(domain,term,document_id)',
      'CREATE TABLE IF NOT EXISTS knowledge_relations (id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, target TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, domain TEXT NOT NULL, validation TEXT NOT NULL, payload TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS knowledge_relations_source ON knowledge_relations(domain,source,validation)',
      'CREATE INDEX IF NOT EXISTS knowledge_relations_target ON knowledge_relations(target)',
      'CREATE TABLE IF NOT EXISTS knowledge_history (id TEXT PRIMARY KEY, domain TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)'
    ]) await this.store.sql(query);
  }
  async enqueue(document: DocumentRecord, kind: KnowledgeJob['kind'], force = false) {
    if (document.status !== 'ready') return;
    const version = JSON.stringify([document.hash, document.chunks, document.name, document.sourceUrl, config.EMBEDDING_MODEL, validatorVersion]);
    await this.store.sql(`INSERT INTO knowledge_jobs (id,document_id,domain,kind,version,status,cursor,attempts,available_at,lease,lease_until,error)
      VALUES (?,?,?,?,?,'pending','',0,0,'',0,'') ON CONFLICT(id) DO UPDATE SET version=excluded.version,status='pending',cursor='',attempts=0,available_at=0,lease='',lease_until=0,error=''
      WHERE knowledge_jobs.version<>excluded.version${force ? " OR knowledge_jobs.status<>'running'" : ''}`,
    [document.id + ':' + kind, document.id, document.domain, kind, version]);
  }
  async claim(embeddingEnabled: boolean): Promise<KnowledgeJob | undefined> {
    const now = Date.now(), lease = randomUUID();
    // Atomic compare-and-swap works across PostgreSQL processes and SQLite connections.
    const rows = await this.store.sql(`UPDATE knowledge_jobs SET status='running',lease=?,lease_until=? WHERE id=(
      SELECT id FROM knowledge_jobs WHERE ((status IN ('pending','retry') AND available_at<=?) OR (status='running' AND lease_until<?))
      ${embeddingEnabled ? '' : "AND kind='correlation'"} ORDER BY available_at,id LIMIT 1)
      AND ((status IN ('pending','retry') AND available_at<=?) OR (status='running' AND lease_until<?)) RETURNING *`,
    [lease, now + config.KNOWLEDGE_EMBEDDING_TIMEOUT_MS + 30000, now, now, now, now]);
    return rows[0] as KnowledgeJob | undefined;
  }
  async finish(job: KnowledgeJob, status: 'completed' | 'pending' | 'retry' | 'failed', cursor = job.cursor, error = '', delay = 0) {
    return this.store.sql(`UPDATE knowledge_jobs SET status=?,cursor=?,error=?,available_at=?,lease='',lease_until=0,attempts=attempts+?
      WHERE id=? AND lease=? AND version=? RETURNING id`, [status, cursor, error, Date.now() + delay, error ? 1 : 0, job.id, job.lease, job.version]);
  }
  async owns(job: KnowledgeJob) {
    return (await this.store.sql('SELECT id FROM knowledge_jobs WHERE id=? AND lease=? AND version=? AND lease_until>?', [job.id, job.lease, job.version, Date.now()])).length > 0;
  }
  async chunks(documentId: string, after = '', limit = 32): Promise<Chunk[]> {
    return (await this.store.sql('SELECT payload FROM chunks WHERE document_id=? AND id>? ORDER BY id LIMIT ?', [documentId, after, limit])).map(row => JSON.parse(row.payload));
  }
  async sample(document: DocumentRecord): Promise<Chunk[]> {
    if (document.chunks <= 32) return this.chunks(document.id);
    const ids = Array.from({ length: 32 }, (_, i) => document.id + ':' + Math.floor(i * (document.chunks - 1) / 31));
    const rows = await this.store.sql(`SELECT payload FROM chunks WHERE document_id=? AND id IN (${ids.map(() => '?').join(',')})`, [document.id, ...ids]);
    return rows.map(row => JSON.parse(row.payload));
  }
  async candidates(document: DocumentRecord, terms: string[], limit: number) {
    await this.store.transaction(async () => {
      await this.store.sql('DELETE FROM knowledge_terms WHERE document_id=?', [document.id]);
      if (terms.length) await this.store.sql(`INSERT INTO knowledge_terms(document_id,domain,term) VALUES ${terms.map(() => '(?,?,?)').join(',')}`, terms.flatMap(term => [document.id, document.domain, term]));
    });
    if (!terms.length) return [];
    return this.store.sql(`SELECT document_id,COUNT(*) AS overlap FROM knowledge_terms WHERE domain=? AND document_id<>? AND term IN (${terms.map(() => '?').join(',')}) GROUP BY document_id ORDER BY COUNT(*) DESC,document_id LIMIT ?`, [document.domain, document.id, ...terms, limit]);
  }
  async saveRelation(relation: StoredRelation, domain: string) {
    const id = [relation.source, relation.target].sort().join('|');
    const payload = JSON.stringify(relation);
    await this.store.sql('INSERT INTO knowledge_relations(id,source,target,domain,validation,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET validation=excluded.validation,payload=excluded.payload,source=excluded.source,target=excluded.target', [id, relation.source, relation.target, domain, relation.validation, payload]);
    await this.store.sql('INSERT INTO knowledge_history(id,domain,source,target,created_at,payload) VALUES(?,?,?,?,?,?)', [randomUUID(), domain, relation.source, relation.target, relation.createdAt, payload]);
  }
  async relations(domain: string, ids: string[], validatedOnly = false): Promise<StoredRelation[]> {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = await this.store.sql(`SELECT r.payload FROM knowledge_relations r JOIN documents a ON a.id=r.source JOIN documents b ON b.id=r.target
      WHERE r.domain=? AND a.domain=r.domain AND b.domain=r.domain AND (r.source IN (${placeholders}) OR r.target IN (${placeholders})) ${validatedOnly ? "AND r.validation='validated'" : ''}
      AND a.hash=${this.hashExpression('r.payload', 'sourceHash')} AND b.hash=${this.hashExpression('r.payload', 'targetHash')}
      LIMIT 200`, [domain, ...ids, ...ids]);
    return rows.map(row => JSON.parse(row.payload));
  }
  private hashExpression(column: string, field: string) {
    return this.store.storageName === 'PostgreSQL' ? `(${column}::jsonb->>'${field}')` : `json_extract(${column}, '$.${field}')`;
  }
  async status(domain: string) {
    const jobs = await this.store.sql('SELECT status,COUNT(*) AS count FROM knowledge_jobs WHERE domain=? GROUP BY status', [domain]);
    const relations = await this.store.sql('SELECT validation,COUNT(*) AS count FROM knowledge_relations WHERE domain=? GROUP BY validation', [domain]);
    return { jobs: Object.fromEntries(jobs.map(row => [row.status, Number(row.count)])), relations: Object.fromEntries(relations.map(row => [row.validation, Number(row.count)])) };
  }
}
