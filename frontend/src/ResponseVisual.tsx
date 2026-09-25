import { ChartNoAxesCombined } from 'lucide-react';
import { useEffect, useState } from 'react';

type Point = { x: number; y: number };
type FunctionSpec = { name: string; expression: string; label: string; color: string };
type Curve = { points: Point[]; color: string };
const width = 520, height = 250;
const allowedExpression = /^[0-9a-zA-Z_+\-*/^().,\s]+$/;
const colors = ['#4d7cff', '#ef554d', '#161616', '#d8a85d', '#78d5bf'];

function normalizeExpression(value: string) {
  return value.replaceAll('²', '^2').replaceAll('³', '^3').replaceAll('−', '-').replaceAll('\n', ' ').replace(/\s+/g, ' ').replace(/\|([^|]+)\|/g, 'abs($1)').replace(/\bx\s*([23])\b/gi, 'x^$1').replace(/\bsen\b/gi, 'sin').replace(/\bln\b/gi, 'log');
}
function extractFunctions(answer: string): FunctionSpec[] {
  const matches = [...answer.matchAll(/(?:([a-z])\s*\(\s*x\s*\)|\b(y)\b)\s*=\s*([^\n.;]+)/gi)];
  const specs = matches.map((match, index) => {
    const name = (match[1] ?? match[2]).toLowerCase();
    const raw = match[3].trim().split(/\s+(?:é|e|onde|para|que|com|no|na|pode|refletindo|obtida|representa|então|logo)\b/i)[0].replace(/[,;:]+$/, '').trim();
    const composition = raw.match(/^\(\s*([a-z])\s*(?:o|∘)\s*([a-z])\s*\)\s*\(\s*x\s*\)$/i);
    const expression = normalizeExpression(composition ? `${composition[1]}(${composition[2]}(x))` : raw).replace(/\bx\s*x\b/gi, 'x^2');
    return { name, expression, label: raw, color: colors[index % colors.length] };
  }).filter(item => item.expression.length <= 100 && allowedExpression.test(item.expression) && !/(?:import|evaluate|function|parse|compile)/i.test(item.expression));
  const absolute = specs.find(item => item.expression.startsWith('abs('));
  if (absolute) {
    const baseExpression = absolute.expression.slice(4, -1);
    specs.splice(specs.indexOf(absolute), 0, { name: absolute.name + '-base', expression: baseExpression, label: baseExpression, color: '#ef554d' });
    absolute.color = '#4d7cff';
  }
  return specs;
}
function curveSegments(expression: string, compile: (value: string) => { evaluate(scope: Record<string, unknown>): unknown }, scope: Record<string, unknown>) {
  const compiled = compile(expression), segments: Point[][] = [];
  let current: Point[] = [];
  const xMin = expression.includes('32') ? -20 : -5;
  const xMax = expression.includes('32') ? 220 : 5;
  for (let index = 0; index <= 320; index += 1) {
    const x = xMin + (xMax - xMin) * index / 320;
    let y = Number.NaN;
    try { y = Number(compiled.evaluate({ ...scope, x })); } catch { /* Invalid points split the curve. */ }
    const valid = Number.isFinite(y) && Math.abs(y) < 100000;
    if (!valid) { if (current.length > 1) segments.push(current); current = []; continue; }
    current.push({ x, y });
  }
  if (current.length > 1) segments.push(current);
  return segments;
}
function curvePath(points: Point[], bounds: { xMin: number; xMax: number; yMin: number; yMax: number }) {
  return points.map((point, index) => {
    const x = ((point.x - bounds.xMin) / (bounds.xMax - bounds.xMin)) * width;
    const y = height - ((Math.max(bounds.yMin, Math.min(bounds.yMax, point.y)) - bounds.yMin) / (bounds.yMax - bounds.yMin)) * height;
    return `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}
function FunctionPlot({ specs }: { specs: FunctionSpec[] }) {
  const [segments, setSegments] = useState<Curve[]>();
  const signature = specs.map(spec => `${spec.name}:${spec.expression}`).join('|');
  const [bounds, setBounds] = useState({ xMin: -5, xMax: 5, yMin: -5, yMax: 5 });
  useEffect(() => {
    let active = true;
    setSegments(undefined);
    void import('mathjs').then(({ all, create }) => {
      try {
        const engine = create(all);
        const functions: Record<string, (value: number) => number> = {};
        const scope: Record<string, unknown> = {};
        for (const spec of specs) {
          const compiled = engine.compile(spec.expression);
          functions[spec.name] = (value: number) => Number(compiled.evaluate({ ...functions, ...scope, x: value }));
          scope[spec.name] = functions[spec.name];
        }
        const next = specs.flatMap(spec => curveSegments(spec.expression, value => engine.compile(value), scope).map(points => ({ points, color: spec.color })));
        const points = next.flatMap(curve => curve.points);
        if (!points.length) { if (active) setSegments([]); return; }
        const xMin = Math.min(...points.map(point => point.x)), xMax = Math.max(...points.map(point => point.x));
        const rawMin = Math.min(...points.map(point => point.y)), rawMax = Math.max(...points.map(point => point.y));
        const padding = Math.max((rawMax - rawMin) * .12, 1);
        if (active) { setBounds({ xMin, xMax, yMin: rawMin - padding, yMax: rawMax + padding }); setSegments(next.flat()); }
      } catch { if (active) setSegments([]); }
    }).catch(() => { if (active) setSegments([]); });
    return () => { active = false; };
  }, [signature]);
  const xAxis = height - ((0 - bounds.yMin) / (bounds.yMax - bounds.yMin)) * height;
  const yAxis = ((0 - bounds.xMin) / (bounds.xMax - bounds.xMin)) * width;
  return <div className="math-plot" aria-label="Gráfico das funções identificadas" style={{ maxWidth: 560, margin: '18px 0', padding: '14px 16px', border: '1px solid #78d5bf30', borderRadius: 8, background: '#101d25' }}>
    <div className="math-plot-heading" style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#a9e6d5', fontSize: 12, marginBottom: 10 }}><ChartNoAxesCombined size={16} /><span>Gráficos das funções</span></div>
    <div className="response-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 15px', marginBottom: 10, color: '#c8d8dc', fontSize: 11 }}>{specs.map(spec => <span key={spec.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><i style={{ width: 9, height: 9, borderRadius: '50%', background: spec.color }} />{spec.name}(x) = {spec.label}</span>)}</div>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" style={{ display: 'block', width: '100%', aspectRatio: `${width} / ${height}`, height: 'auto' }}><line x1="0" y1={xAxis} x2={width} y2={xAxis} className="plot-axis" /><line x1={yAxis} y1="0" x2={yAxis} y2={height} className="plot-axis" />{segments?.map((curve, index) => <path key={index} d={curvePath(curve.points, bounds)} className="plot-line" style={{ stroke: curve.color, strokeDasharray: curve.color === '#ef554d' ? '9 8' : undefined }} />)}<text x={width - 14} y={Math.max(14, xAxis - 8)} className="plot-label">x</text><text x={Math.min(width - 14, yAxis + 8)} y={14} className="plot-label">y</text></svg>
    <small>Escala ajustada automaticamente à função · x: {bounds.xMin.toFixed(0)} a {bounds.xMax.toFixed(0)}</small>
  </div>;
}
export function ResponseVisual({ answer }: { answer: string }) {
  const specs = extractFunctions(answer);
  return specs.length ? <FunctionPlot specs={specs} /> : null;
}
