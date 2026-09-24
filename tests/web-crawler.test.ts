import assert from 'node:assert/strict';
import test from 'node:test';
import { crawlWebsite, extractPage } from '../data/ingestion/web-crawler.js';
import { publicAddress, pageUrl, fetchPublic, WEB_AGENT } from '../data/ingestion/web-fetch.js';
import type { WebResponse } from '../data/ingestion/web-fetch.js';
import type { WebImportPage } from '../core/web-import.js';

const response = (body: string, status = 200, headers = {}): WebResponse => ({ status, body: Buffer.from(body), headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const html = (title: string, links = '') => `<html><head><title>${title}</title></head><body><nav>Menu descartado</nav><main><h1>${title}</h1><p>Conteúdo institucional suficiente para indexação e consulta offline, com procedimentos descritos e fontes preservadas.</p>${links}</main><script>executarCodigo()</script></body></html>`;
test('identifies the crawler while remaining compatible with sites that require a browser user agent', () => {
  assert.match(WEB_AGENT, /^Mozilla\/5\.0/); assert.match(WEB_AGENT, /LUMINAOfflineBot/);
});
test('rejects internal, mapped, loopback, reserved and credential URLs', async () => {
  for (const ip of ['127.0.0.1','10.0.0.1','172.18.1.43','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1','0.0.0.0','192.0.2.1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.throws(() => pageUrl('file:///etc/passwd'));
  assert.throws(() => pageUrl('https://user:pass@example.com'));
  assert.throws(() => pageUrl('http://example.com:4000'));
  await assert.rejects(fetchPublic(new URL('http://127.0.0.1'), new AbortController().signal), /públicos/);
});
test('normalizes fragments/tracking and extracts safe text without executing embedded content', () => {
  assert.equal(pageUrl('https://example.com/a?utm_source=x&b=2#section').href, 'https://example.com/a?b=2');
  const page = extractPage(Buffer.from(html('A &amp; B', '<a href="/b#part">Próxima</a><a href="https://other.test/">Fora</a><a href="javascript:alert(1)">Ação</a>')), new URL('https://example.com/a'), 'text/html');
  assert.equal(page.title, 'A & B'); assert.doesNotMatch(page.text, /executarCodigo|Menu descartado/);
  assert.deepEqual(page.links, ['https://example.com/b']);
});
test('crawler visits at most 25 pages, deduplicates links and never leaves origin', async () => {
  const visited: string[] = [], saved: string[] = [], progress: WebImportPage[] = [];
  await crawlWebsite({ url: 'https://example.com/', maxPages: 25, signal: new AbortController().signal,
    save: async page => { saved.push(page.url); return { documentId: String(saved.length), duplicate: false }; },
    progress: async page => { progress.push(page); }
  }, { wait: async () => {}, fetch: async url => {
    visited.push(url.href);
    if (url.pathname === '/robots.txt') return response('', 404);
    return response(html('Página '+url.pathname, Array.from({ length: 40 }, (_, i) => `<a href="/${i}#fragment">${i}</a><a href="/${i}">duplicada</a>`).join('')+'<a href="https://evil.test">externo</a>'));
  } });
  assert.equal(saved.length, 25); assert.equal(visited.length, 26); assert.equal(new Set(saved).size, 25);
  assert.ok(visited.every(url => url.startsWith('https://example.com/'))); assert.ok(progress.every(page => page.status === 'saved'));
});
test('robots restrictions, noarchive and off-origin redirects are honored', async () => {
  const visited: string[] = [], saved: string[] = [], progress: WebImportPage[] = [];
  await crawlWebsite({ url: 'https://example.com/', maxPages: 8, signal: new AbortController().signal,
    save: async page => { saved.push(page.url); return { documentId: 'doc', duplicate: false }; }, progress: async page => { progress.push(page); }
  }, { wait: async () => {}, fetch: async url => {
    visited.push(url.href);
    if (url.pathname === '/robots.txt') return response('User-agent: *\nDisallow: /private');
    if (url.pathname === '/redirect') return response('', 302, { location: 'http://127.0.0.1/' });
    if (url.pathname === '/archive') return response(html('Not archived').replace('<head>','<head><meta name="robots" content="noarchive">'));
    return response(html('Home', '<a href="/private">Privado</a><a href="/archive">Arquivo</a><a href="/redirect">Redirecionar</a>'));
  } });
  assert.deepEqual(saved, ['https://example.com/']); assert.ok(!visited.some(url => /private|127\.0/.test(url)));
  assert.equal(progress.filter(page => page.status === 'failed').length, 3);
});
test('cancellation retains prior saved pages and stops further downloads', async () => {
  const controller = new AbortController(); let count = 0;
  await assert.rejects(crawlWebsite({ url: 'https://example.com/', maxPages: 25, signal: controller.signal,
    save: async () => { count++; controller.abort(); return { documentId: 'saved', duplicate: false }; }, progress: async () => {}
  }, { wait: async () => {}, fetch: async url => url.pathname === '/robots.txt' ? response('',404) : response(html('Home','<a href="/next">Next</a>')) }));
  assert.equal(count, 1);
});
