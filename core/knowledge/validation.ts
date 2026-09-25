import { tokenize } from '../../data/processing/text.js';
import type { Chunk } from '../types.js';

export const validatorVersion = 'shared-statement-v1';
export type RelationEvidence = { sourceChunk: string; targetChunk: string; quote: string; confidence: number; coverage: number; validator: string };

// Conservative evidence judge: proves ONLY that both sources contain the same
// statement. It cannot validate causality, legal applicability or factual truth.
export function validateSharedStatement(left: Chunk[], right: Chunk[]): RelationEvidence | undefined {
  const statements = (chunks: Chunk[]) => chunks.flatMap(chunk =>
    (chunk.text.match(/[^.!?\n]+[.!?]?/g) ?? []).map(text => ({ chunk, text: text.trim() }))
      .filter(({ text }) => text.length >= 60 && text.length <= 700 && new Set(tokenize(text)).size >= 8
        && !/ignore|instru[çc][õo]es|system prompt|assistente|assistant|<\/?script|execute|obede[çc]/i.test(text)));
  const targets = new Map(statements(right).map(item => [item.text, item]));
  for (const source of statements(left)) {
    const target = targets.get(source.text);
    if (target && source.chunk.domain === target.chunk.domain && source.chunk.documentId !== target.chunk.documentId) {
      return { sourceChunk: source.chunk.id, targetChunk: target.chunk.id, quote: source.text, confidence: 1, coverage: 1, validator: validatorVersion };
    }
  }
}
