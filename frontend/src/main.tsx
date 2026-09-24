import { MAX_UPLOAD_BYTES } from '../../core/ingestion-limits';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowUpRight, ArrowRight, ArrowUp, ArrowLeft, Activity, AudioLines, BookOpen, Boxes, BrainCircuit,
  Check, CheckCircle2, ChevronDown, Circle, Clock3, Database, FileText, FolderOpen,
  GitBranch, Globe2, Layers3, LayoutDashboard, Link2, LoaderCircle, MessageSquare,
  MoreHorizontal, Network, Plus, Search, Settings2, ShieldCheck, Sparkles, Upload,
  X, Zap, Bot, Server, HeartPulse, Scale, ChartNoAxesCombined, Users, Building2,
  PanelLeftClose, Menu, Trash2, ThumbsUp, ThumbsDown, ExternalLink, LogOut, Copy, AlertCircle, KeyRound, LogIn,
  Mic, Volume2, Square
} from 'lucide-react';
import { initializeAuth, authMode, changePassword, login, nativeLogin, logout } from './auth';
import { api, ask } from './api';
import type { ConversationTurn, DocumentRecord, Run, TraceStep, Evidence } from '../../core/types';
import './styles.css';
import { NeuralExplorer, type NeuralMap } from './KnowledgeExplorer';
import './theme.css';
import { useVoiceConversation } from './useVoiceConversation';
import { VoiceExperience } from './VoiceExperience';
import { WebSources } from './WebSources';
import { OfflineReader } from './OfflineReader';
import { conversationId as newConversationId } from './conversation-id';

type Page = 'overview' | 'chat' | 'knowledge' | 'pipeline' | 'domains' | 'integrations' | 'observability' | 'neural' | 'settings';
type Domain = { id: string; name: string; description: string; color: string; icon: string };
type Status = { version: string; authMode: string; generation: boolean; embeddings: boolean; provider?: 'openai' | 'anthropic' | 'ollama'; model: string | null; storage: string; documents: number; processing: number; chunks: number; mcpServers: number };
const titles: Record<Page, string> = { overview: 'Visão geral', chat: 'Chat institucional', knowledge: 'Base de conhecimento', pipeline: 'Pipeline Explorer', domains: 'Módulos de domínio', integrations: 'Integrações', observability: 'Observabilidade', neural: 'Mapa Neural', settings: 'Configurações' };
const nav = [
  { id: 'overview', icon: LayoutDashboard }, { id: 'chat', icon: MessageSquare },
  { id: 'knowledge', icon: BookOpen }, { id: 'pipeline', icon: GitBranch },
  { id: 'domains', icon: Boxes }, { id: 'integrations', icon: Link2 },
  { id: 'observability', icon: Activity }, { id: 'neural', icon: BrainCircuit }
] as const;
const iconMap: Record<string, typeof Sparkles> = { sparkles: Sparkles, heart: HeartPulse, scale: Scale, server: Server, chart: ChartNoAxesCombined, book: BookOpen, users: Users, files: FolderOpen, building: Building2 };
const stageLabels = ['Upload', 'Extração', 'Qualidade', 'Normalização', 'Enriquecimento', 'Indexação', 'Validação', 'Disponível'];
const date = (value: string) => new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
function Pill({ children, tone = '' }: { children: React.ReactNode; tone?: string }) { return <span className={'pill ' + tone}><i />{children}</span>; }
function Empty({ icon: Icon = FolderOpen, title, text, action }: { icon?: typeof Sparkles; title: string; text: string; action?: React.ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Icon size={27} /></div><h3>{title}</h3><p>{text}</p>{action}</div>;
}
function App() {
  const [page, setPage] = useState<Page>('overview');
  const [sidebar, setSidebar] = useState(false);
  const [status, setStatus] = useState<Status>();
  const [domains, setDomains] = useState<Domain[]>([]);
  const [domain, setDomain] = useState('geral');
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [me, setMe] = useState<{ id: string; roles: string[]; authMode: string }>();
  const [error, setError] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [booting, setBooting] = useState(true);
  const [offlineId, setOfflineId] = useState<string>();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<string>();
  const [search, setSearch] = useState('');
  const [question, setQuestion] = useState('');
  const [conversationId, setConversationId] = useState(() => {
    try { return sessionStorage.getItem('lumina:conversation:geral') ?? newConversationId(); } catch { return newConversationId(); }
  });
  const [agent, setAgent] = useState(false);
  const [asking, setAsking] = useState(false);
  const [steps, setSteps] = useState<TraceStep[]>([]);
  const [chat, setChat] = useState<Run[]>([]);
  const [source, setSource] = useState<Evidence>();
  const [integrationData, setIntegrationData] = useState<any>({ catalog: [], servers: [] });
  const [tools, setTools] = useState<any[]>([]);
  const [mcpServer, setMcpServer] = useState('');
  const [mcpTool, setMcpTool] = useState('');
  const [mcpArgs, setMcpArgs] = useState('{}');
  const [mcpResult, setMcpResult] = useState('');
  const [mcpBusy, setMcpBusy] = useState(false);
  const [audit, setAudit] = useState<any[]>([]);
  const [neuralMap, setNeuralMap] = useState<NeuralMap>();
  const [neuralError, setNeuralError] = useState('');
  function loadNeuralMap() {
    setNeuralError('');
    void api<NeuralMap>('/neural-map').then(setNeuralMap).catch(e => setNeuralError(e.message));
  }
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const bottom = useRef<HTMLDivElement>(null);
  const requestBusy = useRef(false);
  const activeDomain = domains.find(d => d.id === domain);
  const allowedWrite = me?.roles.some(r => ['admin', 'editor'].includes(r));
  const isAdmin = me?.roles.includes('admin');
  const selection = useRef(domain); selection.current = domain;
  const voice = useVoiceConversation(page + ':' + domain + ':' + conversationId, sendQuestion, setError);
  const listening = voice.phase === 'listening';
  const speakingId = voice.replyId;
  function speakAnswer(run: Run) {
    if (speakingId === run.id) voice.interrupt(); else voice.read(run);
  }

  async function refresh(forDomain = domain) {
    const [s, d, r] = await Promise.all([api<Status>('/status'), api<DocumentRecord[]>('/documents?domain=' + forDomain), api<Run[]>('/runs?domain=' + forDomain)]);
    if (selection.current !== forDomain) return;
    setStatus(s); setDocuments(d); setRuns(r);
  }
  useEffect(() => {
    void (async () => {
      try {
        await initializeAuth();
        const [user, list] = await Promise.all([api<any>('/me'), api<Domain[]>('/domains')]);
        setMe(user); setDomains(list);
        const initial = list[0]?.id;
        if (initial) { selection.current = initial; setDomain(initial); await refresh(initial); }
      } catch (e) { setError((e as Error).message); } finally { setBooting(false); }
    })();
  }, []);
  useEffect(() => {
    if (!me || !domains.length) return;
    let nextConversation: string = newConversationId();
    try { nextConversation = sessionStorage.getItem('lumina:conversation:' + domain) ?? nextConversation; } catch { /* storage is optional */ }
    setConversationId(nextConversation);
    setChat([]); setSource(undefined); setSelectedDocument(undefined); setOfflineId(undefined);
    setMcpServer(''); setTools([]); setMcpResult('');
    void refresh(domain).catch(e => setError(e.message));
  }, [domain, me]);
  useEffect(() => {
    try { sessionStorage.setItem('lumina:conversation:' + domain, conversationId); } catch { /* storage is optional */ }
  }, [domain, conversationId]);
  useEffect(() => {
    if (page !== 'chat') return;
    setChat(runs.filter(run => run.domain === domain && run.conversationId === conversationId).reverse());
  }, [page, domain, conversationId, runs]);
  useEffect(() => {
    if (!documents.some(d => d.status === 'processing')) return;
    const timer = setInterval(() => void refresh().catch(e => setError(e.message)), 1500);
    return () => clearInterval(timer);
  }, [documents, domain]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [chat, asking, steps]);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(timer); } }, [notice]);
  useEffect(() => {
    if (page === 'integrations') void api('/integrations').then(setIntegrationData).catch(e => setError(e.message));
    if (page === 'observability' && isAdmin) void api('/audit').then(setAudit).catch(e => setError(e.message));
    if (page === 'neural') loadNeuralMap();
  }, [page, isAdmin]);
  useEffect(() => {
    if (page !== 'neural' || !neuralMap?.domains.some(d => d.embeddedChunks < d.chunks)) return;
    const timer = setInterval(() => void api<NeuralMap>('/neural-map').then(setNeuralMap).catch(() => undefined), 4000);
    return () => clearInterval(timer);
  }, [page, neuralMap]);
  function navigate(next: Page) { setPage(next); setSidebar(false); }
  async function upload(file?: File) {
    if (!file || uploadBusy) return;
    if (file.size > MAX_UPLOAD_BYTES) return setError('O limite por arquivo é 50 MB.');
    setUploadBusy(true);
    try {
      const body = new FormData(); body.append('domain', domain); body.append('file', file);
      const result = await api<{ document: DocumentRecord; duplicate: boolean }>('/documents', { method: 'POST', body });
      setNotice(result.duplicate ? 'Este arquivo já existe neste domínio.' : 'Arquivo recebido. Acompanhe o processamento no pipeline.');
      setUploadOpen(false); await refresh(); setSelectedDocument(result.document.id); navigate('pipeline');
    } catch (e) { setError((e as Error).message); } finally { setUploadBusy(false); }
  }
  async function removeDocument(id: string) {
    try { await api('/documents/' + id, { method: 'DELETE' }); setConfirmDelete(undefined); await refresh(); setNotice('Documento e arquivo original excluídos.'); }
    catch (e) { setError((e as Error).message); }
  }
  async function sendQuestion(text: string, signal?: AbortSignal): Promise<Run> {
    const q = text.trim();
    if (q.length < 2 || q.length > 4000) throw new Error('Use uma pergunta entre 2 e 4000 caracteres.');
    if (requestBusy.current) throw new Error('Aguarde a resposta atual antes de perguntar novamente.');
    const forDomain = domain;
    requestBusy.current = true; setAsking(true); setSteps([]); setQuestion('');
    try {
      const history: ConversationTurn[] = chat.slice(-6).map(run => ({ question: run.question, answer: run.answer }));
      const run = await ask(q, forDomain, agent, history, conversationId, step => { if (!signal?.aborted && selection.current === forDomain) setSteps(old => [...old, step]); }, signal);
      signal?.throwIfAborted();
      if (selection.current === forDomain) setChat(old => [...old, run]);
      void refresh(forDomain).catch(() => undefined);
      return run;
    } finally { requestBusy.current = false; setAsking(false); }
  }
  async function submit(event?: React.FormEvent) {
    event?.preventDefault(); if (question.trim().length < 2 || asking) return;
    voice.stop(); const q = question;
    try { await sendQuestion(q); }
    catch (error) { setError((error as Error).message); setQuestion(q); }
  }
  async function feedback(run: Run, value: number) {
    try { await api('/runs/' + run.id + '/feedback', { method: 'POST', body: JSON.stringify({ value }) }); setChat(old => old.map(r => r.id === run.id ? { ...r, feedback: value } : r)); await refresh(); setNotice('Avaliação registrada.'); }
    catch (e) { setError((e as Error).message); }
  }
  async function discover(id: string) {
    setMcpBusy(true); setMcpServer(id); setMcpResult(''); setTools([]);
    try { const t = await api<any[]>('/mcp/' + id + '/tools?domain=' + domain); setTools(t); setMcpTool(t[0]?.name ?? ''); }
    catch (e) { setError((e as Error).message); } finally { setMcpBusy(false); }
  }
  async function executeTool() {
    setMcpBusy(true);
    try { const result = await api('/mcp/' + mcpServer + '/call', { method: 'POST', body: JSON.stringify({ domain, tool: mcpTool, arguments: JSON.parse(mcpArgs) }) }); setMcpResult(JSON.stringify(result, null, 2)); }
    catch (e) { setError((e as Error).message); } finally { setMcpBusy(false); }
  }
  const uploadButton = <button className="button primary" onClick={() => setUploadOpen(true)} disabled={!allowedWrite}><Plus size={16} /> Adicionar documento</button>;
  const ready = documents.filter(d => d.status === 'ready').length;
  const selected = documents.find(d => d.id === selectedDocument) ?? documents[0];
  const averageLatency = runs.length ? (runs.reduce((s, r) => s + r.durationMs, 0) / runs.length / 1000).toFixed(2) + ' s' : '—';

  if (booting) return <div className="boot"><img src="/lumina.svg" alt="" /><h1>LUMINA</h1><LoaderCircle className="spin" /><p>Preparando seu espaço de conhecimento</p></div>;
  if (!me) return <main className="login-screen"><section className="login-panel"><div className="login-mark"><img src="/lumina.svg" alt="" /></div><div className="eyebrow"><span /> ACESSO INSTITUCIONAL</div><h1>Entre no LUMINA</h1><p>{error || (authMode() === 'native' ? 'Use sua matrícula ou e-mail e a senha cadastrada.' : 'Use sua identidade institucional para acessar os módulos autorizados.')}</p>{authMode() === 'native' ? <form onSubmit={async event => { event.preventDefault(); if (loginBusy) return; setLoginBusy(true); setError(''); try { await nativeLogin(identifier, password, otp); location.reload(); } catch (e) { setError((e as Error).message); } finally { setLoginBusy(false); } }}><label>Matrícula ou e-mail<input value={identifier} onChange={event => setIdentifier(event.target.value)} autoComplete="username" required /></label><label>Senha<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required /></label><label>Código 2FA <span>(se habilitado)</span><input value={otp} onChange={event => setOtp(event.target.value)} inputMode="numeric" maxLength={6} autoComplete="one-time-code" /></label><button className="button primary login-button" type="submit" disabled={loginBusy}><LogIn size={17} />{loginBusy ? 'Entrando...' : 'Entrar'}</button></form> : <button className="button primary login-button" onClick={() => void login().catch(e => setError(e.message))}><LogIn size={17} />Entrar com identidade institucional</button>}<small>{authMode() === 'native' ? 'Acesso protegido pelo PostgreSQL e pelo segundo fator configurado na conta.' : 'Seu acesso, senha e troca obrigatória de senha são gerenciados com segurança pelo provedor institucional.'}</small><button className="button ghost" onClick={() => location.reload()}>Tentar novamente</button></section></main>;
  return <div className="app">
    {sidebar && <button className="mobile-scrim" aria-label="Fechar menu" onClick={() => setSidebar(false)} />}
    <aside className={'sidebar ' + (sidebar ? 'open' : '')}>
      <a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('overview'); }}><img src="/lumina.svg" alt="" /><span>LUMINA<small>INTELIGÊNCIA INSTITUCIONAL</small></span></a>
      <div className="workspace"><div className="workspace-icon"><Building2 size={17} /></div><div>Meu ambiente<small>Plataforma de conhecimento</small></div><ShieldCheck size={16} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav>{nav.map(({ id, icon: Icon }) => <button key={id} className={'nav-item ' + (page === id ? 'active' : '')} onClick={() => navigate(id)}><Icon size={18} /><span>{titles[id]}</span>{id === 'chat' && <span className="nav-badge">IA</span>}{page === id && <i />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="environment"><div className="environment-heading"><span className="live-dot" />{status?.generation ? 'Provedor configurado' : 'Pronto para começar'}</div><p>{status?.generation ? 'Respostas com fontes e verificação de evidências.' : 'Adicione documentos e conecte seu provedor de IA.'}</p><button onClick={() => navigate('settings')}>Configurar ambiente <ArrowUpRight size={14} /></button></div>
        <button className={'nav-item ' + (page === 'settings' ? 'active' : '')} onClick={() => navigate('settings')}><Settings2 size={18} />Configurações</button>
        <div className="profile"><div className="avatar">L</div><div>{me.authMode === 'local' ? 'Ambiente local' : me.authMode === 'native' ? 'Sessão nativa' : 'Sessão institucional'}<small>{isAdmin ? 'Administrador' : 'Colaborador'}</small></div>{me.authMode === 'oidc' && <button className="icon-button" aria-label="Trocar senha" title="Trocar senha" onClick={() => void changePassword().catch(e => setError(e.message))}><KeyRound size={17} /></button>}<button className="icon-button" aria-label="Sair" title="Sair" onClick={() => void logout().catch(e => setError(e.message))}><LogOut size={17} /></button></div>
      </div>
    </aside>
    <div className="shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Abrir menu" onClick={() => setSidebar(true)}><Menu size={20} /></button><span>Workspace</span><span className="slash">/</span><strong>{titles[page]}</strong></div><div className="topbar-right"><span className="version">v{status?.version}</span><Pill tone={status?.authMode === 'local' ? 'amber' : 'green'}>{status?.authMode === 'local' ? 'Desenvolvimento local' : 'Identidade protegida'}</Pill><div className="divider" /><span className="small-avatar">L</span></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow"><span /> CONHECIMENTO QUE CONECTA</div><h1>{page === 'overview' ? 'Clareza para cada decisão.' : titles[page]}</h1><p>{({ overview: 'Transforme informação em conhecimento. Com contexto, fontes e controle.', chat: 'Converse com o conhecimento da sua organização.', knowledge: 'Suas fontes, organizadas e prontas para consulta.', pipeline: 'Cada etapa do documento, da entrada à disponibilidade.', domains: 'Conhecimento organizado. Contexto preservado.', integrations: 'Conecte ferramentas e sistemas ao conhecimento institucional.', observability: 'Acompanhe execuções, qualidade e rastreabilidade.', neural: 'Explore os módulos e acompanhe seu conhecimento institucional.', settings: 'Prepare os serviços e o provedor para seus testes.' })[page]}</p></div><div className="heading-actions">{page === 'overview' ? <button className="button primary" onClick={() => navigate('chat')}><Sparkles size={16} />Abrir chat <ArrowUpRight size={16} /></button> : ['knowledge', 'pipeline'].includes(page) ? uploadButton : null}</div></div>
        {page !== 'overview' && page !== 'settings' && page !== 'neural' && <div className="domain-bar"><div><Layers3 size={15} /><span>Domínio ativo</span></div><select aria-label="Domínio ativo" value={domain} disabled={asking || uploadBusy} onChange={e => setDomain(e.target.value)}>{domains.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select><span className="domain-hint">Consultas e documentos respeitam este contexto</span></div>}
        {page === 'overview' && <>
          <section className="overview-hero"><div className="hero-copy"><Pill tone="violet">SEU NÚCLEO DE INTELIGÊNCIA</Pill><h2>Todo o conhecimento.<br /><span>Um novo ponto de luz.</span></h2><p>Conecte suas fontes, encontre respostas e acompanhe o caminho entre a pergunta e a evidência.</p><div className="hero-actions"><button className="button light" onClick={() => navigate('knowledge')}>Explorar conhecimento <ArrowRight size={16} /></button><button className="text-button" onClick={() => navigate('pipeline')}>Ver pipeline <GitBranch size={16} /></button></div></div><div className="lumina-orbit" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" /><div className="orbit-line line-one" /><div className="orbit-line line-two" /><div className="orbit-center"><img src="/lumina.svg" alt="" /></div><div className="orbit-node node-one"><Database size={20} /></div><div className="orbit-node node-two"><Boxes size={20} /></div><div className="orbit-node node-three"><Bot size={20} /></div><span className="orbit-caption">FONTES · CONTEXTO · INTELIGÊNCIA</span></div></section>
          <div className="stats-grid">{[
            { label: 'Documentos disponíveis', value: status?.documents ?? 0, icon: FileText, detail: 'Nos domínios autorizados' },
            { label: 'Trechos de conhecimento', value: status?.chunks ?? 0, icon: Database, detail: 'Fontes prontas para recuperação' },
            { label: 'Módulos de domínio', value: domains.length, icon: Boxes, detail: 'Contextos independentes' },
            { label: 'Conexões MCP', value: status?.mcpServers ?? 0, icon: Network, detail: 'Servidores configurados' }
          ].map(s => <div className="stat-card" key={s.label}><div><span>{s.label}</span><s.icon size={17} /></div><strong>{s.value}</strong><small>{s.detail}</small></div>)}</div>
          <div className="section-heading"><div><h2>Um núcleo. Quatro capacidades.</h2><p>Componentes separados, trabalhando no mesmo fluxo.</p></div><span className="section-tag">ARQUITETURA MODULAR</span></div>
          <div className="core-grid">{[
            { title: 'MCP', subtitle: 'Conexões e ferramentas', description: 'Acesso padronizado a ferramentas autorizadas e sistemas institucionais.', icon: Boxes, theme: 'cyan', label: status?.mcpServers ? 'Configurado' : 'Aguardando conexão', page: 'integrations' },
            { title: 'RAG', subtitle: 'Conhecimento e evidência', description: 'Recuperação por domínio com trechos rastreáveis até o documento de origem.', icon: Database, theme: 'green', label: status?.embeddings ? 'Busca híbrida' : 'Busca lexical disponível', page: 'knowledge' },
            { title: 'LLMOps', subtitle: 'Controle e qualidade', description: 'Execuções, latência, consumo de tokens e avaliação das respostas.', icon: Settings2, theme: 'violet', label: 'Rastreabilidade ativa', page: 'observability' },
            { title: 'Agentes', subtitle: 'Planejamento e execução', description: 'Planejar, recuperar e verificar. Um fluxo de consulta com limites claros.', icon: Bot, theme: 'amber', label: status?.generation ? 'Provedor configurado' : 'Pronto para configurar', page: 'chat' }
          ].map(c => <button className={'core-card ' + c.theme} key={c.title} onClick={() => navigate(c.page as Page)}><div className="core-card-top"><span className="core-icon"><c.icon size={23} /></span><ArrowUpRight size={17} /></div><h3>{c.title}</h3><strong>{c.subtitle}</strong><p>{c.description}</p><div className="core-state"><i />{c.label}</div></button>)}</div>
          <div className="orchestrator-strip"><span className="orchestrator-icon"><GitBranch size={21} /></span><div><strong>Orquestrador inteligente</strong><span>Intenção → planejamento → recuperação → resposta → verificação</span></div><span className="subtle-tag">LangGraph</span><ArrowRight size={18} /></div>
          <div className="overview-bottom"><section className="panel"><div className="panel-heading"><h3>Do arquivo ao conhecimento</h3><button className="text-button" onClick={() => navigate('pipeline')}>Explorar <ArrowUpRight size={14} /></button></div><div className="mini-pipeline">{['Receber', 'Processar', 'Indexar', 'Validar'].map((s, i) => <React.Fragment key={s}><div><span>{String(i + 1).padStart(2, '0')}</span><strong>{s}</strong></div>{i < 3 && <ArrowRight size={14} />}</React.Fragment>)}</div><div className="panel-footer"><ShieldCheck size={14} />Fontes identificadas em cada etapa do processo</div></section><section className="panel getting-started"><div className="panel-heading"><h3>Seu próximo passo</h3><Sparkles size={17} /></div><p>{status?.documents ? 'O conhecimento já está disponível. Faça sua primeira pergunta com fontes.' : 'Comece pelo que sua organização já sabe.'}</p><button className="text-button accent" onClick={() => status?.documents ? navigate('chat') : setUploadOpen(true)} disabled={!status?.documents && !allowedWrite}>{status?.documents ? 'Consultar documentos' : 'Adicionar o primeiro documento'} <ArrowRight size={15} /></button></section></div>
        </>}
        {page === 'knowledge' && <><WebSources key={domain} domain={domain} allowed={Boolean(allowedWrite)} onChange={() => void refresh().catch(e => setError(e.message))} onOpen={setOfflineId} /><section className="panel"><div className="panel-heading"><div><h2>Documentos <span className="count">{documents.length}</span></h2><p>{activeDomain?.name} · {ready} disponível(is)</p></div><label className="search-input"><Search size={17} /><input placeholder="Buscar documento..." value={search} onChange={e => setSearch(e.target.value)} /></label></div>
          {!documents.length ? <Empty title="Seu conhecimento começa aqui" text="Adicione um documento para extrair, organizar e consultar suas informações com fontes." action={uploadButton} /> :
          <div className="table-wrap"><table><thead><tr><th>DOCUMENTO</th><th>STATUS</th><th>TRECHOS</th><th>ADICIONADO EM</th><th aria-label="Ações" /></tr></thead><tbody>{documents.filter(d => d.name.toLowerCase().includes(search.toLowerCase())).map(d => <tr key={d.id}><td><button className="document-name" onClick={() => { if (d.sourceUrl && d.status === 'ready') setOfflineId(d.id); else { setSelectedDocument(d.id); navigate('pipeline'); } }}><span className="file-icon"><FileText size={19} /></span><span>{d.name}<small>{(d.size / 1024).toFixed(1)} KB · {d.sourceUrl ? 'WEB · cópia offline' : d.name.split('.').pop()?.toUpperCase()}</small></span></button></td><td><Pill tone={d.status === 'ready' ? 'green' : d.status === 'failed' ? 'red' : 'amber'}>{d.status === 'ready' ? 'Disponível' : d.status === 'failed' ? 'Falhou' : 'Processando'}</Pill></td><td>{d.chunks}</td><td className="muted">{date(d.createdAt)}</td><td><button className="icon-button" aria-label={'Excluir ' + d.name} disabled={!allowedWrite || d.status === 'processing'} onClick={() => setConfirmDelete(d.id)}><Trash2 size={16} /></button></td></tr>)}</tbody></table></div>}
          <div className="panel-footer"><ShieldCheck size={14} />TXT, MD, CSV, JSON, PDF com texto, DOCX e XLSX · Até 50 MB por arquivo</div></section></>}
        {page === 'pipeline' && <>
          <div className="pipeline-summary"><div><GitBranch size={20} /><strong>Pipeline de conhecimento</strong><span>8 etapas, uma origem rastreável</span></div><Pill tone="violet">{documents.filter(d => d.status === 'processing').length} em processamento</Pill></div>
          {!selected ? <section className="panel"><Empty icon={GitBranch} title="O próximo documento inicia o fluxo" text="Veja extração, qualidade, normalização, enriquecimento, indexação e validação em um só lugar." action={uploadButton} /></section> : <div className="pipeline-layout"><section className="panel document-list"><div className="panel-heading"><h3>Documentos</h3><span className="count">{documents.length}</span></div>{documents.map(d => <button key={d.id} className={'document-choice ' + (selected.id === d.id ? 'selected' : '')} onClick={() => setSelectedDocument(d.id)}><FileText size={18} /><span>{d.name}<small>{d.status === 'ready' ? 'Disponível' : d.status === 'failed' ? 'Falhou' : 'Processando'}</small></span><ChevronDown size={14} /></button>)}</section><section className="panel pipeline-detail"><div className="panel-heading"><div><h3>{selected.name}</h3><p>{date(selected.createdAt)} · {selected.chunks} trechos</p></div><Pill tone={selected.status === 'failed' ? 'red' : 'green'}>{selected.status === 'ready' ? 'Concluído' : selected.status === 'failed' ? 'Falhou' : 'Em andamento'}</Pill></div><div className="timeline">{stageLabels.map((name, i) => {
            const stage = selected.stages.find(s => s.name === name);
            const active = !stage && selected.status === 'processing' && i === selected.stages.length;
            return <div key={name} className={'timeline-step ' + (stage?.status ?? (active ? 'processing' : 'waiting'))}><span className="timeline-dot">{stage?.status === 'done' ? <Check size={15} /> : stage?.status === 'failed' ? <X size={15} /> : active ? <LoaderCircle size={15} className="spin" /> : <span>{i + 1}</span>}</span><div><strong>{name}</strong><p>{stage?.detail ?? (active ? 'Processando...' : 'Aguardando etapa anterior')}</p></div>{stage && <time>{new Date(stage.at).toLocaleTimeString('pt-BR')}</time>}</div>;
          })}</div>{selected.error && <div className="inline-alert"><AlertCircle size={17} />{selected.error}</div>}</section></div>}
        </>}
        {page === 'chat' && <div className={'chat-layout ' + (source ? 'with-source' : '')}><section className="panel chat-panel"><div className="chat-top"><div><span className="lumina-mini"><Sparkles size={17} /></span><strong>LUMINA</strong><Pill tone={status?.generation ? 'green' : 'amber'}>{status?.generation ? status.model : 'Modo documental · sem IA'}</Pill>{chat.length > 0 && <Pill tone="violet">Contexto restaurado</Pill>}</div><button className="text-button" disabled={asking} onClick={() => { const next = newConversationId(); setConversationId(next); setChat([]); setSource(undefined); }}>Nova conversa <Plus size={15} /></button></div><div className="chat-body">
          {!chat.length && !asking && <div className="chat-welcome"><div className="welcome-glyph"><Sparkles size={32} /></div><div className="eyebrow">SEU CONHECIMENTO, MAIS PRÓXIMO</div><h2>O que vamos descobrir?</h2><p>{ready ? 'Faça uma pergunta sobre os documentos deste domínio. Cada resposta começa pelas fontes.' : 'Adicione documentos neste domínio para começar. As respostas serão baseadas nas suas fontes.'}</p><div className="suggestions">{['Quais são os principais pontos dos documentos?', 'Que procedimentos estão descritos na base?', 'Quais informações sustentam essa decisão?'].map(q => <button key={q} onClick={() => setQuestion(q)}>{q}<ArrowUpRight size={15} /></button>)}</div>{!ready && <button className="text-button accent" disabled={!allowedWrite} onClick={() => setUploadOpen(true)}><Plus size={15} />Adicionar documento</button>}</div>}
          {chat.map(run => <article className="exchange" key={run.id}><div className="user-message">{run.question}</div><div className="assistant-heading"><span className="lumina-mini"><Sparkles size={15} /></span><strong>LUMINA</strong><span>{!run.sources.length && run.status === 'completed' ? 'Conversa' : run.mode === 'extractive' ? 'Trechos da sua base' : 'Resposta com evidências'}</span><button className="voice-action" aria-label={speakingId === run.id ? 'Parar leitura' : 'Ouvir resposta'} disabled={asking} onClick={() => speakAnswer(run)}>{speakingId === run.id ? <Square size={13} /> : <Volume2 size={15} />}</button></div><div className="answer">{run.answer}</div>{run.sources.length > 0 && <div className="sources"><span>FONTES CONSULTADAS</span><div>{run.sources.map((s, i) => <button key={s.id} onClick={() => setSource(s)}><span>{i + 1}</span><FileText size={13} />{s.title}<ArrowUpRight size={13} /></button>)}</div></div>}<div className="answer-footer"><span><Clock3 size={13} />{(run.durationMs / 1000).toFixed(1)} s · {run.steps.length} etapas</span><div><button className={'icon-button ' + (run.feedback === 1 ? 'chosen' : '')} aria-label="Resposta útil" onClick={() => void feedback(run, 1)}><ThumbsUp size={14} /></button><button className={'icon-button ' + (run.feedback === -1 ? 'chosen' : '')} aria-label="Resposta não foi útil" onClick={() => void feedback(run, -1)}><ThumbsDown size={14} /></button></div></div><details className="trace-details"><summary>Ver caminho da resposta</summary>{run.steps.map((s, i) => <p key={i}><CheckCircle2 size={13} /><strong>{s.name}</strong> {s.detail}</p>)}</details></article>)}
          {asking && <div className="thinking"><LoaderCircle size={18} className="spin" /><div><strong>Consultando suas fontes...</strong>{steps.map((s, i) => <p key={i}><Check size={13} />{s.name} · {s.detail}</p>)}</div></div>}<div ref={bottom} /></div>
          <VoiceExperience voice={voice} busy={asking} />
          <form className="composer" onSubmit={submit}><textarea value={question} onChange={e => setQuestion(e.target.value)} placeholder={listening ? 'Estou ouvindo… fale agora' : 'Pergunte ao conhecimento da sua organização...'} aria-label="Sua pergunta" maxLength={4000} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }} /><div className="composer-bottom"><label className={'agent-toggle ' + (agent ? 'enabled' : '')}><input type="checkbox" checked={agent} onChange={e => setAgent(e.target.checked)} /><GitBranch size={14} />Consulta com planejamento</label><span>{question.length}/4000</span><button className="voice-mode-button" type="button" aria-pressed={voice.active} disabled={asking && !voice.active} onClick={() => voice.active ? voice.stop() : voice.start()}><Mic size={17} />{voice.active ? 'Encerrar voz' : 'Conversar por voz'}</button><button className="send-button" type="submit" aria-label="Enviar pergunta" disabled={asking || question.trim().length < 2}>{asking ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={18} />}</button></div></form><p className="voice-disclosure">A conversa por voz usa o reconhecimento do navegador, que pode processar áudio online. A escuta pausa durante a resposta e encerra ao sair do chat.</p><div className="chat-disclaimer"><ShieldCheck size={12} />{listening ? 'Microfone ativo. Após uma pausa, envio sua pergunta e leio a resposta.' : status?.generation ? 'Confira as fontes. A verificação automática pode falhar.' : 'Sem modelo configurado, as consultas apresentam trechos literais da base.'}</div></section>
          {source && <aside className="panel source-panel"><div className="panel-heading"><h3>Fonte da resposta</h3><button className="icon-button" aria-label="Fechar fonte" onClick={() => setSource(undefined)}><X size={18} /></button></div><div className="source-content"><FileText size={26} /><h3>{source.title}</h3><Pill tone="violet">Trecho {source.chunk}</Pill><p>{source.text}</p>{source.sourceUrl && <div className="web-origin"><a href={source.sourceUrl} target="_blank" rel="noopener noreferrer">Abrir página original</a>{source.capturedAt && <small>Capturada em {date(source.capturedAt)}</small>}<button className="text-button" onClick={() => setOfflineId(source.documentId)}>Ler cópia offline</button></div>}<small>ID de origem: {source.documentId}</small></div></aside>}</div>}
        {page === 'domains' && <><div className="inline-note"><ShieldCheck size={18} /><div><strong>Separação por contexto</strong><p>Cada módulo consulta sua própria base. As regras específicas serão definidas a partir das suas necessidades.</p></div></div><div className="domains-grid">{domains.map(d => { const Icon = iconMap[d.icon] ?? Boxes; return <button key={d.id} className={'panel domain-card ' + (domain === d.id ? 'selected' : '')} onClick={() => { setDomain(d.id); navigate('knowledge'); }}><span className="domain-icon" style={{ color: d.color, background: d.color + '16' }}><Icon size={24} /></span><ArrowUpRight size={17} className="card-arrow" /><h3>{d.name}</h3><p>{d.description}</p><div><span className="live-dot" />Base independente<span>Abrir módulo <ArrowRight size={13} /></span></div></button>; })}</div></>}
        {page === 'integrations' && <><div className="section-heading"><div><h2>Sistemas e ferramentas</h2><p>Integrações entram pela camada MCP com lista explícita de ferramentas permitidas.</p></div><Pill tone="violet">{integrationData.servers.length} configurado(s)</Pill></div><div className="integration-grid">{integrationData.catalog.map((item: any) => <div className="panel integration-card" key={item.id}><span className="integration-icon"><Network size={23} /></span><div><h3>{item.name}</h3><small>{item.category}</small></div><Pill>Não configurado</Pill><p>{item.description}</p></div>)}</div><section className="panel mcp-panel"><div className="panel-heading"><div><h3>Servidores MCP</h3><p>Somente ferramentas de leitura autorizadas pelo administrador.</p></div><Boxes size={20} /></div>{!integrationData.servers.length ? <Empty icon={Link2} title="A próxima conexão começa aqui" text="Configure MCP_SERVERS_JSON no servidor. Endereços e credenciais ficam fora do navegador." action={<button className="button secondary" onClick={() => navigate('settings')}>Ver configuração <ArrowRight size={15} /></button>} /> : <div className="mcp-content">{integrationData.servers.filter((s: any) => s.domains.includes(domain)).map((s: any) => <div className="server-row" key={s.id}><div><strong>{s.name}</strong><small>{s.readOnlyTools.length} ferramenta(s) autorizada(s)</small></div><button className="button secondary" disabled={!isAdmin || mcpBusy} onClick={() => void discover(s.id)}>Listar ferramentas</button></div>)}{mcpServer && <><label className="field">Ferramenta<select value={mcpTool} onChange={e => setMcpTool(e.target.value)}>{tools.map(t => <option key={t.name}>{t.name}</option>)}</select></label>{tools.find(t => t.name === mcpTool) && <details><summary>Contrato de entrada</summary><pre>{JSON.stringify(tools.find(t => t.name === mcpTool).inputSchema, null, 2)}</pre></details>}<label className="field">Argumentos JSON<textarea value={mcpArgs} onChange={e => setMcpArgs(e.target.value)} /></label><button className="button primary" disabled={!mcpTool || mcpBusy} onClick={() => void executeTool()}>{mcpBusy ? <LoaderCircle size={15} className="spin" /> : <Zap size={15} />}Executar leitura</button>{mcpResult && <pre>{mcpResult}</pre>}</>}</div>}</section></>}
        {page === 'observability' && <><div className="stats-grid">{[
          { label: 'Execuções recentes', value: runs.length, detail: 'Sua sessão · domínio selecionado' },
          { label: 'Latência média', value: averageLatency, detail: 'Execuções recentes concluídas' },
          { label: 'Tokens utilizados', value: runs.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0).toLocaleString('pt-BR'), detail: 'Reportados pelo provedor' },
          { label: 'Abstenções', value: runs.filter(r => r.status === 'abstained').length, detail: 'Consultas sem resposta validada' }
        ].map(s => <div className="stat-card" key={s.label}><div><span>{s.label}</span><Activity size={16} /></div><strong>{s.value}</strong><small>{s.detail}</small></div>)}</div><section className="panel"><div className="panel-heading"><div><h3>Execuções do orquestrador</h3><p>Até 100 consultas recentes do seu usuário neste domínio.</p></div><button className="text-button" onClick={() => void refresh().catch(e => setError(e.message))}>Atualizar <Activity size={14} /></button></div>{!runs.length ? <Empty icon={Activity} title="Rastreabilidade começa na primeira pergunta" text="Latência, tokens, fontes e etapas serão registrados quando você consultar a base." action={<button className="button secondary" onClick={() => navigate('chat')}>Abrir chat <ArrowRight size={15} /></button>} /> : <div className="run-list">{runs.map(run => <details key={run.id} className="run-row"><summary><span className="run-icon"><GitBranch size={16} /></span><span><strong>{run.question}</strong><small>{date(run.createdAt)} · {run.mode === 'model' ? run.model : 'Recuperação sem IA'}</small></span><Pill tone={run.status === 'completed' ? 'green' : 'amber'}>{run.status === 'completed' ? 'Concluído' : 'Abstenção'}</Pill><span>{(run.durationMs / 1000).toFixed(2)} s</span></summary><div className="run-expanded">{run.steps.map((s, i) => <div key={i}><CheckCircle2 size={14} /><strong>{s.name}</strong><p>{s.detail}</p><time>{s.ms} ms</time></div>)}<p>{run.sources.length} fontes · {run.inputTokens} tokens de entrada · {run.outputTokens} de saída · Avaliação: {run.feedback === 1 ? 'Útil' : run.feedback === -1 ? 'Não útil' : 'Pendente'}</p></div></details>)}</div>}</section>{isAdmin && <section className="panel audit-panel"><div className="panel-heading"><div><h3>Auditoria</h3><p>Últimos 100 eventos administrativos, sem conteúdo dos documentos.</p></div><ShieldCheck size={19} /></div>{!audit.length ? <div className="muted audit-empty">Nenhum evento registrado.</div> : <div className="table-wrap"><table><thead><tr><th>EVENTO</th><th>ATOR</th><th>DATA</th></tr></thead><tbody>{audit.map(a => <tr key={a.id}><td><code>{a.action}</code></td><td>{a.actor}</td><td>{date(a.created_at)}</td></tr>)}</tbody></table></div>}</section>}</>}
        {page === 'neural' && <NeuralExplorer canReindex={allowedWrite} data={neuralMap} error={neuralError} onRetry={loadNeuralMap} iconMap={iconMap} onOpen={id => { setDomain(id); navigate('knowledge'); }} />}
        {page === 'settings' && <div className="settings-grid"><section className="panel"><div className="panel-heading"><div><h3>Provedor de inteligência</h3><p>As chaves são configuradas no arquivo .env do servidor.</p></div><BrainCircuit size={22} /></div><div className="settings-content"><div className="setting-row"><span>Geração de respostas</span><Pill tone={status?.generation ? 'green' : 'amber'}>{status?.generation ? 'Configurado' : 'Aguardando provedor e modelo'}</Pill></div><div className="setting-row"><span>Embeddings semânticos</span><Pill tone={status?.embeddings ? 'green' : 'amber'}>{status?.embeddings ? 'Configurado' : 'Busca lexical ativa'}</Pill></div><div className="setting-row"><span>Provedor selecionado</span><strong>{status?.provider === 'ollama' ? 'Ollama' : status?.provider === 'anthropic' ? 'Anthropic' : 'API compatível'}</strong></div><p>Preencha as variáveis abaixo em <code>C:\Users\glauco.almeida\Documents\LUMINA\.env</code> e reinicie o servidor.</p><pre>{'LLM_BASE_URL=https://seu-provedor/v1\nLLM_API_KEY=\nLLM_MODEL=\nEMBEDDING_MODEL='}</pre><details><summary>Usar um modelo local com Ollama</summary><p>Instale e inicie o Ollama, baixe um modelo compatível com JSON e informe o nome instalado:</p><pre>{'LLM_PROVIDER=ollama\nOLLAMA_BASE_URL=http://127.0.0.1:11434/v1\nLLM_MODEL=nome-do-modelo-instalado'}</pre><p>Não exige chave paga nem muda automaticamente para um provedor em nuvem.</p></details><p className="muted">Geração e embeddings podem usar provedores diferentes. O endpoint de geração precisa retornar JSON. A indexação vetorial é configurada separadamente.</p></div></section><section className="panel"><div className="panel-heading"><h3>Ambiente e identidade</h3><ShieldCheck size={22} /></div><div className="settings-content"><div className="setting-row"><span>Versão</span><strong>{status?.version}</strong></div><div className="setting-row"><span>Armazenamento</span><strong>{status?.storage}</strong></div><div className="setting-row"><span>Autenticação</span><strong>{status?.authMode === 'local' ? 'Desenvolvimento local' : 'OIDC / Keycloak'}</strong></div><div className="inline-note"><ShieldCheck size={19} /><p>{status?.authMode === 'local' ? 'O modo local é para testes nesta máquina. Para publicação, configure OIDC, HTTPS e permissões de domínio.' : 'Seu acesso é validado por identidade, papel e domínio.'}</p></div><p>Configuração de integrações:</p><pre>{'MCP_SERVERS_JSON=[]\nDATABASE_URL=\nREDIS_URL=\nS3_ENDPOINT=\nOTEL_EXPORTER_OTLP_ENDPOINT='}</pre></div></section><section className="panel full-width"><div className="panel-heading"><h3>O que está disponível nesta versão</h3><Layers3 size={21} /></div><div className="capability-list"><div><CheckCircle2 size={17} /><span>Documentos, busca lexical, fontes, pipeline, auditoria e fluxo LangGraph funcionam localmente.</span></div><div><CheckCircle2 size={17} /><span>Geração, embeddings e verificação por IA dependem do provedor configurado. PostgreSQL, Redis, S3, OIDC e MCP têm adaptadores.</span></div><div><Clock3 size={17} /><span>OCR, banco de grafos, regras específicas dos domínios, execução de ações externas e avaliação humana são extensões futuras.</span></div></div></section></div>}
        <footer className="footer"><span><img src="/lumina.svg" alt="" />LUMINA <i /> Conhecimento com origem. Decisões com contexto.</span><span>MODULAR · RASTREÁVEL · INSTITUCIONAL</span></footer>
      </main>
    </div>
    {error && <div className="toast error" role="alert"><AlertCircle size={19} /><span>{error}</span><button className="icon-button" aria-label="Fechar erro" onClick={() => setError('')}><X size={17} /></button></div>}
    {notice && <div className="toast success" role="status"><CheckCircle2 size={18} />{notice}</div>}
    {uploadOpen && <div className="modal-backdrop" onClick={() => !uploadBusy && setUploadOpen(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title" onClick={e => e.stopPropagation()}><div className="panel-heading"><div><h2 id="upload-title">Adicionar conhecimento</h2><p>{activeDomain?.name}</p></div><button className="icon-button" aria-label="Fechar" disabled={uploadBusy} onClick={() => setUploadOpen(false)}><X size={20} /></button></div><label className={'dropzone ' + (uploadBusy ? 'busy' : '')} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void upload(e.dataTransfer.files[0]); }}><span><Upload size={29} /></span><strong>{uploadBusy ? 'Recebendo seu documento...' : 'Arraste um arquivo até aqui'}</strong><p>ou clique para selecionar no computador</p><small>TXT, MD, CSV, JSON, PDF, DOCX, XLSX · Até 50 MB</small><input type="file" aria-label="Selecionar documento" accept=".txt,.md,.csv,.json,.pdf,.docx,.xlsx" disabled={uploadBusy} onChange={e => void upload(e.target.files?.[0])} /></label><WebSources key={domain} domain={domain} allowed={Boolean(allowedWrite)} onChange={() => void refresh().catch(e => setError(e.message))} onOpen={id => { setUploadOpen(false); setOfflineId(id); }} /><div className="modal-info"><ShieldCheck size={17} /><p>O documento ficará disponível apenas no domínio selecionado. PDFs sem texto extraível serão sinalizados no pipeline.</p></div></section></div>}
    {offlineId && <OfflineReader key={offlineId + domain} id={offlineId} domain={domain} onClose={() => setOfflineId(undefined)} />}
    {confirmDelete && <div className="modal-backdrop"><section className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title"><h2 id="delete-title">Excluir documento?</h2><p>O arquivo original e seus trechos serão removidos da base. Respostas anteriores permanecem no histórico de consultas.</p><div className="modal-actions"><button className="button secondary" onClick={() => setConfirmDelete(undefined)}>Cancelar</button><button className="button danger" onClick={() => void removeDocument(confirmDelete)}>Excluir documento</button></div></section></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
