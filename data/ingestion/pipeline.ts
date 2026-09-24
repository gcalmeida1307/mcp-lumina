import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Store } from '../storage/database.js';
import { saveObject, deleteObject } from '../storage/objects.js';
import { extract } from './extract.js';
import { chunkText, normalize, repairMojibake } from '../processing/text.js';
import { embed } from '../../core/llmops/provider.js';
import { config, embeddingsEnabled } from '../../gateway/config.js';
import type { DocumentRecord } from '../../core/types.js';
import { MAX_UPLOAD_BYTES } from '../../core/ingestion-limits.js';
export const stageNames = ['Upload', 'Extração', 'Qualidade', 'Normalização', 'Enriquecimento', 'Indexação', 'Validação', 'Disponível'];
export class Ingestion {
  private tail = Promise.resolve();
  private pending = 0;
  private pendingBytes = 0;
  private embeddingQueue = new Map<string, DocumentRecord>();
  private embeddingWorker?: Promise<void>;
  private stopping = false;
  constructor(private store: Store) {}
  async enqueue(name: string, content: Buffer, domain: string, owner: string, source?: { sourceUrl: string; capturedAt: string; webLinks: string[] }) {
    if (content.length > MAX_UPLOAD_BYTES) throw new Error('O limite por arquivo é 50 MB.');
    if (this.pending >= 30 || this.pendingBytes + content.length > 200 * 1024 * 1024) throw new Error('Fila cheia. Aguarde a conclusão dos documentos.');
    const hash = createHash('sha256').update(source?.sourceUrl ?? '').update(content).digest('hex');
    const prior = (await this.store.documents(domain)).find(d => d.hash === hash);
    if (prior) return { document: prior, duplicate: true };
    const document: DocumentRecord = {
      id: randomUUID(), name: repairMojibake(basename(name.replace(/\\/g, '/'))).slice(0, 180), domain, owner, hash,
      status: 'processing', createdAt: new Date().toISOString(), size: content.length, chunks: 0, stages: [], ...source
    };
    await this.store.putDocument(document);
    await this.store.audit(owner, 'document.upload', document.id);
    this.pending++; this.pendingBytes += content.length;
    this.tail = this.tail.then(() => this.process(document, content)).catch(() => undefined).finally(() => { this.pending--; this.pendingBytes -= content.length; });
    return { document, duplicate: false };
  }
  async flushDocuments() { await this.tail; }
  async idle() { await this.tail; this.stopping = true; await this.embeddingWorker; }
  async resumeEmbeddings(domain?: string) {
    if (!embeddingsEnabled() || this.stopping) return 0;
    const documents = (await this.store.documents(domain)).filter(document => document.status === 'ready');
    for (const document of documents) this.embeddingQueue.set(document.id, document);
    this.startEmbeddingWorker();
    return documents.length;
  }
  private startEmbeddingWorker() {
    if (this.embeddingWorker || this.stopping) return;
    this.embeddingWorker = this.processEmbeddingQueue().finally(() => { this.embeddingWorker = undefined; });
  }
  private async process(d: DocumentRecord, content: Buffer) {
    let stage = 'Upload';
    const complete = async (name: string, detail: string) => {
      d.stages.push({ name, status: 'done', detail, at: new Date().toISOString() });
      await this.store.putDocument(d);
    };
    try {
      d.objectKey = await saveObject(d.id, content);
      await complete(stage, 'Arquivo recebido e armazenado.');
      stage = 'Extração';
      let text = (await extract(d.name, content)).text;
      const meaningfulText = text.replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '').replace(/\s+/g, ' ').trim();
      if (!meaningfulText) throw new Error('Sem texto extraível. Este PDF parece digitalizado e precisa de OCR antes de ser consultado.');
      await complete(stage, 'Texto extraído do arquivo.');
      stage = 'Qualidade';
      if (meaningfulText.length < 20) throw new Error('Texto insuficiente: mínimo de 20 caracteres úteis.');
      if (text.length > config.MAX_DOCUMENT_CHARS) throw new Error('Texto excede o limite de ' + config.MAX_DOCUMENT_CHARS.toLocaleString('pt-BR') + ' caracteres.');
      await complete(stage, 'Limites de tamanho e presença de texto verificados.');
      stage = 'Normalização'; text = normalize(text);
      await complete(stage, 'Espaços, quebras de linha e Unicode normalizados.');
      stage = 'Enriquecimento';
      const pieces = chunkText(text).map(piece => {
        const page = Number(piece.match(/\[\[LUMINA_PAGE:(\d+)\]\]/)?.[1]);
        return { text: piece.replace(/\[\[LUMINA_PAGE:\d+\]\]\n?/g, '').trim(), page: Number.isInteger(page) && page > 0 ? page : undefined };
      });
      if (pieces.length > config.MAX_DOCUMENT_CHUNKS) throw new Error('Documento excede ' + config.MAX_DOCUMENT_CHUNKS.toLocaleString('pt-BR') + ' trechos.');
      await complete(stage, 'Metadados de domínio, hash, origem e ' + pieces.length + ' trechos.');
      stage = 'Indexação';
      // Chunks are inserted immediately without waiting for embeddings, so the document
      // stays fast to publish; semantic vectors are filled in afterwards in the background.
      for (let i = 0; i < pieces.length; i++) {
        await this.store.addChunk({ id: d.id + ':' + i, documentId: d.id, domain: d.domain, title: d.name, index: i, text: pieces[i].text, page: pieces[i].page, sourceUrl: d.sourceUrl, capturedAt: d.capturedAt });
      }
      d.chunks = pieces.length;
      await complete(stage, embeddingsEnabled() ? 'Índice lexical disponível. Embeddings semânticos serão calculados em segundo plano.' : 'Índice lexical disponível. Embeddings não configurados.');
      stage = 'Validação';
      await complete(stage, 'Integridade dos trechos e metadados verificada.');
      stage = 'Disponível'; d.status = 'ready';
      await complete(stage, 'Documento liberado para consultas neste domínio.');
      await this.store.bump(d.domain);
      await this.store.audit(d.owner, 'document.ready', d.id);
      if (embeddingsEnabled()) { this.embeddingQueue.set(d.id, d); this.startEmbeddingWorker(); }
    } catch (error) {
      d.status = 'failed'; d.error = error instanceof Error ? error.message : 'Falha no processamento.';
      d.stages.push({ name: stage, status: 'failed', detail: d.error, at: new Date().toISOString() });
      await this.store.putDocument(d);
      await this.store.audit(d.owner, 'document.failed', d.id);
    }
  }
  private async processEmbeddingQueue() {
    // One request at a time, round-robin across documents. Progress survives restarts.
    while (this.embeddingQueue.size && !this.stopping) {
      const d = this.embeddingQueue.values().next().value!;
      this.embeddingQueue.delete(d.id);
      try {
        const missing = (await this.store.chunks(d.domain)).filter(chunk => chunk.documentId === d.id && (!chunk.vector?.length || chunk.embeddingModel !== config.EMBEDDING_MODEL));
        if (!missing.length) continue;
        const batch = missing.slice(0, config.EMBEDDING_BASE_URL ? 8 : 16);
        const vectors = await embed(batch.map(chunk => chunk.text), { attempts: 1 });
        for (let i = 0; i < vectors.length; i++) await this.store.updateChunkVector(batch[i].id, vectors[i], config.EMBEDDING_MODEL);
        await this.store.bump(d.domain);
        if (missing.length > batch.length && vectors.length) this.embeddingQueue.set(d.id, d);
      } catch (error) {
        console.error(JSON.stringify({ event: 'embedding.background.failed', documentId: d.id, type: error instanceof Error ? error.name : 'Error' }));
      }
    }
  }
  async remove(id: string, domain: string, actor: string) {
    const document = await this.store.document(id);
    if (!document || document.domain !== domain) throw new Error('Documento não encontrado.');
    if (document.status === 'processing') throw new Error('Aguarde o processamento para excluir.');
    if (document.objectKey) await deleteObject(document.objectKey);
    await this.store.deleteDocument(id, domain);
    await this.store.audit(actor, 'document.delete', id);
  }
}
