import type { WorkflowDefinition } from './types.js';

export const workflows: WorkflowDefinition[] = [
  {
    id: 'document-answer',
    version: '1.0.0',
    name: 'Resposta documental validada',
    description: 'Planeja consultas, recupera evidências, gera resposta citável e executa revisão independente.',
    domains: ['*'],
    capabilities: ['search.lexical', 'search.semantic', 'memory.read', 'evidence.review'],
    risk: 'review-required',
    maxSteps: 8
  }
];

export function workflow(id: string, version?: string) {
  return workflows.find(item => item.id === id && (!version || item.version === version));
}