import { z } from 'zod';
import { operationSchema } from '../agents/operations.js';
const resourceRef = z.object({ id: z.string().min(1) });
export const understandingSchema = z.object({
  interaction: z.enum(['conversation', 'knowledge', 'action', 'mixed']),
  objective: z.string().min(1).max(2000), subjects: z.array(resourceRef).max(100),
  referencedResources: z.array(resourceRef).max(100), constraints: z.array(z.string().max(2000)).max(30),
  needsKnowledge: z.boolean(), needsTools: z.boolean(), needsVision: z.boolean(),
  needsCode: z.boolean(), needsContext: z.boolean(), uncertainty: z.array(z.string().max(2000)).max(30),
  suggestedOperations: z.array(operationSchema).max(20)
});
export type Understanding = z.infer<typeof understandingSchema>;
