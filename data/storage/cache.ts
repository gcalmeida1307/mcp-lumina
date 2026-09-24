import { createClient } from 'redis';
import { config } from '../../gateway/config.js';
const memory = new Map<string, { until: number; value: unknown }>();
let redis: ReturnType<typeof createClient> | undefined;
export async function initCache() {
  if (!config.REDIS_URL) return;
  redis = createClient({ url: config.REDIS_URL, socket: { connectTimeout: 3000, reconnectStrategy: false } });
  redis.on('error', () => console.warn('Redis indisponível; cache local ativado.'));
  try { await redis.connect(); } catch { redis = undefined; }
}
export async function cached<T>(key: string, loader: () => Promise<T>, ttl = 60): Promise<T> {
  try { const hit = redis?.isReady ? await redis.get(key) : undefined; if (hit) return JSON.parse(hit); } catch { /* optional cache */ }
  const hit = memory.get(key);
  if (hit && hit.until > Date.now()) return hit.value as T;
  const value = await loader();
  if (memory.size >= 500) memory.delete(memory.keys().next().value!);
  memory.set(key, { until: Date.now() + ttl * 1000, value });
  try { if (redis?.isReady) await redis.set(key, JSON.stringify(value), { EX: ttl }); } catch { /* source remains authoritative */ }
  return value;
}
export async function closeCache() { if (redis?.isOpen) await redis.quit(); memory.clear(); }
