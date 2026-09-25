import type { EvaluationResult, Run } from '../types.js';

export const evaluationVersion = 'continuous-eval-v1';
export function evaluateRun(run: Run): EvaluationResult {
  return {
    runId: run.id,
    groundedness: run.review?.coverage ?? (run.status === 'abstained' ? 1 : 0),
    citationValidity: run.sources.length || run.status === 'abstained' ? 1 : 0,
    reviewVerdict: run.review?.verdict ?? 'none',
    feedback: run.feedback,
    createdAt: new Date().toISOString()
  };
}