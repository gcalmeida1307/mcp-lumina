import assert from 'node:assert/strict';
import test from 'node:test';
import { repairMojibake, sanitizeUntrustedText } from '../data/processing/text.js';

test('repairs UTF-8 text decoded as Latin-1 without changing valid Portuguese', () => {
  assert.equal(repairMojibake('RecomendaÃ§Ã£o sobre a Ã‰tica'), 'Recomendação sobre a Ética');
  assert.equal(repairMojibake('Recomendação sobre a Ética'), 'Recomendação sobre a Ética');
});

test('removes invisible bidi and zero-width controls from untrusted text', () => {
  assert.equal(sanitizeUntrustedText('artigo\u202E oculto\u200B'), 'artigo oculto');
});