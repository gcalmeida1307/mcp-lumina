import type { Evidence } from '../types.js';
import type { ResourceDescriptor } from '../resources.js';
import type { CognitiveOperation, Observation } from '../agents/operations.js';
import type { Understanding } from './understanding.js';
export type InvestigationState = {
  understanding?: Understanding; resources: ResourceDescriptor[]; evidence: Evidence[];
  observations: Observation[]; pending?: CognitiveOperation;
  budget: { maxSteps: number; maxToolCalls: number; maxTokens: number; maxRetries: number; timeoutMs: number };
  usage: { steps: number; toolCalls: number; tokens: number; retries: number }; startedAt: number;
};
export function createInvestigation(resources: ResourceDescriptor[] = []): InvestigationState {
  return { resources, evidence: [], observations: [],
    // Each step now costs a couple of seconds (fast remote fallback) rather than minutes, so allow more of them.
    budget: { maxSteps: 20, maxToolCalls: 12, maxTokens: 60000, maxRetries: 2, timeoutMs: 180000 },
    usage: { steps: 0, toolCalls: 0, tokens: 0, retries: 0 }, startedAt: Date.now() };
}
/** Preserve original passages. Prompt selection is a separate, bounded view. */
export function accumulateEvidence(previous: Evidence[], batches: Evidence[][]) {
  const evidence = new Map(previous.map(item => [item.id, item]));
  for (const item of batches.flat()) {
    const prior = evidence.get(item.id);
    if (!prior || item.score > prior.score) evidence.set(item.id, item);
  }
  return [...evidence.values()];
}
