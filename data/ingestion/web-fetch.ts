import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { MAX_UPLOAD_BYTES } from '../../core/ingestion-limits.js';

export const WEB_AGENT = 'LUMINAOfflineBot';
export type WebResponse = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
export function publicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function pageUrl(input: string, base?: string): URL {
  const url = new URL(input, base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('Use uma URL pública HTTP/HTTPS, sem credenciais nem porta personalizada.');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url;
}

/** Resolve once, reject internal/reserved addresses and pin the validated address to the socket (including redirects). */
export async function fetchPublic(url: URL, signal: AbortSignal, maxBytes = MAX_UPLOAD_BYTES): Promise<WebResponse> {
  pageUrl(url.href);
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Tempo de resolução DNS excedido.')), 5000); timer.unref(); })
  ]);
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('A importação aceita somente sites públicos; endereços internos ou reservados são bloqueados.');
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, {
      agent: false, signal,
      headers: { 'User-Agent': `${WEB_AGENT}/1.0`, Accept: 'text/html,application/xhtml+xml,text/plain', 'Accept-Encoding': 'gzip, deflate, br' },
      lookup: (_host, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      }
    }, response => {
      response.on('error', reject);
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) { response.resume(); resolve({ status, headers: response.headers, body: Buffer.alloc(0) }); return; }
      if (Number(response.headers['content-length']) > maxBytes) { response.destroy(new Error('Página excede o limite de tamanho.')); return; }
      const encoding = response.headers['content-encoding'];
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
      if (encoding && encoding !== 'identity' && !decoder) { response.destroy(new Error('Compressão não suportada.')); return; }
      const stream = decoder ? response.pipe(decoder) : response;
      if (decoder) { decoder.on('error', error => { response.destroy(); reject(error); }); response.on('error', () => decoder.destroy()); }
      const buffers: Buffer[] = []; let bytes = 0;
      stream.on('data', (buffer: Buffer) => { bytes += buffer.length; if (bytes > maxBytes) { stream.destroy(new Error('Página excede o limite de tamanho.')); response.destroy(); } else buffers.push(buffer); });
      stream.on('end', () => resolve({ status, headers: response.headers, body: Buffer.concat(buffers) }));
    });
    const timer = setTimeout(() => request.destroy(new Error('O site demorou mais de 20 segundos para responder.')), 20000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}
