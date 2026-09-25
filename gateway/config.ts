import 'dotenv/config';
import { resolve } from 'node:path';
import { z } from 'zod';
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  AUTH_MODE: z.enum(['local', 'native', 'oidc']).default('native'),
  LUMINA_ENCRYPTION_KEY: z.string().default(''),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATA_DIR: z.string().default('data/runtime'),
  DATABASE_URL: z.string().default(''),
  REDIS_URL: z.string().default(''),
  LLM_PROVIDER: z.enum(['openai', 'anthropic', 'ollama']).default('openai'),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434/v1'),
  LLM_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  LLM_API_KEY: z.string().default(''),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  ANTHROPIC_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default(''),
  REVIEW_LLM_MODEL: z.string().default(''),
  EMBEDDING_MODEL: z.string().default(''),
  EMBEDDING_BASE_URL: z.string().default(''),
  EMBEDDING_API_KEY: z.string().default(''),
  OIDC_ISSUER: z.string().default(''),
  OIDC_JWKS_URL: z.string().default(''),
  OIDC_AUDIENCE: z.string().default('lumina-api'),
  OIDC_CLIENT_ID: z.string().default('lumina-web'),
  S3_ENDPOINT: z.string().default(''),
  S3_ACCESS_KEY: z.string().default(''),
  S3_SECRET_KEY: z.string().default(''),
  S3_BUCKET: z.string().default('lumina'),
  MCP_SERVERS_JSON: z.string().default('[]'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  KNOWLEDGE_ENABLED: z.enum(['true', 'false']).default('true').transform(value => value === 'true'),
  KNOWLEDGE_POLL_MS: z.coerce.number().int().min(100).default(1500),
  KNOWLEDGE_MAX_LAG_MS: z.coerce.number().int().min(10).default(100),
  KNOWLEDGE_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  KNOWLEDGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  KNOWLEDGE_EMBEDDING_BATCH: z.coerce.number().int().min(1).max(16).default(2),
  KNOWLEDGE_EMBEDDING_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(180000),
  MAX_DOCUMENT_CHARS: z.coerce.number().int().positive().default(60_000_000),
  MAX_DOCUMENT_CHUNKS: z.coerce.number().int().positive().default(60_000)
});
export const config = schema.parse(process.env);
config.DATA_DIR = resolve(config.DATA_DIR);
if (config.NODE_ENV === 'production' && config.AUTH_MODE === 'local') {
  throw new Error('Produção exige autenticação native ou oidc.');
}
if (config.AUTH_MODE === 'native' && !/^[a-f0-9]{64}$/i.test(config.LUMINA_ENCRYPTION_KEY)) throw new Error('Configure LUMINA_ENCRYPTION_KEY com 32 bytes hexadecimais antes de iniciar.');
if (config.AUTH_MODE === 'local' && config.NODE_ENV !== 'development') {
  throw new Error('AUTH_MODE=local só pode ser usado em desenvolvimento.');
}
if (config.AUTH_MODE === 'oidc' && (!config.OIDC_ISSUER || !config.OIDC_JWKS_URL)) {
  throw new Error('Configure OIDC_ISSUER e OIDC_JWKS_URL.');
}
export const generationEnabled = () => Boolean(config.LLM_MODEL && (config.LLM_PROVIDER === 'ollama' || (config.LLM_PROVIDER === 'anthropic' ? config.ANTHROPIC_API_KEY : config.LLM_API_KEY)));
// A local embedding endpoint (e.g. Ollama) needs no paid API key.
export const embeddingsEnabled = () => Boolean(config.EMBEDDING_MODEL && (config.EMBEDDING_BASE_URL || config.LLM_API_KEY));
