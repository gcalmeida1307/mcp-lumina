import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeLogin, waitForAuthConfig } from '../frontend/src/auth.js';
import { storedConversation } from '../frontend/src/conversation-storage.js';
import { ask } from '../frontend/src/api.js';

test('login preserves the form when authentication requires another step', async t => {
  for (const [flag, message] of [['requires_2fa', /autenticador/], ['requires_activation', /ativada/], ['requires_password_reset', /redefinida/]] as const) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ [flag]: true }));
    await assert.rejects(nativeLogin('AB000001', 'example'), message);
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ user: { user_code: 'AB000001' } }));
  assert.equal((await nativeLogin('AB000001', 'example')).user.user_code, 'AB000001');
});

test('startup retries refused connections and proxy errors until the API is ready', async t => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempts++;
    if (attempts === 1) throw new TypeError('fetch failed');
    return attempts === 2 ? new Response('', { status: 500 }) : Response.json({ mode: 'native' });
  });
  assert.deepEqual(await waitForAuthConfig(1000, 1), { mode: 'native' });
  assert.equal(attempts, 3);
});

test('startup stops retrying and gives actionable feedback when the API stays offline', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(waitForAuthConfig(10, 1), /terminal do servidor/);
});

test('conversation IDs survive switching domains and remain isolated between users', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const a = storedConversation('one', 'geral', false, storage);
  const b = storedConversation('one', 'direito', false, storage);
  assert.notEqual(a, b);
  assert.equal(storedConversation('one', 'geral', false, storage), a);
  assert.equal(storedConversation('one', 'direito', false, storage), b);
  assert.notEqual(storedConversation('two', 'geral', false, storage), a);
  assert.notEqual(storedConversation('one', 'geral', true, storage), a);
  values.set('lumina:conversation:one:geral', 'corrupted');
  assert.notEqual(storedConversation('one', 'geral', false, storage), 'corrupted');
});

test('chat uses server history and receives fragmented streamed responses', async t => {
  const id = crypto.randomUUID();
  const encoder = new TextEncoder();
  const events = 'event: step\ndata: {"name":"Busca"}\n\nevent: result\ndata: {"answer":"Olá"}\n\n';
  const bytes = encoder.encode(events);
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)), { question: 'Olá', domain: 'geral', agent: false, conversationId: id });
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }));
  });
  const steps: string[] = [];
  const result = await ask('Olá', 'geral', false, [{ question: 'Antes', answer: 'x'.repeat(13000) }], id, step => steps.push(step.name));
  assert.equal(result.answer, 'Olá');
  assert.deepEqual(steps, ['Busca']);
});

test('chat surfaces the request reference from HTTP and streamed failures', async t => {
  for (const streamed of [false, true]) {
    const payload = { error: 'Falha na interpretação.', requestId: 'test-request-123' };
    t.mock.method(globalThis, 'fetch', async () => streamed
      ? new Response('event: error\ndata: ' + JSON.stringify(payload) + '\n\n')
      : Response.json(payload, { status: 502 }));
    await assert.rejects(ask('Compare', 'direito', false, [], crypto.randomUUID(), () => {}), /Falha na interpretação.*test-request-123/);
    t.mock.restoreAll();
  }
});
