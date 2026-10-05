import type { Chunk, DocumentRecord } from '../types.js';
import { canonicalizeConfusables } from '../../data/processing/text.js';

const normalize = (text: string) => canonicalizeConfusables(text).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const stem = (name: string) => normalize(name.replace(/\.[a-z0-9]+$/i, ''));
const generic = new Set(['documento', 'arquivo', 'relatorio', 'contrato', 'manual', 'livro', 'codigo']);
function alias(document: Pick<DocumentRecord, 'name'>) {
  const first = stem(document.name).split(' ')[0];
  return first.length >= 4 && !generic.has(first) ? first : undefined;
}
export function mentionedDocuments(question: string, documents: DocumentRecord[]) {
  const text = ' ' + normalize(question) + ' ';
  return documents.filter(document => {
    const short = alias(document);
    return text.includes(' ' + stem(document.name) + ' ') || Boolean(short &&
      documents.filter(other => alias(other) === short).length === 1 && text.includes(' ' + short + ' '));
  });
}

// File references choose the corpus; they must not give every passage in a file a relevance bonus.
export function contentQuery(question: string, documents: DocumentRecord[]) {
  let text = ' ' + normalize(question) + ' ';
  for (const document of [...documents].sort((a, b) => b.name.length - a.name.length)) {
    text = text.replaceAll(' ' + normalize(document.name) + ' ', ' ');
    text = text.replaceAll(' ' + stem(document.name) + ' ', ' ');
    const short = alias(document);
    if (short && documents.filter(other => alias(other) === short).length === 1) text = text.replaceAll(' ' + short + ' ', ' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

// Read bounded source excerpts before planning an open comparison. Do not pretend this is a complete review of large books.
export function planningExcerpts(documents: DocumentRecord[], chunks: Chunk[]) {
  return documents.slice(0, 4).map(document => {
    const parts = chunks.filter(chunk => chunk.documentId === document.id).sort((a,b) => a.index - b.index);
    const selected = parts.length <= 24 ? parts : parts.filter((_, index) => index % Math.ceil(parts.length / 8) === 0).slice(0, 8);
    return { document: document.name, partial: true, passages: selected.map(chunk => ({ passage: chunk.index + 1, page: chunk.page, text: chunk.text.slice(0, parts.length <= 24 ? 1600 : 700) })) };
  });
}
