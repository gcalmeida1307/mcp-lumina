import type { Express } from 'express';
import { z } from 'zod';
import { requireDomain } from '../security/policies/access.js';
import type { WebImports } from '../data/ingestion/web-imports.js';
import { pageUrl } from '../data/ingestion/web-fetch.js';
import { MAX_WEB_PAGES } from '../core/ingestion-limits.js';

export function webRoutes(app: Express, imports: WebImports) {
  app.get('/api/web-imports', async (req, res) => {
    const domain = requireDomain(req, res); if (!domain) return;
    res.json(await imports.list(domain, req.principal.id));
  });
  app.post('/api/web-imports', async (req, res) => {
    const domain = requireDomain(req, res, true); if (!domain) return;
    const input = z.object({ url: z.string().url().max(2048), maxPages: z.number().int().min(1).max(MAX_WEB_PAGES).default(MAX_WEB_PAGES) }).parse(req.body);
    try { pageUrl(input.url); } catch (error) { return void res.status(400).json({ error: error instanceof Error ? error.message : 'URL inválida.' }); }
    try { res.status(202).json(await imports.start(input.url, domain, req.principal.id, input.maxPages)); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Não foi possível iniciar a importação.' }); }
  });
  app.post('/api/web-imports/:id/cancel', async (req, res) => {
    const domain = requireDomain(req, res, true); if (!domain) return;
    if (!await imports.cancel(String(req.params.id), domain, req.principal.id)) return void res.status(404).json({ error: 'Importação não encontrada.' });
    res.json({ ok: true });
  });
  app.post('/api/web-imports/:id/retry', async (req, res) => {
    const domain = requireDomain(req, res, true); if (!domain) return;
    try {
      const job = await imports.retry(String(req.params.id), domain, req.principal.id);
      if (!job) return void res.status(404).json({ error: 'Importação não pode ser repetida.' });
      res.status(202).json(job);
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Não foi possível repetir a importação.' }); }
  });
  app.delete('/api/web-imports/:id', async (req, res) => {
    const domain = requireDomain(req, res, true); if (!domain) return;
    if (!await imports.remove(String(req.params.id), domain, req.principal.id)) return void res.status(409).json({ error: 'Importações em andamento não podem ser removidas.' });
    res.status(204).end();
  });
}
