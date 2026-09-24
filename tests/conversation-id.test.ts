import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationId } from '../frontend/src/conversation-id.js';

test('LAN HTTP can create valid independent conversation UUIDs without randomUUID', () => {
  const source = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) };
  const a = conversationId(source), b = conversationId(source);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});
