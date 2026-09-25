import { loadBuffer } from 'cheerio';
import robotsParser from 'robots-parser';
import { setTimeout as pause } from 'node:timers/promises';
import { fetchPublic, pageUrl, WEB_AGENT } from './web-fetch.js';
import type { WebResponse } from './web-fetch.js';
import type { WebImportPage } from '../../core/web-import.js';
import { MAX_UPLOAD_BYTES, MAX_WEB_PAGES } from '../../core/ingestion-limits.js';

export function extractPage(body: Buffer, url: URL, contentType: string) {
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  const $ = loadBuffer(body, charset ? { encoding: { transportLayerEncodingLabel: charset } } : undefined);
  const title = $('title').first().text().trim() || $('h1').first().text().trim() || url.pathname;
  const directives = $('meta[name="robots"],meta[name="luminaofflinebot"]').map((_, el) => $(el).attr('content') ?? '').get().join(',').toLowerCase();
  const links = new Set<string>();
  if (!/\b(nofollow|none)\b/.test(directives)) $('a[href]').each((_, el) => {
    if (/\bnofollow\b/i.test($(el).attr('rel') ?? '')) return;
    try {
      const target = pageUrl($(el).attr('href')!, url.href);
      if (target.origin === url.origin && !/\.(pdf|zip|jpg|jpeg|png|gif|svg|mp4|mp3|css|js|docx?|xlsx?)$/i.test(target.pathname) && links.size < 500) links.add(target.href);
    } catch { /* Non-web and external actions are not followed. */ }
  });
  $('script,style,noscript,iframe,object,embed,nav,header,footer,form,button,svg,[hidden],[aria-hidden="true"]').remove();
  $('br').replaceWith('\n'); $('p,div,section,article,li,tr,h1,h2,h3,h4,pre,blockquote').append('\n\n'); $('td,th').append(' | ');
  const main = $('main').first().length ? $('main').first() : $('article').first().length ? $('article').first() : $('body');
  const text = main.text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n(?:\s*\n)+/g, '\n\n').trim();
  return { title: title.slice(0, 160), text, links: [...links], noArchive: /\b(noarchive|noindex|none)\b/.test(directives) };
}

type Dependencies = {
  fetch: (url: URL, signal: AbortSignal, maxBytes?: number) => Promise<WebResponse>;
  wait: (ms: number, signal: AbortSignal) => Promise<unknown>;
};
export async function crawlWebsite(input: {
  url: string; maxPages: number; signal: AbortSignal;
  save: (page: { url: string; title: string; text: string; links: string[]; body?: Buffer; contentType?: string }) => Promise<{ documentId: string; duplicate: boolean }>;
  progress: (page: WebImportPage, visited: number) => Promise<void>;
}, dependencies: Partial<Dependencies> = {}) {
  if (!Number.isInteger(input.maxPages) || input.maxPages < 1 || input.maxPages > MAX_WEB_PAGES) throw new Error('Escolha entre 1 e 25 páginas.');
  const start = pageUrl(input.url), origin = start.origin;
  const fetch = dependencies.fetch ?? fetchPublic;
  const wait = dependencies.wait ?? ((ms, signal) => pause(ms, undefined, { signal }));
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15 * 60_000)]);
  const robotsUrl = new URL('/robots.txt', origin);
  let robotsResponse = await fetch(robotsUrl, signal, 512 * 1024);
  let robotsCurrent = robotsUrl;
  for (let i = 0; robotsResponse.status >= 300 && robotsResponse.status < 400 && robotsResponse.headers.location; i++) {
    if (i >= 4) throw new Error('Redirecionamentos excessivos em robots.txt.');
    robotsCurrent = pageUrl(robotsResponse.headers.location, robotsCurrent.href);
    if (robotsCurrent.origin !== origin) throw new Error('robots.txt redireciona para outro domínio.');
    robotsResponse = await fetch(robotsCurrent, signal, 512 * 1024);
  }
  if (![200, 404, 410].includes(robotsResponse.status)) throw new Error('Não foi possível verificar robots.txt deste site.');
  const robots = robotsParser(robotsUrl.href, robotsResponse.status === 200 ? robotsResponse.body.toString('utf8') : '');
  const delay = Math.max(750, (robots.getCrawlDelay(WEB_AGENT) ?? 0) * 1000);
  if (delay > 60000) throw new Error('O intervalo solicitado pelo site excede o tempo disponível para importação.');
  const queue = [start.href], scheduled = new Set(queue), visited = new Set<string>();
  let requests = 0, bytes = 0;
  while (queue.length && requests < input.maxPages) {
    signal.throwIfAborted();
    let url = pageUrl(queue.shift()!);
    if (visited.has(url.href)) continue;
    try {
      let response: WebResponse | undefined;
      for (let redirect = 0; redirect < 6; redirect++) {
        if (url.origin !== origin) throw new Error('Redirecionamento para outro site ignorado. Use a URL final como uma nova importação.');
        if (robots.isAllowed(url.href, WEB_AGENT) === false) throw new Error('Página bloqueada pelo robots.txt.');
        if (visited.has(url.href)) throw new Error('Página já visitada.');
        if (requests >= input.maxPages) throw new Error('Limite de páginas atingido durante redirecionamento.');
        if (requests) await wait(delay, signal);
        visited.add(url.href); requests++;
        response = await fetch(url, signal);
        bytes += response.body.length;
        if (bytes > MAX_UPLOAD_BYTES) throw new Error('Limite total de captura de 50 MB atingido.');
        if (response.status >= 300 && response.status < 400 && response.headers.location) { url = pageUrl(response.headers.location, url.href); response = undefined; continue; }
        break;
      }
      if (!response) throw new Error('Redirecionamentos excessivos.');
      if (response.status < 200 || response.status >= 300) throw new Error(`O site retornou HTTP ${response.status}.`);
      const type = String(response.headers['content-type'] ?? '');
      if (/^application\/pdf\b/i.test(type)) {
        const saved = await input.save({ url: url.href, title: url.pathname.split('/').pop() || 'documento.pdf', text: '', links: [], body: response.body, contentType: type });
        await input.progress({ url: url.href, title: url.pathname.split('/').pop() || 'documento.pdf', documentId: saved.documentId, status: saved.duplicate ? 'duplicate' : 'saved' }, requests);
        continue;
      }
      if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(type)) throw new Error('A URL não retornou HTML ou PDF público.');
      const page = extractPage(response.body, url, type);
      const noArchive = /\b(noarchive|noindex|none)\b/i.test(String(response.headers['x-robots-tag'] ?? ''));
      if (page.noArchive || noArchive) throw new Error('A página solicita não ser arquivada/indexada.');
      for (const link of page.links) if (!scheduled.has(link) && scheduled.size < 500) { scheduled.add(link); queue.push(link); }
      if (page.text.length < 80) throw new Error('Texto insuficiente; a página pode depender de JavaScript ou login.');
      const saved = await input.save({ ...page, url: url.href });
      await input.progress({ url: url.href, title: page.title, documentId: saved.documentId, status: saved.duplicate ? 'duplicate' : 'saved' }, requests);
    } catch (error) {
      if (signal.aborted) throw error;
      await input.progress({ url: url.href, status: 'failed', detail: error instanceof Error ? error.message : 'Falha na captura.' }, requests);
      if (bytes > MAX_UPLOAD_BYTES) break;
    }
  }
}
