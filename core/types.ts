export type Principal = { id: string; roles: string[]; domains: string[] };
export type Stage = { name: string; status: 'done' | 'failed'; detail: string; at: string };
export type DocumentRecord = {
  id: string; name: string; domain: string; hash: string; status: 'processing' | 'ready' | 'failed';
  createdAt: string; owner: string; size: number; chunks: number; stages: Stage[];
  error?: string; contentHash?: string; embeddingModel?: string; objectKey?: string;
  sourceUrl?: string; capturedAt?: string; webLinks?: string[];
};
export type Chunk = { id: string; documentId: string; domain: string; title: string; index: number; text: string; page?: number; vector?: number[]; embeddingModel?: string; sourceUrl?: string; capturedAt?: string };
export type Evidence = { id: string; documentId: string; title: string; text: string; chunk: number; page?: number; score: number; sourceUrl?: string; capturedAt?: string };
export type ComparativeFinding = { leftCitation: number; rightCitation: number; relation: string; condition: string; conclusion: string };
export type TraceStep = { name: string; detail: string; ms: number };
export type ConversationTurn = { question: string; answer: string };
export type MemoryState = 'candidate' | 'approved' | 'rejected' | 'revoked' | 'expired';
export type ResearchMemory = { id: string; owner: string; domain: string; question: string; answer: string; sourceIds: string[]; createdAt: string; state?: MemoryState; confidence?: number; sourceHashes?: string[]; approvedBy?: string; expiresAt?: string; updatedAt?: string };
export type ClaimReview = { text: string; citations: number[]; verdict: 'pass' | 'fail' | 'uncertain'; reason: string };
export type RunReview = { runId: string; verdict: 'pass' | 'fail' | 'uncertain'; coverage: number; claims: ClaimReview[]; reviewer: string; createdAt: string };
export type EvaluationResult = { runId: string; groundedness: number; citationValidity: number; reviewVerdict: RunReview['verdict'] | 'none'; feedback?: number; createdAt: string };
export type GovernedMemory = ResearchMemory & { state: MemoryState; confidence: number; sourceHashes: string[]; approvedBy?: string; expiresAt?: string; updatedAt: string };
export type Run = {
  id: string; owner: string; domain: string; conversationId?: string; createdAt: string; question: string; answer: string;
  sources: Evidence[]; steps: TraceStep[]; mode: 'extractive' | 'model'; status: 'completed' | 'abstained' | 'failed';
  durationMs: number; model?: string; inputTokens: number; outputTokens: number; feedback?: number; review?: RunReview; workflow?: string;
};
