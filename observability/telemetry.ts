import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { config } from '../gateway/config.js';
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'lumina_' });
export const requests = new Counter({ name: 'lumina_http_requests_total', help: 'HTTP requests', labelNames: ['method', 'route', 'status'], registers: [registry] });
export const latency = new Histogram({ name: 'lumina_query_seconds', help: 'Query duration', buckets: [0.1, 0.5, 1, 3, 10, 30, 90], registers: [registry] });
export const knowledgeJobs = new Counter({ name: 'lumina_knowledge_jobs_total', help: 'Background knowledge job outcomes', labelNames: ['kind', 'outcome'], registers: [registry] });
export const knowledgeDuration = new Histogram({ name: 'lumina_knowledge_job_seconds', help: 'Background knowledge batch duration', labelNames: ['kind'], registers: [registry] });
export const answerReviews = new Counter({ name: 'lumina_answer_reviews_total', help: 'Answer review outcomes', labelNames: ['verdict'], registers: [registry] });
export const answerGroundedness = new Histogram({ name: 'lumina_answer_groundedness', help: 'Groundedness coverage per answer', buckets: [0, .25, .5, .75, .9, 1], registers: [registry] });
export const memoryDecisions = new Counter({ name: 'lumina_memory_decisions_total', help: 'Governed memory decisions', labelNames: ['state'], registers: [registry] });
let provider: NodeTracerProvider | undefined;
if (config.OTEL_EXPORTER_OTLP_ENDPOINT) {
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url: config.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '') + '/v1/traces' }))] });
  provider.register();
}
export async function traced<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return trace.getTracer('lumina').startActiveSpan(name, async span => {
    try { const result = await fn(); span.setStatus({ code: SpanStatusCode.OK }); return result; }
    catch (e) { span.setStatus({ code: SpanStatusCode.ERROR }); throw e; }
    finally { span.end(); }
  });
}
export async function stopTelemetry() { await provider?.shutdown(); }
