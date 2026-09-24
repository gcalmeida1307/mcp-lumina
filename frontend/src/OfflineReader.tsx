import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, X, LoaderCircle } from 'lucide-react';
import { api } from './api';
import type { DocumentPassages } from '../../core/knowledge/types';
export function OfflineReader({ id, domain, onClose }: { id: string; domain: string; onClose: () => void }) {
  const [documentId, setDocumentId] = useState(id), [offset, setOffset] = useState(0);
  const [data, setData] = useState<DocumentPassages>(), [error, setError] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController(); setData(undefined); setError('');
    void api<DocumentPassages>(`/neural-map/documents/${encodeURIComponent(documentId)}/passages?domain=${encodeURIComponent(domain)}&offset=${offset}&limit=24`, { signal: controller.signal }).then(setData).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [documentId, domain, offset]);
  return <div className="modal-backdrop" onClick={onClose}><section className="modal" role="dialog" aria-modal="true" aria-label="Cópia offline" onClick={event => event.stopPropagation()}><div className="panel-heading"><div><h3>{data?.document.name ?? 'Cópia offline'}</h3><p>Conteúdo salvo na base de conhecimento</p></div><button className="icon-button" aria-label="Fechar cópia offline" onClick={onClose}><X size={20} /></button></div>
    {error ? <p role="alert">{error}</p> : !data ? <LoaderCircle className="spin" /> : <><div className="web-origin">{data.document.sourceUrl && <a href={data.document.sourceUrl} target="_blank" rel="noopener noreferrer">Abrir origem na web</a>}{data.document.capturedAt && <small>Capturado em {new Date(data.document.capturedAt).toLocaleString('pt-BR')}</small>}</div><div className="web-offline">{data.passages.map(passage => <p key={passage.id}>{passage.text}</p>)}</div>
    <div className="web-reader-nav"><button className="icon-button" aria-label="Trechos anteriores" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 24))}><ArrowLeft size={16} /></button><span>{offset + 1}–{Math.min(offset + 24, data.total)} de {data.total} trechos</span><button className="icon-button" aria-label="Próximos trechos" disabled={offset + 24 >= data.total} onClick={() => setOffset(value => value + 24)}><ArrowRight size={16} /></button></div>
    <div className="web-reader-nav">{history.length > 0 && <button className="text-button" onClick={() => { setDocumentId(history.at(-1)!); setHistory(items => items.slice(0, -1)); setOffset(0); }}>Voltar à página anterior</button>}</div><div className="web-jobs"><ul>{data.linkedDocuments?.map(item => <li key={item.id}><button className="text-button" onClick={() => { setHistory(items => [...items, documentId]); setDocumentId(item.id); setOffset(0); }}>{item.name} <ArrowRight size={14} /></button></li>)}</ul></div></>}
  </section></div>;
}
