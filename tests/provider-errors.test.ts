import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../gateway/config.js';
import { generate } from '../core/llmops/provider.js';
import { ProviderHttpError } from '../core/llmops/errors.js';

test('provider failures retain HTTP status without exposing response bodies or credentials', async t => {
  const original = { LLM_PROVIDER: config.LLM_PROVIDER, LLM_MODEL: config.LLM_MODEL, LLM_API_KEY: config.LLM_API_KEY, ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY };
  t.after(() => Object.assign(config, original));
  Object.assign(config, { LLM_MODEL: 'test', LLM_API_KEY: 'private-test-key', ANTHROPIC_API_KEY: 'private-test-key' });
  let status = 401;
  t.mock.method(globalThis, 'fetch', async () => new Response('private-test-key untrusted upstream details', { status }));
  for (const provider of ['openai', 'anthropic', 'ollama'] as const) {
    config.LLM_PROVIDER = provider;
    for (const value of [401, 403, 429, 500]) {
      status = value;
      await assert.rejects(generate([{ role: 'user', content: 'Return JSON' }]), error => {
        assert.ok(error instanceof ProviderHttpError);
        assert.equal(error.status, value);
        assert.match(error.message, new RegExp('HTTP ' + value));
        assert.doesNotMatch(error.message, /private-test-key|untrusted/);
        if (value === 401) assert.match(error.message, /chave de API foi rejeitada/);
        return true;
      });
    }
  }
});
