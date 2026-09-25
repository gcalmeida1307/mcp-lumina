import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRun } from '../core/llmops/evaluation.js';
import { workflows } from '../core/workflows/catalog.js';

test('continuous evaluation records review coverage and verdict', () => {
  const result = evaluateRun({ id: 'run', owner: 'u', domain: 'direito', createdAt: '2026-01-01', question: 'q', answer: 'a', sources: [], steps: [], mode: 'model', status: 'completed', durationMs: 1, inputTokens: 0, outputTokens: 0, review: { runId: 'run', verdict: 'pass', coverage: 1, claims: [], reviewer: 'test', createdAt: '2026-01-01' } });
  assert.equal(result.groundedness, 1);
  assert.equal(result.reviewVerdict, 'pass');
});

test('document workflow declares read-only capabilities and review risk', () => {
  const workflow = workflows.find(item => item.id === 'document-answer');
  assert.ok(workflow);
  assert.equal(workflow.risk, 'review-required');
  assert.ok(workflow.capabilities.includes('evidence.review'));
  assert.equal(workflow.domains[0], '*');
});