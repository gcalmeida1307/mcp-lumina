import type { Store } from '../storage/database.js';
import type { Ingestion } from './pipeline.js';
import type { WebImportJob } from '../../core/web-import.js';
import { crawlWebsite } from './web-crawler.js';
import { pageUrl } from './web-fetch.js';

export class WebImports {
  private active = new Map<string, { owner: string; controller: AbortController; done: Promise<void> }>();
  private ready: Promise<void>;
  private stopping = false;
  constructor(private store: Store, private ingestion: Ingestion) { this.ready = this.init(); }
  private async init() {
    await this.store.sql('CREATE TABLE IF NOT EXISTS web_imports (id TEXT PRIMARY KEY, domain TEXT NOT NULL, owner TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)');
    const rows = await this.store.sql('SELECT payload FROM web_imports');
    for (const row of rows) {
      const job = JSON.parse(row.payload) as WebImportJob;
      if (job.status === 'queued' || job.status === 'running') { job.status = 'interrupted'; job.error = 'O servidor reiniciou. As páginas já salvas continuam disponíveis; importe a URL novamente para continuar.'; await this.persist(job); }
    }
  }
  private async persist(job: WebImportJob) {
    job.updatedAt = new Date().toISOString();
    await this.store.sql('INSERT INTO web_imports(id,domain,owner,created_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', [job.id, job.domain, job.owner, job.createdAt, JSON.stringify(job)]);
  }
  async list(domain: string, owner: string) {
    await this.ready;
    return (await this.store.sql('SELECT payload FROM web_imports WHERE domain=? AND owner=? ORDER BY created_at DESC LIMIT 20', [domain, owner])).map(row => JSON.parse(row.payload) as WebImportJob);
  }
  async start(url: string, domain: string, owner: string, maxPages: number) {
    await this.ready;
    if (this.stopping || this.active.size >= 2 || [...this.active.values()].some(item => item.owner === owner)) throw new Error('Já há uma importação em andamento. Aguarde ou cancele antes de iniciar outra.');
    const normalized = pageUrl(url).href;
    const job: WebImportJob = { id: crypto.randomUUID(), domain, owner, url: normalized, maxPages, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pages: [], visited: 0 };
    // Reserve before the first asynchronous write so concurrent requests cannot bypass the cap.
    const controller = new AbortController();
    const active = { owner, controller, done: Promise.resolve() };
    this.active.set(job.id, active);
    try { await this.persist(job); await this.store.audit(owner, 'web.import.start', job.id); }
    catch (error) { this.active.delete(job.id); throw error; }
    active.done = this.run(job, controller).finally(() => this.active.delete(job.id));
    return structuredClone(job);
  }
  async cancel(id: string, domain: string, owner: string) {
    const job = (await this.list(domain, owner)).find(item => item.id === id);
    if (!job) return false;
    this.active.get(id)?.controller.abort(); return true;
  }
  async retry(id: string, domain: string, owner: string) {
    const job = (await this.list(domain, owner)).find(item => item.id === id);
    if (!job || !['failed', 'cancelled', 'interrupted'].includes(job.status)) return undefined;
    return this.start(job.url, domain, owner, job.maxPages);
  }
  async remove(id: string, domain: string, owner: string) {
    const job = (await this.list(domain, owner)).find(item => item.id === id);
    if (!job || ['queued', 'running'].includes(job.status)) return false;
    await this.store.sql('DELETE FROM web_imports WHERE id=? AND domain=? AND owner=?', [id, domain, owner]);
    await this.store.audit(owner, 'web.import.remove', id);
    return true;
  }
  async close() { this.stopping = true; for (const item of this.active.values()) item.controller.abort(); await Promise.all([...this.active.values()].map(item => item.done)); }
  private async run(job: WebImportJob, controller: AbortController) {
    try {
      job.status = 'running'; await this.persist(job);
      await crawlWebsite({ url: job.url, maxPages: job.maxPages, signal: controller.signal,
        save: async page => {
          const capturedAt = new Date().toISOString();
          const name = `${page.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').slice(0, 145)}.md`;
          const result = await this.ingestion.enqueue(name, Buffer.from(`# ${page.title}\n\n${page.text}`, 'utf8'), job.domain, job.owner, { sourceUrl: page.url, capturedAt, webLinks: page.links });
          await this.ingestion.flushDocuments();
          const document = await this.store.document(result.document.id);
          if (!document || document.status !== 'ready') throw new Error(document?.error ?? 'A página não pôde ser indexada.');
          return { documentId: document.id, duplicate: result.duplicate };
        },
        progress: async (page, visited) => { job.pages.push(page); job.visited = visited; await this.persist(job); }
      });
      if (controller.signal.aborted) job.status = 'cancelled';
      else if (!job.pages.some(page => page.status === 'saved' || page.status === 'duplicate')) { job.status = 'failed'; job.error = 'Nenhuma página pôde ser salva. Confira os detalhes abaixo.'; }
      else job.status = 'completed';
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = controller.signal.aborted ? 'Importação cancelada. As páginas já salvas foram preservadas.' : error instanceof Error ? error.message : 'Falha ao importar o site.';
    }
    try { await this.persist(job); await this.store.audit(job.owner, 'web.import.' + job.status, job.id); }
    catch (error) { console.error(JSON.stringify({ event: 'web.import.persistence.failed', id: job.id, type: error instanceof Error ? error.name : 'Error' })); }
  }
}
