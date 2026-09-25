import assert from 'node:assert/strict';
import test from 'node:test';
import { contextualizeQuestion, conversationPrompt, isAnswerCorrection, relevantMemories } from '../core/orchestrator/context.js';
import type { ResearchMemory } from '../core/types.js';

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

test('candidate memories are excluded until governance approval', () => {
  const memories = [{ id: 'candidate', owner: 'u', domain: 'direito', question: 'prazo de recurso', answer: 'candidato', sourceIds: [], createdAt: '2026-01-01', state: 'candidate' as const }, { id: 'approved', owner: 'u', domain: 'direito', question: 'prazo de recurso', answer: 'aprovado', sourceIds: [], createdAt: '2026-01-01', state: 'approved' as const }];
  assert.deepEqual(relevantMemories('qual o prazo de recurso?', memories).map(memory => memory.id), ['approved']);
});

test('answer correction keeps the original question as the retrieval task', () => {
  const correction = 'B) é possível alienar o imóvel. Essa seria a resposta correta';
  assert.equal(isAnswerCorrection(correction), true);
  const query = contextualizeQuestion(correction, [{ question: 'Qual alternativa está correta sobre a desapropriação?', answer: 'Não foi possível validar.' }]);
  assert.match(query, /Qual alternativa está correta sobre a desapropriação/);
  assert.match(query, /Feedback do usuário/);
});

test('selects relevant research memory instead of only the newest memory', () => {
  const memory = (id: string, question: string, createdAt: string): ResearchMemory => ({ id, owner: 'u', domain: 'direito', question, answer: 'Resposta validada.', sourceIds: [], createdAt });
  const result = relevantMemories('qual o prazo de recurso?', [
    memory('new', 'Como funciona a autenticação?', '2026-02-02T00:00:00Z'),
    memory('old', 'Qual o prazo para interpor recurso?', '2026-01-01T00:00:00Z')
  ]);
  assert.deepEqual(result.map(item => item.id), ['old']);
});
