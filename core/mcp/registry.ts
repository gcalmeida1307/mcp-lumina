import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { config } from '../../gateway/config.js';
const schema = z.array(z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), name: z.string().min(1),
  url: z.string().url(), tokenEnv: z.string().optional(),
  readOnlyTools: z.array(z.string()).default([]), domains: z.array(z.string()).min(1)
})).max(10);
const servers = schema.parse(JSON.parse(config.MCP_SERVERS_JSON));
const calls = new Map<string, { count: number; resetAt: number }>();
const MAX_ARGUMENT_BYTES = 32_000;
const MAX_CALLS_PER_MINUTE = 20;
for (const server of servers) {
  const url = new URL(server.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL MCP inválida.');
  if (config.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('MCP exige HTTPS em produção.');
}
async function connected<T>(id: string, fn: (client: Client, server: typeof servers[number]) => Promise<T>) {
  const server = servers.find(s => s.id === id);
  if (!server) throw new Error('Servidor MCP não configurado.');
  const client = new Client({ name: 'lumina', version: '0.1.0' });
  const token = server.tokenEnv ? process.env[server.tokenEnv] : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: token ? { Authorization: 'Bearer ' + token } : undefined, redirect: 'error', signal: AbortSignal.timeout(15000) }
  });
  try { await client.connect(transport); return await fn(client, server); }
  finally { await client.close(); }
}
export function listServers() { return servers.map(({ id, name, readOnlyTools, domains }) => ({ id, name, readOnlyTools, domains, status: 'configured' })); }
export function serverAllows(id: string, domain: string) { return servers.some(s => s.id === id && s.domains.includes(domain)); }
export async function listTools(id: string) {
  return connected(id, async (client, server) => (await client.listTools({}, { timeout: 15000 })).tools.filter(t => server.readOnlyTools.includes(t.name)));
}
export async function callTool(id: string, name: string, args: Record<string, unknown>) {
  const server = servers.find(item => item.id === id);
  if (!server) throw new Error('Servidor MCP não configurado.');
  if (!server.readOnlyTools.includes(name)) throw new Error('Ferramenta fora da lista de leitura autorizada.');
  const serialized = JSON.stringify(args);
  if (serialized.length > MAX_ARGUMENT_BYTES) throw new Error('Argumentos da ferramenta excedem o limite permitido.');
  const key = id + ':' + name;
  const now = Date.now();
  const state = calls.get(key);
  if (!state || state.resetAt <= now) calls.set(key, { count: 1, resetAt: now + 60_000 });
  else {
    if (state.count >= MAX_CALLS_PER_MINUTE) throw new Error('Limite de chamadas da ferramenta atingido.');
    state.count += 1;
  }
  return connected(id, client => client.callTool({ name, arguments: args }, undefined, { timeout: 15000 }));
}
