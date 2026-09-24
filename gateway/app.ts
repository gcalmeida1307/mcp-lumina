import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config, generationEnabled, embeddingsEnabled } from './config.js';
import { authenticate, admin, globalAdmin, canRead, canWrite, requireDomain } from '../security/policies/access.js';
import { domains } from '../services/domains.js';
import { integrationCatalog } from '../integrations/catalog.js';
import { Store } from '../data/storage/database.js';
import { Ingestion } from '../data/ingestion/pipeline.js';
import { documentUpload } from './document-upload.js';
import { orchestrate } from '../core/orchestrator/graph.js';
import { listServers, listTools, callTool, serverAllows } from '../core/mcp/registry.js';
import { registry, requests, latency, traced } from '../observability/telemetry.js';
import { nativeAuth, csrf, AuthError } from '../security/auth/routes.js';
import { knowledgeRoutes } from './knowledge-routes.js';
import { WebImports } from '../data/ingestion/web-imports.js';
import { webRoutes } from './web-routes.js';
const querySchema = z.object({
  question: z.string().trim().min(2).max(4000),
  domain: z.string(),
  agent: z.boolean().default(false),
  conversationId: z.string().uuid().optional(),
  history: z.array(z.object({
    question: z.string().trim().min(1).max(4000),
    answer: z.string().trim().min(1).max(12000)
  })).max(6).default([])
});
export function createApp(store: Store) {
  const app = express(), ingestion = new Ingestion(store);
  const webImports = new WebImports(store, ingestion);
  const native = nativeAuth(store);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { 'connect-src': ["'self'", ...(config.OIDC_ISSUER ? [new URL(config.OIDC_ISSUER).origin] : [])], 'style-src': ["'self'", "'unsafe-inline'"], 'upgrade-insecure-requests': config.NODE_ENV === 'production' ? [] : null } } }));
  app.use(cors({ origin: config.APP_ORIGIN, credentials: false }));
  app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => {
    req.requestId = randomUUID(); res.setHeader('X-Request-Id', req.requestId);
    res.on('finish', () => { requests.inc({ method: req.method, route: req.route?.path ?? 'unmatched', status: String(res.statusCode) }); });
    next();
  });
  app.get('/api/health', async (_req, res) => { await store.sql('SELECT 1'); res.json({ status: 'ok', service: 'lumina' }); });
  app.get('/api/auth/config', (_req, res) => res.json({ mode: config.AUTH_MODE, authority: config.OIDC_ISSUER, clientId: config.OIDC_CLIENT_ID }));
  app.use('/api', csrf);
  if (config.AUTH_MODE === 'native') app.use('/api/auth', native.publicRoutes);
  app.use('/api', config.AUTH_MODE === 'native' ? native.authenticate : authenticate, rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Limite de requisições atingido. Tente novamente em um minuto.' } }));
  if (config.AUTH_MODE === 'native') app.use('/api/auth', native.privateRoutes);
  app.get('/api/me', (req, res) => res.json({ ...req.principal, authMode: config.AUTH_MODE, user: req.authUser }));
  app.get('/api/domains', (req, res) => res.json(domains.filter(d => canRead(req.principal, d.id))));
  app.get('/api/status', async (req, res) => {
    const docs = (await store.documents()).filter(d => canRead(req.principal, d.domain));
    res.json({
      name: 'LUMINA', version: '0.1.0', authMode: config.AUTH_MODE,
      generation: generationEnabled(), embeddings: embeddingsEnabled(),
      model: generationEnabled() ? config.LLM_MODEL : null,
      provider: config.LLM_PROVIDER,
      storage: store.storageName,
      documents: docs.filter(d => d.status === 'ready').length,
      processing: docs.filter(d => d.status === 'processing').length,
      chunks: docs.filter(d => d.status === 'ready').reduce((sum, d) => sum + d.chunks, 0),
      mcpServers: listServers().filter(s => s.domains.some(d => canRead(req.principal, d))).length
    });
  });
  app.get('/api/neural-map', async (req, res) => {
    const readable = domains.filter(d => canRead(req.principal, d.id));
    let dimensions: number | null = null;
    const domainStats = [];
    for (const item of readable) {
      const docs = (await store.documents(item.id)).filter(d => d.status === 'ready');
      const chunks = await store.chunks(item.id);
      const embedded = chunks.filter(c => c.vector?.length && c.embeddingModel === config.EMBEDDING_MODEL).length;
      if (dimensions === null) dimensions = chunks.find(c => c.vector)?.vector?.length ?? null;
      domainStats.push({ id: item.id, name: item.name, color: item.color, icon: item.icon, documents: docs.length, chunks: chunks.length, embeddedChunks: embedded });
    }
    res.json({
      embedding: {
        enabled: embeddingsEnabled(), model: config.EMBEDDING_MODEL || null,
        backend: config.EMBEDDING_BASE_URL ? 'local' : (config.EMBEDDING_MODEL ? 'cloud' : null),
        dimensions
      },
      domains: domainStats
    });
  });
  knowledgeRoutes(app, store);
  webRoutes(app, webImports);
  app.post('/api/neural-map/reindex', async (req, res) => {
    const domain = requireDomain(req, res, true); if (!domain) return;
    if (!embeddingsEnabled()) return void res.status(409).json({ error: 'Configure um provedor de embeddings antes de retomar a indexação.' });
    const queued = await ingestion.resumeEmbeddings(domain);
    await store.audit(req.principal.id, 'embedding.resume', domain);
    res.status(202).json({ queued });
  });
  app.get('/api/documents', async (req, res) => { const domain = requireDomain(req, res); if (domain) res.json(await store.documents(domain)); });
  app.post('/api/documents', documentUpload, async (req, res) => {
    const domain = requireDomain(req, res, true); if (!domain) return;
    if (!req.file) return void res.status(400).json({ error: 'Envie um arquivo TXT, MD, CSV, JSON, PDF, DOCX ou XLSX, até 50 MB.' });
    res.status(202).json(await ingestion.enqueue(req.file.originalname, req.file.buffer, domain, req.principal.id));
  });
  app.delete('/api/documents/:id', async (req, res) => {
    const doc = await store.document(String(req.params.id));
    if (!doc || !canWrite(req.principal, doc.domain)) return void res.status(404).json({ error: 'Documento não encontrado.' });
    if (doc.status === 'processing') return void res.status(409).json({ error: 'Aguarde o processamento.' });
    await ingestion.remove(doc.id, doc.domain, req.principal.id);
    res.status(204).end();
  });
  const inFlight = new Set<string>();
  app.post('/api/chat', rateLimit({ windowMs: 60_000, limit: 15, message: { error: 'Limite de consultas atingido.' } }), async (req, res) => {
    const input = querySchema.parse(req.body);
    if (!canRead(req.principal, input.domain)) return void res.status(403).json({ error: 'Acesso negado ao domínio.' });
    if (inFlight.has(req.principal.id) || inFlight.size >= 10) return void res.status(429).json({ error: 'Há uma consulta em andamento. Aguarde.' });
    inFlight.add(req.principal.id);
    const stop = latency.startTimer();
    const stream = req.headers.accept?.includes('text/event-stream');
    if (stream) { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders(); }
    const emit = (event: string, data: unknown) => { if (!res.destroyed) res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); };
    const heartbeat = stream ? setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000) : undefined;
    try {
      const persistedHistory = input.conversationId
        ? (await store.conversationRuns(req.principal.id, input.domain, input.conversationId)).map(run => ({ question: run.question, answer: run.answer }))
        : [];
      const run = await traced('lumina.query', () => orchestrate(store, req.principal, input.question, input.domain, input.agent, persistedHistory, input.conversationId, stream ? s => emit('step', s) : undefined));
      if (stream) { emit('result', run); res.end(); } else res.json(run);
    } catch (error) {
      const message = 'A consulta não foi concluída. Verifique o provedor e tente novamente.';
      console.error(JSON.stringify({ event: 'query.failed', requestId: req.requestId, type: error instanceof Error ? error.name : 'Error' }));
      await store.audit(req.principal.id, 'query.failed', req.requestId);
      if (stream) { emit('error', { error: message }); res.end(); } else res.status(502).json({ error: message, requestId: req.requestId });
    } finally { if (heartbeat) clearInterval(heartbeat); inFlight.delete(req.principal.id); stop(); }
  });
  app.get('/api/runs', async (req, res) => {
    const domain = requireDomain(req, res); if (domain) res.json(await store.runs(req.principal.id, domain));
  });
  app.post('/api/runs/:id/feedback', async (req, res) => {
    const { value } = z.object({ value: z.union([z.literal(-1), z.literal(1)]) }).parse(req.body);
    const run = await store.run(String(req.params.id));
    if (!run || run.owner !== req.principal.id || !canRead(req.principal, run.domain)) return void res.status(404).json({ error: 'Execução não encontrada.' });
    run.feedback = value; await store.saveRun(run); await store.audit(req.principal.id, 'query.feedback', run.id); res.json({ ok: true });
  });
  app.get('/api/integrations', (req, res) => res.json({ catalog: integrationCatalog, servers: listServers().filter(s => s.domains.some(d => canRead(req.principal, d))) }));
  app.get('/api/mcp/:id/tools', admin, async (req, res) => {
    const domain = requireDomain(req, res); if (!domain) return;
    if (!serverAllows(String(req.params.id), domain)) return void res.status(403).json({ error: 'Servidor não autorizado neste domínio.' });
    res.json(await listTools(String(req.params.id)));
  });
  app.post('/api/mcp/:id/call', admin, async (req, res) => {
    const input = z.object({ tool: z.string().min(1), arguments: z.record(z.string(), z.unknown()), domain: z.string() }).parse(req.body);
    if (!canRead(req.principal, input.domain) || !serverAllows(String(req.params.id), input.domain)) return void res.status(403).json({ error: 'Servidor não autorizado neste domínio.' });
    await store.audit(req.principal.id, 'mcp.call', String(req.params.id) + ':' + input.tool);
    res.json(await callTool(String(req.params.id), input.tool, input.arguments));
  });
  app.get('/api/audit', globalAdmin, async (_req, res) => res.json(await store.audits()));
  app.get('/api/metrics', globalAdmin, async (_req, res) => { res.setHeader('Content-Type', registry.contentType); res.send(await registry.metrics()); });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  const dist = resolve('dist/frontend');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*splat}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return void res.end();
    if (error instanceof AuthError) return void res.status(error.status).json({ error: error.message, detail: error.message });
    if (error instanceof z.ZodError) return void res.status(400).json({ error: 'Dados inválidos.', detail: 'Dados inválidos. Verifique os campos.', fields: error.issues.map(i => i.path.join('.')) });
    if (error instanceof multer.MulterError) return void res.status(400).json({ error: 'Upload inválido ou maior que 50 MB.' });
    console.error(JSON.stringify({ event: 'request.failed', requestId: req.requestId, type: error instanceof Error ? error.name : 'Error' }));
    res.status(500).json({ error: 'Falha ao processar a operação.', requestId: req.requestId });
  });
  return { app, ingestion, webImports };
}
