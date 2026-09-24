import type { Chunk, DocumentRecord } from '../types.js';
import type { MapDocument, MapRelation } from './types.js';
import { tokenize } from '../../data/processing/text.js';

export function describeDocument(document: DocumentRecord, chunks: Chunk[]): MapDocument {
  return { id: document.id, name: document.name, domain: document.domain, createdAt: document.createdAt, chunks: chunks.length, embeddedChunks: chunks.filter(chunk => chunk.vector?.length).length, sourceUrl: document.sourceUrl, capturedAt: document.capturedAt };
}

// Compare bounded summaries, never every pair of passages. Vectors from different
// models/dimensions cannot be compared. Lexical links are explicitly distinguished.
export function documentRelations(documents: DocumentRecord[], chunks: Chunk[]): MapRelation[] {
  const ids = new Set(documents.map(document => document.id));
  const grouped = new Map<string, Chunk[]>();
  for (const chunk of chunks) if (ids.has(chunk.documentId)) {
    const group = grouped.get(chunk.documentId) ?? [];
    group.push(chunk); grouped.set(chunk.documentId, group);
  }
  const summaries = documents.map(document => {
    const all = (grouped.get(document.id) ?? []).sort((a, b) => a.index - b.index);
    // Deterministic, evenly spaced sample limits work and covers long documents.
    const sample = all.filter((_, i) => i % Math.max(1, Math.ceil(all.length / 32)) === 0).slice(0, 32);
    const valid = sample.filter(chunk => chunk.embeddingModel && chunk.vector?.length && chunk.vector.every(Number.isFinite));
    const model = valid[0]?.embeddingModel, dimensions = valid[0]?.vector?.length;
    const vectors = valid.filter(chunk => chunk.embeddingModel === model && chunk.vector?.length === dimensions);
    const mean = dimensions ? Array<number>(dimensions).fill(0) : [];
    for (const chunk of vectors) {
      const norm = Math.hypot(...chunk.vector!);
      if (norm) chunk.vector!.forEach((value, i) => { mean[i] += value / norm; });
    }
    const norm = Math.hypot(...mean);
    const vector = norm && vectors.length >= Math.ceil(sample.length / 2) ? mean.map(value => value / norm) : [];
    const frequencies = new Map<string, number>();
    for (const word of tokenize(document.name + ' ' + sample.map(chunk => chunk.text.slice(0, 2500)).join(' '))) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    const terms = new Set([...frequencies].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 60).map(([term]) => term));
    return { id: document.id, domain: document.domain, model, vector, terms };
  });
  const candidates: MapRelation[] = [];
  for (let i = 0; i < summaries.length; i++) for (let j = i + 1; j < summaries.length; j++) {
    const a = summaries[i], b = summaries[j];
    if (a.domain !== b.domain) continue;
    const semantic = a.vector.length > 0 && a.vector.length === b.vector.length && a.model === b.model;
    const overlap = [...a.terms].filter(term => b.terms.has(term)).length;
    const score = semantic ? a.vector.reduce((sum, value, index) => sum + value * b.vector[index], 0) : overlap / (a.terms.size + b.terms.size - overlap || 1);
    if (Number.isFinite(score) && score >= (semantic ? .65 : .18)) candidates.push({ source: a.id, target: b.id, score: Math.min(1, score), method: semantic ? 'semantic' : 'lexical' });
  }
  const degree = new Map<string, number>();
  return candidates.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source)).filter(edge => {
    if ((degree.get(edge.source) ?? 0) >= 3 || (degree.get(edge.target) ?? 0) >= 3) return false;
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1); degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    return true;
  });
}
