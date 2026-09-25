import { Activity, BarChart3, Cpu, Database, Gauge, GraduationCap, TrendingUp } from 'lucide-react';
import type { Run } from '../../core/types';

type Domain = { id: string; name: string; color: string };
type NeuralMap = { domains: { id: string; documents: number; chunks: number }[] };

function MiniBars({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  return <div className="metric-bars" aria-label="Gráfico de barras"><div className="metric-bars-grid" />{values.map((value, index) => <span key={index} style={{ height: `${Math.max(4, value / max * 100)}%` }} title={String(value)} />)}</div>;
}
function LineChart({ values }: { values: number[] }) {
  const max = Math.max(...values, 1), width = 520, height = 170;
  const points = values.map((value, index) => `${(index / Math.max(values.length - 1, 1) * width).toFixed(1)},${(height - value / max * 135).toFixed(1)}`).join(' ');
  return <svg className="metric-line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Projeção de consumo"><polyline points={points} fill="none" stroke="#d8a85d" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /><line x1="0" y1="145" x2={width} y2="145" stroke="#ffffff20" /></svg>;
}
export function MetricsDashboard({ runs, domains, neuralMap }: { runs: Run[]; domains: Domain[]; neuralMap?: NeuralMap }) {
  const totalTokens = runs.reduce((sum, run) => sum + run.inputTokens + run.outputTokens, 0);
  const avgLatency = runs.length ? runs.reduce((sum, run) => sum + run.durationMs, 0) / runs.length / 1000 : 0;
  const byDomain = domains.map(domain => ({ ...domain, tokens: runs.filter(run => run.domain === domain.id).reduce((sum, run) => sum + run.inputTokens + run.outputTokens, 0) })).filter(item => item.tokens > 0);
  const dayValues = Array.from({ length: 7 }, (_, index) => { const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - (6 - index)); return runs.filter(run => new Date(run.createdAt).toDateString() === day.toDateString()).reduce((sum, run) => sum + run.inputTokens + run.outputTokens, 0); });
  const dailyAverage = dayValues.reduce((sum, value) => sum + value, 0) / 7;
  const projection = [dailyAverage, dailyAverage * 7, dailyAverage * 30, dailyAverage * 90];
  const documents = neuralMap?.domains.reduce((sum, item) => sum + item.documents, 0) ?? 0;
  const chunks = neuralMap?.domains.reduce((sum, item) => sum + item.chunks, 0) ?? 0;
  return <div className="metrics-page"><div className="metrics-intro"><div><div className="eyebrow"><span /> TELEMETRIA OPERACIONAL</div><h2>Escalabilidade sem adivinhação.</h2><p>Consumo observado nesta sessão e nos módulos que você pode acessar.</p></div><button className="icon-button" aria-label="Atualizar métricas" title="Atualizar métricas" onClick={() => location.reload()}><Activity size={18} /></button></div>
    <div className="stats-grid metrics-stats">{[
      { label: 'Tokens observados', value: totalTokens.toLocaleString('pt-BR'), detail: 'Entrada + saída', icon: BarChart3 }, { label: 'Média por consulta', value: runs.length ? Math.round(totalTokens / runs.length).toLocaleString('pt-BR') : '—', detail: 'Tokens por execução', icon: Gauge }, { label: 'Latência média', value: avgLatency ? `${avgLatency.toFixed(1)} s` : '—', detail: 'Consultas registradas', icon: TrendingUp }, { label: 'Base processada', value: `${documents.toLocaleString('pt-BR')} docs`, detail: `${chunks.toLocaleString('pt-BR')} trechos`, icon: Database }
    ].map(item => <div className="stat-card" key={item.label}><div><span>{item.label}</span><item.icon size={16} /></div><strong>{item.value}</strong><small>{item.detail}</small></div>)}</div>
    <div className="metrics-grid"><section className="panel metric-panel"><div className="panel-heading"><div><h3>Tokens por módulo</h3><p>Consumo acumulado nas consultas registradas.</p></div><BarChart3 size={19} /></div>{byDomain.length ? <div className="module-bars">{byDomain.map(item => <div key={item.id}><div><span>{item.name}</span><strong>{item.tokens.toLocaleString('pt-BR')}</strong></div><div className="module-track"><i style={{ width: `${Math.max(3, item.tokens / Math.max(...byDomain.map(value => value.tokens)) * 100)}%`, background: item.color }} /></div></div>)}</div> : <p className="metric-empty">Ainda não há consultas suficientes para distribuir consumo por módulo.</p>}</section>
      <section className="panel metric-panel"><div className="panel-heading"><div><h3>Consumo diário</h3><p>Últimos sete dias, com base no histórico disponível.</p></div><Activity size={19} /></div><MiniBars values={dayValues} /><div className="metric-axis"><span>6 dias atrás</span><span>Hoje</span></div></section>
      <section className="panel metric-panel projection-panel"><div className="panel-heading"><div><h3>Projeção de longo prazo</h3><p>Extrapolação simples da média diária observada.</p></div><TrendingUp size={19} /></div><LineChart values={projection} /><div className="projection-labels">{['1 dia', '7 dias', '30 dias', '90 dias'].map((label, index) => <span key={label}>{label}<br /><strong>{Math.round(projection[index]).toLocaleString('pt-BR')}</strong></span>)}</div></section>
      <section className="panel metric-panel metric-limitations"><div className="panel-heading"><div><h3>Treinamento e hardware</h3><p>Pronto para receber telemetria dedicada.</p></div><Cpu size={19} /></div><div className="metric-not-instrumented"><GraduationCap size={24} /><div><strong>Dados ainda não instrumentados</strong><p>Tokens de treinamento, uso de CPU/GPU/RAM, temperatura e custo por provedor não são retornados pelo contrato atual. A plataforma já registra a camada de inferência e pode receber esses medidores em seguida.</p></div></div></section>
    </div></div>;
}
