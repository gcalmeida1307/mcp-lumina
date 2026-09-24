import type { Express } from 'express';
import { z } from 'zod';
import type { Store } from '../data/storage/database.js';
import { canRead, requireDomain } from '../security/policies/access.js';
import { describeDocument, documentRelations } from '../core/knowledge/relations.js';
import { cached } from '../data/storage/cache.js';
import { tokenize } from '../data/processing/text.js';

const pagination = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0), limit: z.coerce.number().int().min(1).max(24).default(24), q: z.string().max(200).default('') });
const normalized = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
export function knowledgeRoutes(app: Express, store: Store) {
  app.get('/api/neural-map/documents', async (req, res) => {
    const domain = requireDomain(req, res); if (!domain) return;
    const { offset, limit, q } = pagination.parse(req.query);
    const ready = (await store.documents(domain)).filter(document => document.status === 'ready');
    const chunks = await store.chunks(domain);
    const terms = tokenize(q);
    const contentMatches = new Set(chunks.filter(chunk => { const text = normalized(chunk.title + ' ' + chunk.text); return terms.length > 0 && terms.every(term => text.includes(term)); }).map(chunk => chunk.documentId));
    const all = ready.filter(document => normalized(document.name).includes(normalized(q.trim())) || contentMatches.has(document.id));
    const page = all.slice(offset, offset + limit);
    const revision = await store.revision(domain);
    const relations = await cached(`lumina:relations:v2:${store.cacheNamespace}:${domain}:${revision}`, async () => documentRelations(ready, chunks));
    const visible = new Set(page.map(document => document.id));
    const relatedDocuments = relations.filter(edge => visible.has(edge.source) !== visible.has(edge.target)).map(edge => {
      const relatedTo = visible.has(edge.source) ? edge.source : edge.target;
      const target = relatedTo === edge.source ? edge.target : edge.source;
      const document = ready.find(item => item.id === target)!;
      return { ...describeDocument(document, chunks.filter(chunk => chunk.documentId === target)), relatedTo, score: edge.score, method: edge.method };
    });
    res.json({ documents: page.map(document => describeDocument(document, chunks.filter(chunk => chunk.documentId === document.id))), relations: relations.filter(edge => visible.has(edge.source) && visible.has(edge.target)), relatedDocuments, comparedDocuments: ready.length, total: all.length, offset, limit });
  });
  app.get('/api/neural-map/documents/:id/passages', async (req, res) => {
    const document = await store.document(String(req.params.id));
    if (!document || !canRead(req.principal, document.domain) || document.status !== 'ready') return void res.status(404).json({ error: 'Documento indisponível.' });
    const { offset, limit, q } = pagination.parse(req.query);
    const chunks = (await store.chunks(document.domain)).filter(chunk => chunk.documentId === document.id).sort((a, b) => a.index - b.index);
    const matching = chunks.filter(chunk => normalized(chunk.text).includes(normalized(q.trim())));
    const links = new Set(document.webLinks ?? []);
    const linkedDocuments = (await store.documents(document.domain)).filter(item => item.status === 'ready' && item.id !== document.id && item.sourceUrl && links.has(item.sourceUrl)).slice(0, 25).map(item => ({ id: item.id, name: item.name, domain: item.domain, createdAt: item.createdAt, chunks: item.chunks, embeddedChunks: 0, sourceUrl: item.sourceUrl, capturedAt: item.capturedAt }));
    res.json({ document: describeDocument(document, chunks), linkedDocuments, passages: matching.slice(offset, offset + limit).map(chunk => ({ id: chunk.id, index: chunk.index, text: chunk.text, embedded: Boolean(chunk.vector?.length) })), total: matching.length, offset, limit });
  });
}
