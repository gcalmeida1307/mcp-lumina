import { createHash } from 'node:crypto';
import type { Store } from '../../data/storage/database.js';
import { cached } from '../../data/storage/cache.js';
import { tokenize } from '../../data/processing/text.js';
import { config, embeddingsEnabled } from '../../gateway/config.js';
import { embed } from '../llmops/provider.js';
import type { Chunk, Evidence } from '../types.js';
export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 0;
  const dot = a.reduce((sum, n, i) => sum + n * b[i], 0);
  const norm = Math.sqrt(a.reduce((s, n) => s + n * n, 0) * b.reduce((s, n) => s + n * n, 0));
  return norm ? dot / norm : 0;
}
export function lexical(query: string, chunks: Chunk[]) {
  const terms = [...new Set(tokenize(query))];
  const tokens = chunks.map(c => tokenize(c.text));
  const titleTokens = chunks.map(c => tokenize(c.title));
  const avg = tokens.reduce((s, t) => s + t.length, 0) / (tokens.length || 1);
  const df = new Map(terms.map(t => [t, tokens.filter((doc, i) => doc.includes(t) || titleTokens[i].includes(t)).length]));
  return chunks.map((chunk, i) => {
    let score = 0;
    for (const term of terms) {
      const freq = tokens[i].filter(t => t === term).length;
      const idf = Math.log(1 + (chunks.length - df.get(term)! + 0.5) / (df.get(term)! + 0.5));
      score += idf * (freq * 2.2) / (freq + 1.2 * (0.25 + 0.75 * tokens[i].length / (avg || 1)));
      if (titleTokens[i].includes(term)) score += idf * 2;
    }
    return { chunk, score };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score);
}
export function diversify<T extends { chunk: Chunk; score: number }>(sorted: T[], limit = 10): T[] {
  const chosen: T[] = [], deferred: T[] = [], counts = new Map<string, number>();
  for (const item of sorted) {
    const n = counts.get(item.chunk.documentId) ?? 0;
    if (n < 2) { chosen.push(item); counts.set(item.chunk.documentId, n + 1); } else deferred.push(item);
  }
  return [...chosen, ...deferred].slice(0, limit);
}
export function mergeEvidence(batches: Evidence[][], limit = 10) {
  const byId = new Map<string, Evidence>();
  for (const batch of batches) for (const item of batch) {
    const previous = byId.get(item.id);
    if (!previous || item.score > previous.score) byId.set(item.id, item);
  }
  const queues = new Map<string, Evidence[]>();
  for (const item of [...byId.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
    const queue = queues.get(item.documentId) ?? [];
    queue.push(item); queues.set(item.documentId, queue);
  }
  const documents = [...queues.keys()].sort((a, b) => (queues.get(b)![0].score - queues.get(a)![0].score) || a.localeCompare(b));
  const selected: Evidence[] = [];
  for (const documentId of documents) {
    const item = queues.get(documentId)!.shift();
    if (item) selected.push(item);
    if (selected.length >= limit) return selected;
  }
  for (let offset = 0; selected.length < limit; offset++) {
    let added = false;
    for (const documentId of documents) {
      const item = queues.get(documentId)!.shift();
      if (!item) continue;
      selected.push(item); added = true;
      if (selected.length >= limit) break;
    }
    if (!added || offset > limit) break;
  }
  return selected;
}

/** Keep lexical relevance on its own scale: partially embedded documents must not win merely by appearing in two rankings. */
export function rankCandidates(query: string, chunks: Chunk[], vector?: number[], model?: string) {
  const keyword = lexical(query, chunks);
  const top = keyword[0]?.score ?? 0;
  const lexicalScores = new Map(keyword.map(item => [item.chunk.id, top ? item.score / top : 0]));
  return chunks.map(chunk => {
    const textScore = lexicalScores.get(chunk.id) ?? 0;
    const semantic = vector && chunk.vector && chunk.embeddingModel === model ? cosine(vector, chunk.vector) : 0;
    // Explicit matches form the candidate set when present; semantic retrieval remains available for paraphrases with no lexical match.
    const eligible = top > 0 ? textScore >= .18 : semantic >= .45;
    return { chunk, score: eligible ? (top > 0 ? textScore + Math.max(0, semantic) * .08 : semantic) : 0 };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
}
export async function retrieve(store: Store, query: string, domain: string): Promise<Evidence[]> {
  const revision = await store.revision(domain);
  const key = 'lumina:retrieval:v3:' + createHash('sha256').update(JSON.stringify([store.cacheNamespace, domain, revision, query, config.KNOWLEDGE_ENABLED, config.EMBEDDING_MODEL, config.EMBEDDING_BASE_URL || config.LLM_BASE_URL, embeddingsEnabled()])).digest('hex');
  return cached(key, async () => {
    const chunks = await store.chunks(domain);
    if (!chunks.length) return [];
    const indexed = chunks.filter(c => c.vector && c.embeddingModel === config.EMBEDDING_MODEL);
    let vector: number[] | undefined;
    if (embeddingsEnabled() && indexed.length) {
      try { [vector] = await embed([query], { attempts: 1, timeoutMs: 12000 }); }
      catch { /* Text retrieval remains available during vector service failure. */ }
    }
    const ranked = rankCandidates(query, chunks, vector, config.EMBEDDING_MODEL);
    // Optional, bounded read of already validated evidence. Never invoke a worker
    // or a model here, and never admit passages that failed query relevance.
    if (config.KNOWLEDGE_ENABLED && store.knowledge && ranked.length) {
      try {
        const ids = [...new Set(ranked.slice(0, 10).map(item => item.chunk.documentId))];
        const relations = await store.knowledge.relations(domain, ids, true);
        const supported = new Set(relations.flatMap(relation => relation.evidence ? [relation.evidence.sourceChunk, relation.evidence.targetChunk] : []));
        for (const item of ranked) if (supported.has(item.chunk.id)) item.score *= 1.02;
        ranked.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
      } catch { /* Knowledge enrichment is optional; base retrieval stays available. */ }
    }
    return diversify(ranked).map(({ chunk, score }) => ({
      id: chunk.id, documentId: chunk.documentId, title: chunk.title, text: chunk.text, chunk: chunk.index + 1, page: chunk.page, score, sourceUrl: chunk.sourceUrl, capturedAt: chunk.capturedAt
    }));
  });
}
