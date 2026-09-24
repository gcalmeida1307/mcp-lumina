import http from 'node:http';
import { networkInterfaces } from 'node:os';

// Expose the built application, never the Vite development server or project files.
const port = Number(process.env.LAN_PORT || 8080);
const backend = 'http://127.0.0.1:4000';
const auth = await fetch(backend + '/api/auth/config', { signal: AbortSignal.timeout(5000) }).then(response => {
  if (!response.ok) throw new Error('A API do LUMINA não está disponível na porta 4000.');
  return response.json();
});
if (auth.mode !== 'native') throw new Error('Este acesso LAN exige autenticação native. OIDC requer configurar também o endereço de rede no provedor de identidade.');
const page = await fetch(backend, { signal: AbortSignal.timeout(5000) });
if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) throw new Error('Compile a aplicação com npm run build antes de abrir o acesso LAN.');

const server = http.createServer((request, response) => {
  const upstream = http.request({
    hostname: '127.0.0.1', port: 4000, path: request.url,
    method: request.method,
    // Preserve the public Host for same-origin CSRF checks. No credentials leave this machine.
    headers: { ...request.headers, connection: 'close' }
  }, incoming => {
    response.writeHead(incoming.statusCode || 502, incoming.headers);
    incoming.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('A API do LUMINA está indisponível. Inicie npm run dev:api neste computador.');
  });
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '0.0.0.0', () => {
  for (const addresses of Object.values(networkInterfaces())) for (const address of addresses || []) {
    if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) console.log(`LUMINA na rede: http://${address.address}:${port}`);
  }
  console.log('Autenticação existente preservada. A API local na porta 4000 deve permanecer em execução.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
