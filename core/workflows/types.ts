export type WorkflowRisk = 'read-only' | 'review-required' | 'external-effect';
export type WorkflowDefinition = {
  id: string;
  version: string;
  name: string;
  description: string;
  domains: string[];
  capabilities: string[];
  risk: WorkflowRisk;
  maxSteps: number;
};