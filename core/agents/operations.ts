import { z } from 'zod';

export const operationNameSchema = z.enum(['READ', 'SEARCH', 'MAP', 'EXPAND', 'COMPARE', 'CORRELATE', 'CALCULATE', 'EXECUTE', 'VERIFY', 'EXPLAIN']);
export const operationSchema = z.object({
  name: operationNameSchema, objective: z.string().min(1).max(2000),
  resourceIds: z.array(z.string().min(1)).max(100),
  parameters: z.record(z.string(), z.unknown()).default({})
});
export type CognitiveOperation = z.infer<typeof operationSchema>;
export const observationSchema = z.object({
  operationId: z.string().min(1), status: z.enum(['completed', 'insufficient', 'failed']),
  evidenceIds: z.array(z.string()), resourceIds: z.array(z.string()),
  summary: z.string().max(8000)
});
export type Observation = z.infer<typeof observationSchema>;
type OperationContract = {
  input: z.ZodType; output: z.ZodType;
};
/** Contracts only: registration does not grant execution permission. */
export const operationContracts: Record<CognitiveOperation['name'], OperationContract> = Object.fromEntries(
  operationNameSchema.options.map(name => [name, {
    input: operationSchema.extend({ name: z.literal(name) }), output: observationSchema
  }])
) as unknown as Record<CognitiveOperation['name'], OperationContract>;
export function validateOperation(input: unknown, allowed: CognitiveOperation['name'][], resourceIds: string[]) {
  const operation = operationSchema.parse(input);
  if (!allowed.includes(operation.name)) throw new Error('Operação não autorizada.');
  if (operation.resourceIds.some(id => !resourceIds.includes(id))) throw new Error('Recurso não autorizado.');
  return operation;
}
