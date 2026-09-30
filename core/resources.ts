import { z } from 'zod';
import type { DocumentRecord } from './types.js';

export const resourceDescriptorSchema = z.object({
  id: z.string().min(1), kind: z.enum(['document', 'image', 'dataset', 'database', 'api', 'mcp_tool', 'memory', 'code', 'event', 'unknown']),
  name: z.string(), mimeType: z.string().optional(), domains: z.array(z.string()),
  type: z.string().optional(), roles: z.array(z.enum(['subject', 'reference', 'semantic_resource', 'evidence', 'context', 'tool'])),
  authority: z.string().optional(), freshness: z.string().optional(), capabilities: z.array(z.string()),
  provenance: z.object({ source: z.string(), fingerprint: z.string().optional() }),
  metadata: z.record(z.string(), z.object({ value: z.unknown(), origin: z.enum(['user', 'system', 'inferred']) }))
});
export type ResourceDescriptor = z.infer<typeof resourceDescriptorSchema>;
export function describeDocument(document: DocumentRecord): ResourceDescriptor {
  return {
    id: document.id, kind: 'document', name: document.name, domains: [document.domain],
    roles: ['context'], capabilities: document.status === 'ready' ? ['READ', 'SEARCH'] : [],
    freshness: document.capturedAt,
    provenance: { source: document.sourceUrl ?? document.id, fingerprint: document.contentHash ?? document.hash },
    metadata: { status: { value: document.status, origin: 'system' }, chunks: { value: document.chunks, origin: 'system' } }
  };
}
/** Inference can enrich metadata but cannot override declarations or confer authority. */
export function enrichResource(resource: ResourceDescriptor, inferred: Record<string, unknown>): ResourceDescriptor {
  const metadata = { ...resource.metadata };
  for (const [key, value] of Object.entries(inferred)) {
    if (!metadata[key] || metadata[key].origin === 'inferred') metadata[key] = { value, origin: 'inferred' };
  }
  return { ...resource, metadata };
}
