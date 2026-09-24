import { useEffect, useRef, useState } from 'react';
import { Globe2, LoaderCircle, Square, ArrowUpRight, RefreshCw, Trash2 } from 'lucide-react';
import { api } from './api';
import type { WebImportJob } from '../../core/web-import';
import { MAX_WEB_PAGES } from '../../core/ingestion-limits';
import './web-sources.css';

const labels: Record<WebImportJob['status'], string> = { queued: 'Na fila', running: 'Importando', completed: 'Concluída', failed: 'Falhou', cancelled: 'Cancelada', interrupted: 'Interrompida' };
export function WebSources({ domain, allowed, onChange, onOpen }: { domain: string; allowed: boolean; onChange: () => void; onOpen: (id: string) => void }) {
  const [url, setUrl] = useState(''), [maxPages, setMaxPages] = useState(MAX_WEB_PAGES);
  const [jobs, setJobs] = useState<WebImportJob[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const callbacks = useRef({ onChange }); callbacks.current = { onChange };
  const scope = useRef(domain); scope.current = domain;
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, previous = '';
    const controller = new AbortController();
    setJobs([]); setError('');
    async function poll() {
      try {
        const result = await api<WebImportJob[]>('/web-imports?domain=' + encodeURIComponent(domain), { signal: controller.signal });
        if (stopped) return;
        setJobs(result);
        const signature = result.map(job => job.updatedAt).join('|');
        if (signature !== previous) { previous = signature; callbacks.current.onChange(); }
        if (result.some(job => ['running', 'queued'].includes(job.status))) timer = setTimeout(() => void poll(), 2500);
      } catch (error) { if (!stopped) setError(error instanceof Error ? error.message : 'Não foi possível carregar as importações.'); }
    }
    void poll(); return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [domain, reload]);
  async function start(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(''); const current = domain;
    try {
      await api('/web-imports', { method: 'POST', body: JSON.stringify({ url, domain, maxPages }) });
      if (scope.current === current) { setUrl(''); setReload(value => value + 1); }
    } catch (error) { if (scope.current === current) setError(error instanceof Error ? error.message : 'Não foi possível iniciar.'); }
    finally { setBusy(false); }
  }
  async function cancel(id: string) {
    try { await api(`/web-imports/${id}/cancel`, { method: 'POST', body: JSON.stringify({ domain }) }); setReload(value => value + 1); }
    catch (error) { setError(error instanceof Error ? error.message : 'Falha ao cancelar.'); }
  }
  async function retry(id: string) {
    try { await api(`/web-imports/${id}/retry`, { method: 'POST', body: JSON.stringify({ domain }) }); setReload(value => value + 1); }
    catch (error) { setError(error instanceof Error ? error.message : 'Falha ao repetir.'); }
  }
  async function remove(id: string) {
    try { await api(`/web-imports/${id}`, { method: 'DELETE', body: JSON.stringify({ domain }) }); setReload(value => value + 1); }
    catch (error) { setError(error instanceof Error ? error.message : 'Falha ao remover.'); }
  }
  const running = jobs.some(job => ['queued', 'running'].includes(job.status));
  return <section className="web-sources" aria-label="Fontes da web">
    <div className="web-heading"><Globe2 size={22} /><div><h3>Transforme sites em conhecimento</h3><p>Salve até 25 páginas como documentos offline neste módulo.</p></div></div>
    {allowed && <form className="web-import-form" onSubmit={event => void start(event)}><label>URL inicial<input type="url" required maxLength={2048} placeholder="https://site.com.br/artigo" value={url} onChange={event => setUrl(event.target.value)} disabled={busy || running} /></label><label>Páginas<input type="number" min={1} max={MAX_WEB_PAGES} required value={maxPages} onChange={event => setMaxPages(Number(event.target.value))} disabled={busy || running} /></label><button className="button primary" disabled={busy || running || !url}>{busy ? <LoaderCircle className="spin" size={15} /> : <Globe2 size={15} />}Importar site</button></form>}
    <p className="web-hint">A partir do link informado, seguimos páginas HTML do mesmo site (mesmo endereço e protocolo), sem login. Cada cópia preserva a origem e a data de captura. Sites que exigem JavaScript podem não fornecer texto.</p>
    {error && <p className="web-error" role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Atualizar</button></p>}
    <div className="web-jobs">{jobs.map(job => <details key={job.id} open={['queued', 'running'].includes(job.status) || undefined}><summary><span>{job.url}<small>{labels[job.status]} · {job.pages.filter(page => ['saved', 'duplicate'].includes(page.status)).length} páginas disponíveis · {job.visited}/{job.maxPages} visitadas</small></span>{['queued', 'running'].includes(job.status) && <LoaderCircle className="spin" size={16} />}</summary>
      {['queued', 'running'].includes(job.status) && <><progress max={job.maxPages} value={job.visited} aria-label="Páginas visitadas" />{allowed && <button type="button" className="button secondary" onClick={() => void cancel(job.id)}><Square size={13} />Cancelar importação</button>}</>}
      {job.error && <p className="web-error">{job.error}{/certificate|first certificate|system-ca/i.test(job.error) && <small>Reinicie a API com <code>npm run dev:api</code> para aplicar a confiança de certificados do sistema.</small>}</p>}
      {allowed && ['failed', 'cancelled', 'interrupted'].includes(job.status) && <div className="web-job-actions"><button type="button" className="button secondary" onClick={() => void retry(job.id)}><RefreshCw size={13} />Tentar novamente</button><button type="button" className="button ghost" onClick={() => void remove(job.id)}><Trash2 size={13} />Remover</button></div>}
      <ul>{job.pages.map((page, i) => <li key={i}><span>{page.title ?? page.url}<small>{page.status === 'saved' ? 'Salva para consulta offline' : page.status === 'duplicate' ? 'Já disponível na base' : page.detail}</small></span>{page.documentId && <button type="button" className="text-button" onClick={() => onOpen(page.documentId!)}>Ler cópia <ArrowUpRight size={13} /></button>}</li>)}</ul>
    </details>)}</div>
  </section>;
}
