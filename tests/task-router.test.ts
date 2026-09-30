import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../gateway/config.js';
import { routeMessage } from '../core/orchestrator/taskRouter.js';
import { contextualizeQuestion } from '../core/orchestrator/context.js';

test('follow-ups stay on the latest explicit topic switch', () => {
  const query = contextualizeQuestion('E quanto ao prazo?', [
    { question: 'Quais contratos estao ativos?', answer: 'Alfa.' },
    { question: 'Mudando de assunto, explique recursos.', answer: 'Recursos.' }
  ]);
  assert.match(query, /explique recursos/);
  assert.doesNotMatch(query, /contratos/);
});

test('offline routing preserves references but never invents previous turns', async t => {
  const original = config.LLM_MODEL;
  t.after(() => { config.LLM_MODEL = original; });
  config.LLM_MODEL = '';
  const history = [{ question: 'Investigue riscos no contrato.', answer: 'Prazo curto.' }];
  assert.equal((await routeMessage('Isso apresenta riscos?', history)).preserveState, true);
  const correction = await routeMessage('Voce errou.', []);
  assert.equal(correction.preserveState, false);
  assert.notEqual(correction.task, 'correction');
  assert.equal((await routeMessage('Mudando de assunto, explique melhor recursos.', history)).preserveState, false);
});
