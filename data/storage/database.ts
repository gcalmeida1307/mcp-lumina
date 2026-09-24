import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../../gateway/config.js';
import type { Chunk, DocumentRecord, Run } from '../../core/types.js';
import { repairMojibake } from '../processing/text.js';
type Row = Record<string, any>;
export class Store {
  readonly cacheNamespace = crypto.randomUUID();
  private scope = new AsyncLocalStorage<pg.PoolClient | true>();
  private tail = Promise.resolve();
  private sqlite?: DatabaseSync;
  private pool?: pg.Pool;
  get storageName() { return this.pool ? 'PostgreSQL' : 'SQLite local'; }
  constructor(url = config.DATABASE_URL, directory = config.DATA_DIR) {
    if (url) this.pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
    else {
      mkdirSync(directory, { recursive: true });
      this.sqlite = new DatabaseSync(join(directory, 'lumina.sqlite'));
      this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    }
  }
  async sql(query: string, params: any[] = []): Promise<Row[]> {
    if (!this.scope.getStore()) return this.exclusive(() => this.scope.run(true, () => this.sql(query, params)));
    if (this.pool) {
      let i = 0;
      const context = this.scope.getStore();
      const connection = context && context !== true ? context : this.pool;
      return (await connection.query(query.replace(/\?/g, () => '$' + ++i), params)).rows;
    }
    const statement = this.sqlite!.prepare(query);
    if (/^\s*(SELECT|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) return statement.all(...params) as Row[];
    statement.run(...params);
    return [];
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await fn(); } finally { release(); }
  }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()) return fn();
    return this.exclusive(async () => {
      const connection = this.pool ? await this.pool.connect() : undefined;
      return this.scope.run(connection ?? true, async () => {
        try {
          await this.sql('BEGIN');
          const result = await fn();
          await this.sql('COMMIT');
          return result;
        } catch (error) { await this.sql('ROLLBACK'); throw error; }
        finally { connection?.release(); }
      });
    });
  }
  async init() {
    for (const query of [
      'CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, domain TEXT NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(domain, hash))',
      'CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, domain TEXT NOT NULL, payload TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS chunks_domain ON chunks(domain)',
      'CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, domain TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS revisions (domain TEXT PRIMARY KEY, value INTEGER NOT NULL)'
    ]) await this.sql(query);
    for (const d of await this.documents()) {
      let changed = false;
      if (d.status === 'processing') { d.status = 'failed'; d.error = 'Processamento interrompido. Exclua e reenvie o arquivo.'; changed = true; }
      const name = repairMojibake(d.name);
      if (name !== d.name) { d.name = name; changed = true; }
      if (changed) await this.putDocument(d);
      const rows = await this.sql('SELECT payload FROM chunks WHERE document_id=?', [d.id]);
      for (const row of rows) {
        const chunk = JSON.parse(row.payload) as Chunk;
        const text = repairMojibake(chunk.text), title = repairMojibake(chunk.title);
        if (text !== chunk.text || title !== chunk.title) await this.sql('UPDATE chunks SET payload=? WHERE id=?', [JSON.stringify({ ...chunk, text, title }), chunk.id]);
      }
    }
  }
  async putDocument(d: DocumentRecord) {
    await this.sql('INSERT INTO documents (id, domain, hash, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', [d.id, d.domain, d.hash, JSON.stringify(d)]);
  }
  async documents(domain?: string): Promise<DocumentRecord[]> {
    const rows = domain ? await this.sql('SELECT payload FROM documents WHERE domain=?', [domain]) : await this.sql('SELECT payload FROM documents');
    return rows.map(r => JSON.parse(r.payload)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async document(id: string): Promise<DocumentRecord | undefined> {
    const rows = await this.sql('SELECT payload FROM documents WHERE id=?', [id]);
    return rows[0] ? JSON.parse(rows[0].payload) : undefined;
  }
  async addChunk(chunk: Chunk) { await this.sql('INSERT INTO chunks (id, document_id, domain, payload) VALUES (?, ?, ?, ?)', [chunk.id, chunk.documentId, chunk.domain, JSON.stringify(chunk)]); }
  async updateChunkVector(id: string, vector: number[], embeddingModel: string) {
    const rows = await this.sql('SELECT payload FROM chunks WHERE id=?', [id]);
    if (!rows[0]) return;
    const chunk = JSON.parse(rows[0].payload) as Chunk;
    chunk.vector = vector; chunk.embeddingModel = embeddingModel;
    await this.sql('UPDATE chunks SET payload=? WHERE id=?', [JSON.stringify(chunk), id]);
  }
  async chunks(domain: string): Promise<Chunk[]> {
    const rows = await this.sql('SELECT c.payload FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.domain=?', [domain]);
    const ready = new Set((await this.documents(domain)).filter(d => d.status === 'ready').map(d => d.id));
    return rows.map(r => JSON.parse(r.payload) as Chunk).filter(c => ready.has(c.documentId));
  }
  async deleteDocument(id: string, domain: string) { await this.sql('DELETE FROM documents WHERE id=? AND domain=?', [id, domain]); await this.bump(domain); }
  async bump(domain: string) { await this.sql('INSERT INTO revisions(domain,value) VALUES (?,1) ON CONFLICT(domain) DO UPDATE SET value=revisions.value+1', [domain]); }
  async revision(domain: string) { return (await this.sql('SELECT value FROM revisions WHERE domain=?', [domain]))[0]?.value ?? 0; }
  async saveRun(run: Run) { await this.sql('INSERT INTO runs(id,owner,domain,created_at,payload) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', [run.id, run.owner, run.domain, run.createdAt, JSON.stringify(run)]); }
  async runs(owner: string, domain?: string): Promise<Run[]> {
    const rows = await this.sql('SELECT payload FROM runs WHERE owner=?' + (domain ? ' AND domain=?' : '') + ' ORDER BY created_at DESC LIMIT 100', domain ? [owner, domain] : [owner]);
    return rows.map(r => JSON.parse(r.payload));
  }
  async conversationRuns(owner: string, domain: string, conversationId: string): Promise<Run[]> {
    return (await this.runs(owner, domain))
      .filter(run => run.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-6);
  }
  async run(id: string): Promise<Run | undefined> { const rows = await this.sql('SELECT payload FROM runs WHERE id=?', [id]); return rows[0] ? JSON.parse(rows[0].payload) : undefined; }
  async audit(actor: string, action: string, target: string) {
    await this.sql('INSERT INTO audit(id,actor,action,target,created_at) VALUES (?,?,?,?,?)', [crypto.randomUUID(), actor, action, target, new Date().toISOString()]);
  }
  async audits() { return this.sql('SELECT * FROM audit ORDER BY created_at DESC LIMIT 100'); }
  async close() { this.sqlite?.close(); await this.pool?.end(); }
}
