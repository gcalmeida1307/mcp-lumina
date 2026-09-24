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
  const key = 'lumina:retrieval:v2:' + createHash('sha256').update(JSON.stringify([store.cacheNamespace, domain, revision, query, config.EMBEDDING_MODEL, config.EMBEDDING_BASE_URL || config.LLM_BASE_URL, embeddingsEnabled()])).digest('hex');
  return cached(key, async () => {
    const chunks = await store.chunks(domain);
    if (!chunks.length) return [];
    const indexed = chunks.filter(c => c.vector && c.embeddingModel === config.EMBEDDING_MODEL);
    let vector: number[] | undefined;
    if (embeddingsEnabled() && indexed.length) {
      try { [vector] = await embed([query], { attempts: 1, timeoutMs: 12000 }); }
      catch { /* Text retrieval remains available during vector service failure. */ }
    }
    return diversify(rankCandidates(query, chunks, vector, config.EMBEDDING_MODEL)).map(({ chunk, score }) => ({
      id: chunk.id, documentId: chunk.documentId, title: chunk.title, text: chunk.text, chunk: chunk.index + 1, score, sourceUrl: chunk.sourceUrl, capturedAt: chunk.capturedAt
    }));
  });
}
