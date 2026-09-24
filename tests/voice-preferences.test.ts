import assert from 'node:assert/strict';
import test from 'node:test';
import { selectVoice } from '../frontend/src/voice-preferences.js';
const male = { name: 'Microsoft Antonio', lang: 'pt-BR', voiceURI: 'antonio' };
const female = { name: 'Microsoft Francisca Online', lang: 'pt-BR', voiceURI: 'francisca' };
test('automatic voice preference selects a known feminine Portuguese voice regardless of ordering', () => {
  assert.equal(selectVoice([male, female]), female);
  assert.equal(selectVoice([{ name: 'Maria', lang: 'en-US', voiceURI: 'en' }, male, female]), female);
});
test('manual selection wins and a removed voice falls back predictably', () => {
  assert.equal(selectVoice([male, female], 'antonio'), male);
  assert.equal(selectVoice([male, female], 'missing'), female);
  assert.equal(selectVoice([]), undefined);
});
