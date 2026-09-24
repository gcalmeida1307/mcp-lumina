import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Controls, Handle, MiniMap, Position, ReactFlow, applyNodeChanges } from '@xyflow/react';
import type { Edge, Node, NodeProps, ReactFlowInstance, Viewport } from '@xyflow/react';
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Boxes, BrainCircuit, ChevronRight, FileText, Focus, Layers3, List, LoaderCircle, Maximize2, Minimize2, Network, RefreshCw, Search, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from './api';
import type { DocumentPassages, DomainGraph, NeuralMap } from '../../core/knowledge/types';
import '@xyflow/react/dist/style.css';
import './knowledge-explorer.css';
import './constellation.css';
import { orbitPosition, corePosition } from './constellation-layout';
export type { NeuralMap } from '../../core/knowledge/types';

type GraphData = { label: string; subtitle: string; caption: string; color: string; kind: 'core' | 'domain' | 'document' | 'passage'; icon: LucideIcon; refId: string; progress?: number; orbital?: boolean; centered?: boolean };
type KnowledgeNode = Node<GraphData, 'knowledge'>;
type Location = { domain?: string; document?: string; title?: string };
const count = (value: number) => value.toLocaleString('pt-BR');
const normalize = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const PAGE_SIZE = 12;
function KnowledgeCard({ data, selected }: NodeProps<KnowledgeNode>) {
  const Icon = data.icon;
  if (data.orbital) return <div className={`kg-star kg-star-${data.kind}${data.centered ? ' kg-star-center' : ''}${selected ? ' selected' : ''}`} style={{ '--node-color': data.color } as CSSProperties}>
    <Handle type="target" position={Position.Top} /><Handle type="source" position={Position.Bottom} />
    <span className="kg-star-orb">{data.centered && <Icon size={32} />}</span>
    <strong title={data.label}>{data.label}</strong><small title={data.subtitle}>{data.subtitle}</small>
  </div>;
  return <div className={`kg-node kg-node-${data.kind}${selected ? ' selected' : ''}`} style={{ '--node-color': data.color } as CSSProperties}>
    <Handle type="target" position={Position.Left} /><Handle type="source" position={Position.Right} />
    <div className="kg-node-top"><span><Icon size={19} /></span><small>{data.caption}</small>{data.kind !== 'passage' && <ChevronRight size={14} />}</div>
    <strong title={data.label}>{data.label}</strong><p>{data.subtitle}</p>
    {data.progress !== undefined && <div className="kg-node-progress"><i style={{ width: `${data.progress}%` }} /></div>}
  </div>;
}
const nodeTypes = { knowledge: KnowledgeCard };

export function NeuralExplorer({ data, error, onRetry, iconMap, onOpen, canReindex = false }: { data?: NeuralMap; error: string; onRetry: () => void; iconMap: Record<string, LucideIcon>; onOpen: (id: string) => void; canReindex?: boolean }) {
  const [location, setLocation] = useState<Location>({});
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<DomainGraph>();
  const [passages, setPassages] = useState<DocumentPassages>();
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [mode, setMode] = useState<'graph' | 'list'>('graph');
  const [showInspector, setShowInspector] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [showRelations, setShowRelations] = useState(true);
  const [hovered, setHovered] = useState<string>();
  const [reindexing, setReindexing] = useState(false);
  const [indexNotice, setIndexNotice] = useState('');
  const flow = useRef<ReactFlowInstance<KnowledgeNode, Edge> | null>(null);
  const views = useRef(new Map<string, Viewport>());
  const panel = useRef<HTMLElement>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const domain = data?.domains.find(item => item.id === location.domain);
  const scope = `${location.domain ?? 'all'}/${location.document ?? ''}/${offset}/${debouncedQuery}`;
  const duration = reducedMotion ? 0 : 240;
  useEffect(() => { const media = window.matchMedia('(prefers-reduced-motion: reduce)'); const update = () => setReducedMotion(media.matches); update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  useEffect(() => { const timeout = setTimeout(() => { setDebouncedQuery(query); setOffset(0); }, 250); return () => clearTimeout(timeout); }, [query]);
  useEffect(() => {
    if (!location.domain) return;
    const controller = new AbortController();
    setBusy(true); setLoadError(''); setDetail(undefined); setPassages(undefined);
    const params = new URLSearchParams({ domain: location.domain, offset: String(offset), limit: String(PAGE_SIZE), q: debouncedQuery });
    const path = location.document ? `/neural-map/documents/${encodeURIComponent(location.document)}/passages?${params}` : `/neural-map/documents?${params}`;
    void api<DomainGraph | DocumentPassages>(path, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      if ('passages' in result) setPassages(result); else setDetail(result);
    }).catch(reason => { if (!controller.signal.aborted) setLoadError(reason.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [location.domain, location.document, offset, debouncedQuery, reload]);
  useEffect(() => { if (!expanded) return; const old = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = old; }; }, [expanded]);
  function go(next: Location) {
    setIndexNotice('');
    setLocation(next); setQuery(''); setDebouncedQuery(''); setOffset(0); setSelected(undefined); setHovered(undefined); setLoadError('');
    setDetail(undefined); setPassages(undefined); setBusy(Boolean(next.domain));
  }
  const visibleDomains = data?.domains.filter(item => normalize(item.name).includes(normalize(query))) ?? [];
  const graph = useMemo(() => {
    const nodes: KnowledgeNode[] = [], edges: Edge[] = [];
    const add = (id: string, x: number, y: number, item: GraphData) => nodes.push({ id, type: 'knowledge', position: { x, y }, data: item, ariaLabel: `${item.label}. ${item.subtitle}. ${item.kind === 'passage' ? 'Ler trecho' : 'Explorar'}`, focusable: true });
    const link = (source: string, target: string) => edges.push({ id: `${source}-${target}`, source, target, type: 'straight', style: { stroke: domain?.color ?? '#ad81ff', strokeWidth: 1, opacity: .3 }, selectable: false });
    const center = (item: GraphData) => add('core', corePosition.x, corePosition.y, { ...item, orbital: true, centered: true });
    const orbit = (id: string, index: number, total: number, item: GraphData) => {
      const position = orbitPosition(index, total);
      add(id, position.x, position.y, { ...item, orbital: true }); link('core', id);
    };
    if (!location.domain) {
      const items = (data?.domains ?? []).filter(item => normalize(item.name).includes(normalize(query)));
      center({ label: 'LUMINA CORE', subtitle: `${items.length} módulos de conhecimento`, caption: 'REDE INSTITUCIONAL', color: '#ad81ff', kind: 'core', icon: BrainCircuit, refId: '' });
      items.forEach((item, i) => {
        orbit(item.id, i, items.length, { label: item.name, subtitle: `${count(item.documents)} documentos · ${count(item.chunks)} trechos`, caption: 'MÓDULO', color: item.color, kind: 'domain', icon: iconMap[item.icon] ?? Boxes, refId: item.id });
      });
    } else if (location.document && passages) {
      center({ label: passages.document.name, subtitle: `${count(passages.document.chunks)} trechos no documento`, caption: 'DOCUMENTO', color: domain?.color ?? '#ad81ff', kind: 'document', icon: FileText, refId: passages.document.id });
      passages.passages.forEach((item, i) => orbit(item.id, i, passages.passages.length, { label: `Trecho ${item.index + 1}`, subtitle: item.text.slice(0, 95), caption: item.embedded ? 'VETORIZADO' : 'TEXTO INDEXADO', color: domain?.color ?? '#ad81ff', kind: 'passage', icon: BookOpen, refId: item.id }));
    } else if (detail && domain) {
      center({ label: domain.name, subtitle: `${count(detail.total)} documentos encontrados`, caption: 'MÓDULO', color: domain.color, kind: 'domain', icon: iconMap[domain.icon] ?? Boxes, refId: domain.id });
      detail.documents.forEach((item, i) => orbit(item.id, i, detail.documents.length, { label: item.name, subtitle: `${count(item.chunks)} trechos · ${count(item.embeddedChunks)} vetorizados`, caption: 'DOCUMENTO', color: domain.color, kind: 'document', icon: FileText, refId: item.id }));
      if (showRelations) detail.relations.forEach(item => edges.push({ id: `relation-${item.source}-${item.target}`, source: item.source, target: item.target, type: 'bezier', label: `${Math.round(item.score * 100)}%`, data: item, ariaLabel: `${item.method === 'semantic' ? 'Similaridade vetorial' : 'Termos em comum'}: ${Math.round(item.score * 100)} por cento`, style: { stroke: item.method === 'semantic' ? '#74d9c1' : '#d3ad70', strokeWidth: 1.5, strokeDasharray: item.method === 'lexical' ? '5 5' : undefined }, labelStyle: { fill: '#c9d7ed', fontSize: 10 }, labelBgStyle: { fill: '#18243b' } }));
    }
    return { nodes, edges };
  }, [data, location, detail, passages, query, iconMap, domain, showRelations]);
  const [nodes, setNodes] = useState<KnowledgeNode[]>([]);
  useEffect(() => setNodes(graph.nodes), [graph.nodes]);
  const selectedPassage = passages?.passages.find(item => item.id === selected);
  const displayEdges = graph.edges.map(edge => ({ ...edge, style: { ...edge.style, opacity: hovered ? (edge.source !== hovered && edge.target !== hovered ? .08 : 1) : edge.style?.opacity ?? 1 } }));
  const total = location.document ? passages?.total ?? 0 : location.domain ? detail?.total ?? 0 : visibleDomains.length;
  const items = nodes.filter(node => !node.data.centered);
  function activate(node: KnowledgeNode) {
    if (node.id === 'core') return;
    if (node.data.kind === 'domain') { if (!location.domain) go({ domain: node.data.refId }); }
    else if (node.data.kind === 'document') { if (!location.document) go({ domain: location.domain, document: node.data.refId, title: node.data.label }); }
    else { setShowInspector(true); setSelected(node.id); if (window.innerWidth < 1050) requestAnimationFrame(() => panel.current?.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'nearest' })); }
  }
  const loading = !data || Boolean(location.domain && busy);
  const currentError = data ? loadError : error;
  const title = location.document ? location.title : domain?.name ?? 'Conhecimento institucional';
  const retry = () => { if (location.domain) setReload(value => value + 1); else onRetry(); };
  const totals = data?.domains.reduce((sum, item) => ({ documents: sum.documents + item.documents, chunks: sum.chunks + item.chunks }), { documents: 0, chunks: 0 });
  async function resumeIndexing() {
    if (!domain || reindexing) return;
    setReindexing(true); setIndexNotice('');
    try { await api('/neural-map/reindex', { method: 'POST', body: JSON.stringify({ domain: domain.id }) }); setIndexNotice('Indexação retomada em segundo plano. A busca textual continua disponível.'); onRetry(); }
    catch (error) { setIndexNotice(error instanceof Error ? error.message : 'Não foi possível retomar a indexação.'); }
    finally { setReindexing(false); }
  }

  return <section className={`kg-explorer${expanded ? ' kg-expanded' : ''} kg-constellation${!showInspector ? ' kg-panel-hidden' : ''}`} aria-label="Explorador de conhecimento" onKeyDown={event => { if (event.key === 'Escape') { if (expanded) setExpanded(false); else setSelected(undefined); } }}>
    <header className="kg-header"><div className="kg-brand"><span><BrainCircuit size={22} /></span><div><strong>Constelação institucional</strong><small>Conhecimento com origem e contexto</small></div></div><div className="kg-header-actions"><button className="kg-panel-toggle" aria-expanded={showInspector} aria-controls="knowledge-inspector" onClick={() => setShowInspector(value => !value)}>{showInspector ? 'Ocultar painel' : 'Mostrar painel'}</button><span className="kg-badge">{count(totals?.documents ?? 0)} documentos</span><button className="kg-icon-button" onClick={() => { onRetry(); if (location.domain) setReload(value => value + 1); }} aria-label="Atualizar mapa" title="Atualizar dados"><RefreshCw size={16} /></button><button className="kg-icon-button" onClick={() => setExpanded(value => !value)} aria-label={expanded ? 'Sair da visualização ampliada' : 'Ampliar explorador'} title={expanded ? 'Restaurar tamanho' : 'Ampliar explorador'}>{expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button></div></header>
    <div className="kg-navigation"><nav aria-label="Caminho no conhecimento"><button disabled={!location.domain} className="kg-icon-button" aria-label="Voltar um nível" onClick={() => go(location.document ? { domain: location.domain } : {})}><ArrowLeft size={17} /></button><button onClick={() => go({})} aria-current={!location.domain ? 'page' : undefined}>Todos os módulos</button>{domain && <><ChevronRight size={13} /><button onClick={() => go({ domain: domain.id })} aria-current={!location.document ? 'page' : undefined}>{domain.name}</button></>}{location.document && <><ChevronRight size={13} /><span title={title} aria-current="page">{title}</span></>}</nav><div className="kg-view-switch" aria-label="Visualização"><button aria-pressed={mode === 'graph'} onClick={() => setMode('graph')}><Network size={14} />Constelação</button><button aria-pressed={mode === 'list'} onClick={() => setMode('list')}><List size={14} />Lista</button></div></div>
    <div className="kg-workspace"><div className="kg-main"><div className="kg-filterbar"><label className="kg-search"><Search size={16} /><input aria-label="Buscar no nível atual" value={query} onChange={event => setQuery(event.target.value)} placeholder={location.document ? 'Buscar no conteúdo dos trechos…' : location.domain ? 'Buscar nome ou conteúdo neste módulo…' : 'Buscar módulo de conhecimento…'} />{query && <button aria-label="Limpar busca" onClick={() => setQuery('')}><X size={14} /></button>}</label>{location.domain && !location.document && <label className="kg-toggle"><input type="checkbox" checked={showRelations} onChange={event => setShowRelations(event.target.checked)} />Relações</label>}</div>
      <div className="kg-canvas-wrap">
      {currentError ? <div className="kg-state" role="alert"><Network size={30} /><h3>Não foi possível abrir este conhecimento</h3><p>{currentError}</p><button className="button secondary" onClick={retry}>Tentar novamente</button></div> : loading ? <div className="kg-state" role="status"><LoaderCircle className="spin" size={28} /><h3>Carregando conhecimento…</h3><p>Preparando os dados e suas conexões.</p></div> : !total && (!location.domain || query || mode === 'list') ? <div className="kg-state"><Search size={30} /><h3>{query ? 'Nenhum resultado encontrado' : 'Este espaço ainda está vazio'}</h3><p>{query ? 'Experimente outro termo ou limpe a busca.' : 'Adicione documentos ao módulo para começar a explorar.'}</p>{query && <button className="button secondary" onClick={() => setQuery('')}>Limpar busca</button>}{domain && !query && <button className="button secondary" onClick={() => onOpen(domain.id)}>Abrir base de conhecimento</button>}</div> : mode === 'list' ? <div className="kg-results">{items.map(node => { const Icon = node.data.icon; return <button key={node.id} className={selected === node.id ? 'selected' : ''} onClick={() => activate(node)}><span style={{ color: node.data.color }}><Icon size={20} /></span><div><small>{node.data.caption}</small><strong>{node.data.label}</strong><p>{node.data.subtitle}</p></div><ChevronRight size={18} /></button>; })}</div> : <ReactFlow<KnowledgeNode, Edge> key={scope} nodes={nodes.map(node => ({ ...node, selected: selected === node.id }))} edges={displayEdges} nodeTypes={nodeTypes} onNodesChange={changes => setNodes(current => applyNodeChanges(changes, current))} onNodeClick={(_, node) => activate(node)} onNodeMouseEnter={(_, node) => setHovered(node.id)} onNodeMouseLeave={() => setHovered(undefined)} onPaneClick={() => setSelected(undefined)} onInit={instance => { flow.current = instance; }} onMoveEnd={(_, view) => views.current.set(scope, view)} defaultViewport={views.current.get(scope)} fitView={!views.current.has(scope)} fitViewOptions={{ padding: .15, maxZoom: 1 }} minZoom={.25} maxZoom={2} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} selectionOnDrag={false} zoomOnDoubleClick={false} colorMode="dark" ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': 'Aproximar', 'controls.zoomOut.ariaLabel': 'Afastar', 'controls.fitView.ariaLabel': 'Enquadrar todos os nós', 'minimap.ariaLabel': 'Minimapa navegável', 'node.a11yDescription.default': 'Pressione Enter para selecionar e explorar. Use as setas para mover o nó.' }} onKeyDown={event => {
        if (event.key === 'Enter') { const element = (event.target as Element).closest('.react-flow__node'); const node = nodes.find(item => item.id === element?.getAttribute('data-id')); if (node) { event.preventDefault(); activate(node); } }
      }}><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor={node => (node.data as GraphData).color} maskColor="#080f20bb" /></ReactFlow>}
      {!loading && !currentError && !total && domain && !query && mode === 'graph' && <div className="kg-empty-orbit"><p>Este núcleo ainda não tem {location.document ? 'trechos indexados' : 'documentos'}.</p><button className="button secondary" onClick={() => onOpen(domain.id)}>Abrir base de conhecimento</button></div>}
      {!loading && !currentError && total > 0 && mode === 'graph' && <div className="kg-canvas-label"><span>{location.document ? 'DOCUMENTO → TRECHOS' : location.domain ? 'MÓDULO → DOCUMENTOS' : 'NÚCLEO · MÓDULOS · FONTES'}</span><small>{location.document ? 'Clique em um trecho para ler sua fonte' : 'Clique em um nó para explorar'}</small></div>}
      </div><div className="kg-canvas-footer"><span><i />Organização{location.domain && !location.document && showRelations && <><i className="semantic" />Vetorial<i className="lexical" />Termos</>}</span>{location.domain && total > PAGE_SIZE ? <div className="kg-pagination"><button aria-label="Página anterior" disabled={!offset || busy} onClick={() => { setOffset(value => Math.max(0, value - PAGE_SIZE)); setSelected(undefined); }}><ArrowLeft size={14} /></button><span>{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} de {count(total)}</span><button aria-label="Próxima página" disabled={offset + PAGE_SIZE >= total || busy} onClick={() => { setOffset(value => value + PAGE_SIZE); setSelected(undefined); }}><ArrowRight size={14} /></button></div> : <span>{count(total)} {location.document ? 'trechos' : location.domain ? 'documentos' : 'módulos'}</span>}</div>
    </div>
    <aside ref={panel} id="knowledge-inspector" hidden={!showInspector} className="kg-inspector" aria-label="Detalhes e fonte"><span className="kg-kicker">{selectedPassage ? 'FONTE ORIGINAL' : location.document ? 'DOCUMENTO' : domain ? 'MÓDULO DE CONHECIMENTO' : 'COMECE A EXPLORAR'}</span><div className="kg-detail-icon" style={{ color: domain?.color }}>{location.document ? <FileText size={25} /> : domain ? <Boxes size={25} /> : <BrainCircuit size={25} />}</div><h2>{selectedPassage ? `Trecho ${selectedPassage.index + 1}` : title}</h2>
      {passages?.document.sourceUrl && <div className="web-origin"><a href={passages.document.sourceUrl} target="_blank" rel="noopener noreferrer">Origem na web</a>{passages.document.capturedAt && <small>Cópia de {new Date(passages.document.capturedAt).toLocaleString('pt-BR')}</small>}</div>}
      {!!passages?.linkedDocuments?.length && <div className="kg-related"><h3>Links salvos deste site</h3>{passages.linkedDocuments.map(item => <button key={item.id} onClick={() => go({ domain: location.domain, document: item.id, title: item.name })}><FileText size={14} /><span>{item.name}</span><ArrowUpRight size={13} /></button>)}</div>}
      {selectedPassage ? <><p className="kg-detail-caption">{location.title}</p><span className="kg-badge">{selectedPassage.embedded ? 'Representação vetorial disponível' : 'Disponível para busca textual'}</span><div className="kg-source-text">{selectedPassage.text}</div><button className="button secondary" onClick={() => setSelected(undefined)}>Voltar ao documento</button></> : <>
        <p className="kg-detail-caption">{location.document ? 'Explore os trechos indexados e leia o conteúdo que fundamenta as respostas.' : domain ? 'Abra um documento para navegar pelos trechos e conferir suas fontes.' : 'Navegue do contexto à fonte. Cada nó abre um nível da base de conhecimento.'}</p>
        <div className="kg-summary"><div><strong>{count(location.document ? passages?.document.chunks ?? 0 : domain?.documents ?? totals?.documents ?? 0)}</strong><span>{location.document ? 'Trechos' : 'Documentos'}</span></div><div><strong>{count(location.document ? passages?.document.embeddedChunks ?? 0 : domain?.chunks ?? totals?.chunks ?? 0)}</strong><span>{location.document ? 'Vetorizados' : 'Trechos'}</span></div></div>
        {!location.document && <div className="kg-embedding-info"><span className="kg-kicker">INDEXAÇÃO VETORIAL</span><strong>{count(domain?.embeddedChunks ?? data?.domains.reduce((sum, item) => sum + item.embeddedChunks, 0) ?? 0)} trechos vetorizados</strong><p>{data?.embedding.model ?? 'Modelo de embeddings não configurado'}</p>{data?.embedding.dimensions && <small>{count(data.embedding.dimensions)} dimensões · {data.embedding.backend === 'local' ? 'Processamento local' : 'Processamento em nuvem'}</small>}</div>}
        {domain && domain.embeddedChunks < domain.chunks && <div className="kg-index-coverage"><p>{count(domain.chunks - domain.embeddedChunks)} trechos ainda sem vetor do modelo atual. Todos os trechos publicados participam da busca textual.</p>{canReindex && data?.embedding.enabled && <button className="button secondary" disabled={reindexing} onClick={() => void resumeIndexing()}>{reindexing ? 'Solicitando…' : 'Retomar indexação'}</button>}</div>}
        {indexNotice && <p className="kg-detail-caption" role="status">{indexNotice}</p>}
        {domain ? <button className="button primary kg-open" onClick={() => onOpen(domain.id)}>Abrir base de conhecimento <ArrowUpRight size={15} /></button> : <div className="kg-guide"><div><span>01</span><p>Escolha um módulo<small>Localize o contexto do conhecimento.</small></p></div><div><span>02</span><p>Explore os documentos<small>Veja fontes e relações disponíveis.</small></p></div><div><span>03</span><p>Leia os trechos<small>Confira o conteúdo original.</small></p></div></div>}
        {location.domain && !location.document && <div className="kg-relation-note"><h3><Network size={16} /> Sobre as relações</h3><p>Linhas verdes comparam amostras dos vetores dos documentos. Linhas tracejadas comparam termos do texto. Os percentuais indicam similaridade, não certeza factual.</p><small>Até 3 relações por documento. Comparação em {detail?.comparedDocuments ?? 0} documentos do domínio; as linhas mostram os nós visíveis.</small></div>}
        {detail && !!detail.relatedDocuments?.length && <div className="kg-related"><h3>Conexões fora desta página</h3><p>Documentos relacionados aos nós visíveis, em outras páginas ou fora do filtro.</p>{detail.relatedDocuments.map(item => <button key={item.relatedTo + ':' + item.id} onClick={() => go({ domain: location.domain, document: item.id, title: item.name })}><FileText size={15} /><span>{item.name}<small>{item.method === 'semantic' ? 'Similaridade vetorial' : 'Termos em comum'} · {Math.round(item.score * 100)}% · com {detail.documents.find(doc => doc.id === item.relatedTo)?.name}</small></span><ArrowUpRight size={13} /></button>)}</div>}
        {!location.domain && <div className="kg-shortcuts"><h3>Navegação</h3><p>Arraste o fundo para mover.<br />Use a rolagem ou o gesto de pinça para zoom.<br />Use o minimapa para percorrer a rede.</p><button onClick={() => void flow.current?.fitView({ padding: .15, duration, maxZoom: 1 })}><Focus size={15} /> Enquadrar a rede</button></div>}
      </>}
    </aside></div>
    <footer className="kg-status"><span><Layers3 size={13} />{data?.embedding.enabled ? 'Busca vetorial habilitada' : 'Busca textual disponível'}</span><span>Documentos e trechos respeitam suas permissões de acesso</span></footer>
  </section>;
}
