import assert from 'node:assert/strict';
import test from 'node:test';
import { contextualizeQuestion, conversationPrompt } from '../core/orchestrator/context.js';

test('expands a follow-up with the previous subject', () => {
  const result = contextualizeQuestion('E qual deles tem prazo menor?', [{
    question: 'Quais contratos estão ativos?',
    answer: 'Os contratos Alfa e Beta estão ativos.'
  }]);
  assert.match(result, /contratos estão ativos/);
  assert.match(result, /E qual deles tem prazo menor/);
});

test('does not invent context for a first question', () => {
  assert.equal(contextualizeQuestion('Quais contratos estão ativos?', []), 'Quais contratos estão ativos?');
  assert.equal(conversationPrompt([]), 'Nenhum turno anterior.');
});

test('independent questions do not inherit earlier subjects or generated answer terms', () => {
  const history = Array.from({ length: 7 }, (_, index) => ({
    question: `pergunta ${index}`,
    answer: 'x'.repeat(2000)
  }));
  const result = contextualizeQuestion('pergunta atual', history);
  assert.equal(result, 'pergunta atual');
  const followup = contextualizeQuestion('Qual deles?', history);
  assert.match(followup, /pergunta 6/);
  assert.doesNotMatch(followup, /pergunta 0|xxx/);
});
