export type SkillDefinition = {
  id: string;
  version: string;
  purpose: string;
  inputs: string[];
  outputs: string[];
  capabilities: string[];
  requiresReview: boolean;
};

export const skills: SkillDefinition[] = [
  { id: 'research-plan', version: '1.0.0', purpose: 'Decompor perguntas em consultas documentais curtas.', inputs: ['question', 'documentNames', 'approvedMemory'], outputs: ['queries'], capabilities: ['search.plan'], requiresReview: false },
  { id: 'evidence-revision', version: '1.0.0', purpose: 'Revisar afirmações e citações contra fontes recuperadas.', inputs: ['question', 'answer', 'sources'], outputs: ['claimVerdicts', 'coverage', 'verdict'], capabilities: ['evidence.review'], requiresReview: true },
  { id: 'memory-governance', version: '1.0.0', purpose: 'Controlar aprovação, rejeição e revogação de memórias.', inputs: ['memory', 'decision'], outputs: ['state', 'audit'], capabilities: ['memory.approve'], requiresReview: true }
];