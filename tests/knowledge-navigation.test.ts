import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { knowledgeRoutes } from '../gateway/knowledge-routes.js';
import type { Store } from '../data/storage/database.js';
import type { Chunk, DocumentRecord } from '../core/types.js';
import type { DomainGraph } from '../core/knowledge/types.js';

test('knowledge relations cross page boundaries and search includes document content', async t => {
  const documents = ['first', 'second'].map(id => ({ id, name: id + '.csv', domain: 'medicina', status: 'ready', createdAt: '2026-09-24', chunks: 1 } as DocumentRecord));
  const chunks = documents.map(doc => ({ id: doc.id + ':0', documentId: doc.id, domain: 'medicina', title: doc.name, index: 0, text: 'Influenza gripe classificação respiratória categorias grupos.' } as Chunk));
  const store = { cacheNamespace: crypto.randomUUID(), documents: async () => documents, chunks: async () => chunks, revision: async () => 1, knowledge: { relations: async () => [{ source: 'first', target: 'second', score: 1, method: 'lexical', validation: 'candidate' }] } } as unknown as Store;
  const app = express(); app.use((req, _res, next) => { req.principal = { id: 'test', roles: ['viewer'], domains: ['medicina'] }; next(); }); knowledgeRoutes(app, store);
  const server = app.listen(0, '127.0.0.1'); t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const result = await fetch(base + '/api/neural-map/documents?domain=medicina&limit=1&q=gripe').then(response => response.json()) as DomainGraph;
  assert.equal(result.total, 2); assert.equal(result.comparedDocuments, 2); assert.equal(result.documents.length, 1);
  assert.equal(result.relatedDocuments?.[0].id, 'second'); assert.equal(result.relatedDocuments?.[0].relatedTo, 'first');
  const denied = await fetch(base + '/api/neural-map/documents?domain=direito'); assert.equal(denied.status, 403);
});
