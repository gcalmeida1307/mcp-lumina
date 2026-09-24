export type Principal = { id: string; roles: string[]; domains: string[] };
export type Stage = { name: string; status: 'done' | 'failed'; detail: string; at: string };
export type DocumentRecord = {
  id: string; name: string; domain: string; hash: string; status: 'processing' | 'ready' | 'failed';
  createdAt: string; owner: string; size: number; chunks: number; stages: Stage[];
  error?: string; embeddingModel?: string; objectKey?: string;
  sourceUrl?: string; capturedAt?: string; webLinks?: string[];
};
export type Chunk = { id: string; documentId: string; domain: string; title: string; index: number; text: string; vector?: number[]; embeddingModel?: string; sourceUrl?: string; capturedAt?: string };
export type Evidence = { id: string; documentId: string; title: string; text: string; chunk: number; score: number; sourceUrl?: string; capturedAt?: string };
export type TraceStep = { name: string; detail: string; ms: number };
export type ConversationTurn = { question: string; answer: string };
export type Run = {
  id: string; owner: string; domain: string; conversationId?: string; createdAt: string; question: string; answer: string;
  sources: Evidence[]; steps: TraceStep[]; mode: 'extractive' | 'model'; status: 'completed' | 'abstained' | 'failed';
  durationMs: number; model?: string; inputTokens: number; outputTokens: number; feedback?: number;
};
