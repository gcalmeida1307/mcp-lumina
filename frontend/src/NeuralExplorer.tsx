import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { ArrowUpRight, Boxes, BrainCircuit, Focus, Hand, LoaderCircle, Minus, Plus, Search, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import './neural-explorer.css';

export type NeuralMap = { embedding: { enabled: boolean; model: string | null; backend: 'local' | 'cloud' | null; dimensions: number | null }; domains: { id: string; name: string; color: string; icon: string; documents: number; chunks: number; embeddedChunks: number }[] };
type View = { x: number; y: number; zoom: number };
const initialView: View = { x: 0, y: 0, zoom: 1 };
const number = (value: number) => value.toLocaleString('pt-BR');
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function NeuralExplorer({ data, error, onRetry, iconMap, onOpen }: { data?: NeuralMap; error: string; onRetry: () => void; iconMap: Record<string, LucideIcon>; onOpen: (id: string) => void }) {
  const [selectedId, setSelectedId] = useState<string>();
  const [hoveredId, setHoveredId] = useState<string>();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>(initialView);
  const [dragging, setDragging] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; view: View; moved: boolean } | undefined>(undefined);
  const domains = data?.domains ?? [];
  const selected = domains.find(item => item.id === selectedId);
  const matches = domains.filter(item => normalize(item.name).includes(normalize(query.trim())));
  const activeId = hoveredId ?? selectedId;
  const totals = domains.reduce((sum, item) => ({ documents: sum.documents + item.documents, chunks: sum.chunks + item.chunks, embeddedChunks: sum.embeddedChunks + item.embeddedChunks }), { documents: 0, chunks: 0, embeddedChunks: 0 });
  const stats = selected ?? totals;
  const coverage = stats.chunks ? Math.min(100, Math.round(stats.embeddedChunks / stats.chunks * 100)) : 0;
  const positions = domains.map((item, index) => {
    const angle = 2 * Math.PI * index / Math.max(domains.length, 1) - Math.PI / 2;
    return { ...item, x: 500 + Math.cos(angle) * 330, y: 320 + Math.sin(angle) * 228 };
  });
  function zoomBy(factor: number, x = 500, y = 320) {
    setView(current => {
      const zoom = Math.max(.6, Math.min(2.4, current.zoom * factor));
      return { zoom, x: x - (x - current.x) * zoom / current.zoom, y: y - (y - current.y) * zoom / current.zoom };
    });
  }
  function point(clientX: number, clientY: number) {
    const bounds = viewport.current!.getBoundingClientRect();
    const scale = Math.min(bounds.width / 1000, bounds.height / 640);
    return { x: (clientX - bounds.left - (bounds.width - 1000 * scale) / 2) / scale, y: (clientY - bounds.top - (bounds.height - 640 * scale) / 2) / scale };
  }
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const anchor = point(event.clientX, event.clientY);
      zoomBy(Math.exp(-event.deltaY * .005), anchor.x, anchor.y);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [domains.length > 0]);
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as Element).closest('[data-node]') || drag.current) return;
    const start = point(event.clientX, event.clientY);
    drag.current = { id: event.pointerId, ...start, view, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const next = point(event.clientX, event.clientY);
    if (Math.hypot(next.x - start.x, next.y - start.y) > 4) start.moved = true;
    if (start.moved) {
      setDragging(true);
      setView({ ...start.view, x: start.view.x + next.x - start.x, y: start.view.y + next.y - start.y });
    }
  }
  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  if (!data) return <div className="ne-state" role="status">{error ? <><BrainCircuit size={32} /><h3>Não foi possível carregar o mapa</h3><p>{error}</p><button className="button secondary" onClick={onRetry}>Tentar novamente</button></> : <><LoaderCircle className="spin" size={28} /><p>Organizando o conhecimento institucional…</p></>}</div>;
  if (!domains.length) return <div className="ne-state"><Boxes size={32} /><h3>Nenhum módulo disponível</h3><p>Os módulos disponíveis para seu acesso aparecerão aqui.</p></div>;

  return <section className="ne-explorer" aria-label="Explorador de conhecimento">
    <header className="ne-toolbar"><div><span className="ne-live" /><strong>Rede institucional</strong><span className="ne-count">{domains.length} módulos</span></div><label className="ne-search"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar módulo…" aria-label="Buscar módulo" />{query && <button aria-label="Limpar busca" onClick={() => setQuery('')}><X size={14} /></button>}</label></header>
    <div className="ne-layout"><div className="ne-map-area">
      <div className="ne-map-caption"><span>MAPA DE CONHECIMENTO</span><p>Selecione um módulo para inspecionar</p></div>
      <div ref={viewport} className={'ne-viewport' + (dragging ? ' is-dragging' : '')} tabIndex={0} role="group" aria-label="Mapa interativo. Arraste para mover. Use mais e menos para zoom, zero para centralizar e Escape para limpar a seleção."
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { drag.current = undefined; setDragging(false); }}
        onKeyDown={event => {
          if (event.key === 'Escape') { setSelectedId(undefined); setHoveredId(undefined); }
          if (['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            if (event.key === '+' || event.key === '=') zoomBy(1.2);
            else if (event.key === '-') zoomBy(1 / 1.2);
            else if (event.key === '0') setView(initialView);
            else setView(current => ({ ...current, x: current.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0), y: current.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0) }));
          }
        }}>
        <svg viewBox="0 0 1000 640" aria-label="Módulos conectados ao núcleo LUMINA">
          <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
            <circle className="ne-orbit" cx="500" cy="320" r="150" /><ellipse className="ne-orbit" cx="500" cy="320" rx="330" ry="228" />
            {positions.map(item => <path key={item.id} className={'ne-edge' + (activeId === item.id ? ' is-active' : '')} style={{ stroke: item.color, opacity: activeId && activeId !== item.id ? .12 : undefined }} d={`M500 320 Q${item.x} 320 ${item.x} ${item.y}`} />)}
            <g className="ne-core" transform="translate(500 320)"><circle r="63" /><circle className="ne-core-inner" r="50" /><BrainCircuit x={-21} y={-26} size={42} /><text y="36">LUMINA</text><text className="ne-core-label" y="88">Conhecimento institucional</text></g>
            {positions.map(item => { const Icon = iconMap[item.icon] ?? Boxes; const match = matches.some(result => result.id === item.id); return <g key={item.id} data-node="true" className={'ne-node' + (selectedId === item.id ? ' is-selected' : '') + (!match ? ' is-muted' : '')} transform={`translate(${item.x} ${item.y})`} style={{ '--node-color': item.color } as CSSProperties} role="button" tabIndex={match ? 0 : -1} aria-label={`${item.name}, ${item.documents} documentos. Inspecionar módulo`} aria-pressed={selectedId === item.id} onClick={() => setSelectedId(item.id)} onMouseEnter={() => setHoveredId(item.id)} onMouseLeave={() => setHoveredId(undefined)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(item.id); } }}>
              <title>{`${item.name} · ${number(item.documents)} documentos · ${number(item.embeddedChunks)} trechos vetorizados`}</title><rect x="-100" y="-39" width="200" height="91" rx="16" className="ne-node-surface" /><circle cx="-68" cy="-6" r="18" /><Icon x={-78} y={-16} size={20} /><text x="-38" y="-1">{item.name.length > 18 ? item.name.slice(0, 17) + '…' : item.name}</text><text className="ne-node-meta" x="-78" y="30">{number(item.documents)} documentos</text><circle className="ne-node-dot" cx="78" cy="27" r="3" />
            </g>; })}
          </g>
        </svg>
      </div>
      {!matches.length && <div className="ne-no-match" role="status">Nenhum módulo encontrado para “{query}”.</div>}
      <div className="ne-map-bottom"><span><Hand size={14} /> Arraste para mover <span className="ne-wheel-hint">· Ctrl + rolagem para zoom</span></span><div className="ne-controls"><button aria-label="Diminuir zoom" title="Diminuir zoom (−)" disabled={view.zoom <= .6} onClick={() => zoomBy(1 / 1.2)}><Minus size={16} /></button><output aria-label="Nível de zoom">{Math.round(view.zoom * 100)}%</output><button aria-label="Aumentar zoom" title="Aumentar zoom (+)" disabled={view.zoom >= 2.4} onClick={() => zoomBy(1.2)}><Plus size={16} /></button><span /><button aria-label="Centralizar mapa" title="Centralizar mapa (0)" onClick={() => setView(initialView)}><Focus size={17} /></button></div></div>
    </div>
    <aside className="ne-inspector" aria-label="Detalhes do conhecimento">
      <div className="ne-inspector-heading"><span>{selected ? 'MÓDULO SELECIONADO' : 'VISÃO GERAL'}</span>{selected && <button className="icon-button" aria-label="Limpar seleção" onClick={() => setSelectedId(undefined)}><X size={16} /></button>}</div>
      <div aria-live="polite"><h2>{selected?.name ?? 'Seu conhecimento, conectado.'}</h2><p className="ne-description">{selected ? 'Conteúdo disponível neste módulo da organização.' : 'Explore os módulos e acompanhe a preparação do conteúdo para consultas.'}</p></div>
      <div className="ne-metrics"><div><strong>{number(stats.documents)}</strong><span>Documentos</span></div><div><strong>{number(stats.chunks)}</strong><span>Trechos de conteúdo</span></div></div>
      <div className="ne-coverage"><div><span>Cobertura vetorial</span><strong>{coverage}%</strong></div><progress max="100" value={coverage} aria-label="Cobertura vetorial" /><p>{number(stats.embeddedChunks)} de {number(stats.chunks)} trechos vetorizados</p></div>
      {selected && <button className="button primary ne-open" onClick={() => onOpen(selected.id)}>Abrir base de conhecimento <ArrowUpRight size={15} /></button>}
      <div className="ne-modules-heading"><h3>Explorar módulos</h3><span>{matches.length}</span></div>
      <div className="ne-module-list">{matches.map(item => { const Icon = iconMap[item.icon] ?? Boxes; return <button key={item.id} className={selectedId === item.id ? 'is-selected' : ''} aria-pressed={selectedId === item.id} onClick={() => setSelectedId(item.id)} onMouseEnter={() => setHoveredId(item.id)} onMouseLeave={() => setHoveredId(undefined)}><Icon size={17} style={{ color: item.color }} /><span>{item.name}<small>{number(item.documents)} documentos</small></span><ArrowUpRight size={14} /></button>; })}{!matches.length && <p className="ne-description">Tente buscar outro nome.</p>}</div>
      <p className="ne-footnote">As linhas representam a organização por módulo. Similaridades entre documentos ainda não são exibidas.</p>
    </aside></div>
    <footer className="ne-status"><span><span className={'ne-status-dot' + (data.embedding.enabled ? ' enabled' : '')} />{data.embedding.enabled ? 'Embeddings habilitados' : 'Embeddings desabilitados'}</span><span>Selecione pelo mapa ou pela lista de módulos</span></footer>
  </section>;
}
