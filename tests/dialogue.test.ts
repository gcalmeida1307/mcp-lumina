import assert from 'node:assert/strict';
import test from 'node:test';
import { socialReply } from '../core/orchestrator/dialogue.js';
import { boundedHistory, conversationPrompt } from '../core/orchestrator/context.js';

test('social turns are conversational without pretending to consult documents', () => {
  assert.match(socialReply('Olá, LUMINA!')!, /Olá/);
  assert.match(socialReply('muito obrigada')!, /Por nada/);
  assert.equal(socialReply('Olá, qual o prazo do contrato?'), undefined);
  assert.equal(socialReply('obrigado, mas qual é a multa?'), undefined);
});
test('context retains latest factual turns within a fixed budget', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ question: `${i}: ` + 'q'.repeat(4000), answer: 'a'.repeat(12000) }));
  const recent = boundedHistory(history);
  assert.ok(recent.reduce((sum, turn) => sum + turn.question.length + turn.answer.length, 0) <= 9000);
  assert.match(recent.at(-1)!.question, /^9:/);
  assert.ok(conversationPrompt(history).length < 9500);
});
test('social conversation does not pollute subsequent document retrieval', () => {
  assert.deepEqual(boundedHistory([{ question: 'oi', answer: 'Olá' }, { question: 'Qual o prazo?', answer: '10 dias' }, { question: 'Obrigado', answer: 'De nada' }]), [{ question: 'Qual o prazo?', answer: '10 dias' }]);
});
