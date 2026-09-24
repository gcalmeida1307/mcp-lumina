export type WebImportPage = { url: string; title?: string; documentId?: string; status: 'saved' | 'duplicate' | 'skipped' | 'failed'; detail?: string };
export type WebImportJob = {
  id: string; owner: string; domain: string; url: string; maxPages: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string; updatedAt: string; pages: WebImportPage[]; visited: number; error?: string;
};
