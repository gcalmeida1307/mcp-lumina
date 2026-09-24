import assert from 'node:assert/strict';
import test from 'node:test';

test('Ollama generation needs no paid key and never falls back to a cloud endpoint', async t => {
  const { config, generationEnabled } = await import('../gateway/config.js');
  const { generate } = await import('../core/llmops/provider.js');
  const original = { LLM_PROVIDER: config.LLM_PROVIDER, LLM_MODEL: config.LLM_MODEL, OLLAMA_BASE_URL: config.OLLAMA_BASE_URL };
  t.after(() => Object.assign(config, original));
  Object.assign(config, { LLM_PROVIDER: 'ollama', LLM_MODEL: 'test-model', OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1' });
  assert.equal(generationEnabled(), true);
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
  });
  const result = await generate([{ role: 'user', content: 'test' }]);
  assert.deepEqual(result, { data: { answer: 'ok' }, inputTokens: 10, outputTokens: 3 });
  fetch.mock.mockImplementation(async () => new Response('', { status: 503 }));
  await assert.rejects(generate([{ role: 'user', content: 'test' }]), /HTTP 503/);
  assert.equal(fetch.mock.callCount(), 2);
});
