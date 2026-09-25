import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { plan } from '../agents/planner.js';
import { retrieve } from '../rag/retrieval.js';
import { answerInstructions, answerSchema, formatCitedAnswer, validCitations } from '../llmops/evidence.js';
import { generate } from '../llmops/provider.js';
import { config, generationEnabled } from '../../gateway/config.js';
import type { Store } from '../../data/storage/database.js';
import type { ComparativeFinding, ConversationTurn, Evidence, Principal, Run, RunReview, TraceStep } from '../types.js';
import { mergeEvidence } from '../rag/retrieval.js';
import { contextualizeQuestion, conversationPrompt, isAnswerCorrection, relevantMemories } from './context.js';
import { socialReply } from './dialogue.js';
import { canonicalizeConfusables, sanitizeUntrustedText } from '../../data/processing/text.js';
import { reviewAnswer } from '../llmops/review.js';
import { evaluateRun } from '../llmops/evaluation.js';
import { answerGroundedness, answerReviews } from '../../observability/telemetry.js';
const needsStructuredAnalysis = (question: string) => /\b(compare|comparar|comparação|confront|relação|relacione|cruz|cruze|diferen[çc]a|diverg|converg|s[íi]ntese|resum|explique|detalh|risco|causa|consequ[êe]ncia|impacto|pontos? (em comum|distint)|entre .*document)/iu.test(question);
const comparisonRequested = (question: string) => /\b(compare|comparar|comparação|confront|relação entre|relacione|cruz|cruze|diferen[çc]a|diverg|converg|pontos? (em comum|distint)|entre .*document)/iu.test(question);
const State = Annotation.Root({
  queries: Annotation<string[]>(), sources: Annotation<Evidence[]>(), answer: Annotation<string>(),
  citations: Annotation<number[]>(), accepted: Annotation<boolean>(), attempts: Annotation<number>(),
  findings: Annotation<ComparativeFinding[]>(), comparison: Annotation<boolean>(), abstain: Annotation<boolean>(), review: Annotation<RunReview | undefined>(), inputTokens: Annotation<number>(), outputTokens: Annotation<number>()
});
export async function orchestrate(store: Store, principal: Principal, question: string, domain: string, agent: boolean, history: ConversationTurn[] = [], conversationId?: string, onStep?: (step: TraceStep) => void): Promise<Run> {
  const start = Date.now(), runId = crypto.randomUUID(), steps: TraceStep[] = [];
  let tick = start;
  function step(name: string, detail: string) {
    const now = Date.now(); const item = { name, detail, ms: now - tick };
    steps.push(item); onStep?.(item); tick = now;
  }
  const llm = generationEnabled();
  const greeting = socialReply(question);
  if (greeting) {
    step('Conversar', 'Interação social; nenhuma afirmação documental ou chamada ao provedor.');
    const run: Run = { id: crypto.randomUUID(), owner: principal.id, domain, conversationId, question, createdAt: new Date().toISOString(), answer: greeting, sources: [], steps, mode: 'extractive', status: 'completed', durationMs: Date.now() - start, inputTokens: 0, outputTokens: 0 };
    await store.saveRun(run); await store.audit(principal.id, 'query.completed', run.id);
    return run;
  }
  const normalizedQuestion = canonicalizeConfusables(sanitizeUntrustedText(question));
  const correction = isAnswerCorrection(normalizedQuestion);
  const contextualQuery = contextualizeQuestion(normalizedQuestion, history);
  const conversationContext = conversationPrompt(history, normalizedQuestion);
  const documentNames = typeof store.documents === 'function' ? (await store.documents(domain)).map(document => document.name) : [];
  const researchMemory = typeof store.memories === 'function' ? await store.memories(principal.id, domain) : [];
  const memoryContext = relevantMemories(contextualQuery, researchMemory).map(memory => `Pergunta: ${memory.question}\nResposta anterior: ${memory.answer}`);
  const workflow = new StateGraph(State)
    .addNode('plan', async () => {
      const structured = agent || needsStructuredAnalysis(normalizedQuestion);
      const p = await plan(contextualQuery, structured, documentNames, memoryContext);
      const queries = [...new Set([contextualQuery, ...p.queries])].slice(0, 5);
      step('Planejar', structured ? queries.length + ' consulta(s); análise estruturada restrita à base autorizada. ' + JSON.stringify(queries) : 'Consulta documental direta.');
      return { queries, comparison: comparisonRequested(normalizedQuestion), inputTokens: p.inputTokens, outputTokens: p.outputTokens, attempts: 0 };
    })
    .addNode('retrieve', async state => {
      const primary = await retrieve(store, state.queries[0], domain);
      const batches = [primary, ...(await Promise.all(state.queries.slice(1).map(query => retrieve(store, query, domain))))];
      const sources = mergeEvidence(batches, 10);
      step('Recuperar', sources.length + ' trecho(s) de ' + new Set(sources.map(source => source.documentId)).size + ' documento(s) no domínio ' + domain + '. Consultas: ' + state.queries.length + '. Documentos: ' + [...new Set(sources.map(source => source.title))].join(' | '));
      return { sources };
    })
    .addNode('generate', async state => {
      if (!state.sources.length) {
        step('Responder', 'Abstenção: nenhuma evidência relevante.');
        return { answer: 'Não encontrei evidências suficientes nos documentos deste domínio para responder. Adicione uma fonte ou reformule a pergunta.', abstain: true, citations: [], accepted: true };
      }
      if (!llm) {
        step('Responder', 'Modo sem chave: trechos recuperados, sem síntese por IA.');
        return { answer: 'Encontrei estes trechos na base de conhecimento. A síntese por IA ficará disponível após configurar o provedor.\n\n' + state.sources.slice(0, 3).map((s, i) => '[' + (i + 1) + '] ' + s.text).join('\n\n'), citations: state.sources.slice(0, 3).map((_, i) => i + 1), findings: [], abstain: false, accepted: true };
      }
      const result = await generate([
        { role: 'system', content: answerInstructions },
        { role: 'user', content: JSON.stringify({ question: contextualQuery, userMessage: normalizedQuestion, feedbackMode: correction, conversation: conversationContext, researchMemory: memoryContext, sources: state.sources.map((s, i) => ({ citation: i + 1, documentId: s.documentId, document: s.title, passage: s.chunk, page: s.page, text: s.text })), retry: state.attempts > 0 ? 'A resposta anterior falhou na verificação de evidências. Use apenas afirmações diretamente sustentadas.' : undefined }) }
      ], 4000);
      const parsed = answerSchema.safeParse(result.data);
      step('Gerar', 'Resposta estruturada recebida; aguardando verificação.');
      const answer = parsed.success && parsed.data.citations.length
        ? formatCitedAnswer(parsed.data.answer, parsed.data.citations)
        : parsed.success ? parsed.data.answer : '';
      return { answer, citations: parsed.success ? parsed.data.citations : [], findings: parsed.success ? parsed.data.findings : [], abstain: parsed.success ? parsed.data.abstain : false, accepted: false, attempts: state.attempts + 1, inputTokens: state.inputTokens + result.inputTokens, outputTokens: state.outputTokens + result.outputTokens };
    })
    .addNode('judge', async state => {
      if (state.accepted || state.abstain) {
        step('Verificar', state.abstain ? 'Abstenção preservada.' : 'Trechos literais com origem identificada.');
        return { accepted: true };
      }
      const inline = [...state.answer.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
      if (!validCitations(state.citations, state.sources.length) || !inline.length || inline.some(n => !state.citations.includes(n))) {
        step('Verificar', 'Citações ausentes ou inválidas.');
        return { accepted: false };
      }
      const documentIds = new Set(state.sources.map(source => source.documentId));
      const completeFindings = state.findings.filter(finding => validCitations([finding.leftCitation, finding.rightCitation], state.sources.length)
        && state.sources[finding.leftCitation - 1].documentId !== state.sources[finding.rightCitation - 1].documentId);
      if (state.comparison && (documentIds.size < 2 || !completeFindings.length)) {
        step('Verificar', 'Cobertura comparativa insuficiente: ' + documentIds.size + ' documento(s), ' + completeFindings.length + ' confronto(s) verificável(is).');
        return { accepted: false };
      }
      const review = await reviewAnswer(normalizedQuestion, state.answer, state.citations, state.sources, runId);
      const accepted = review.verdict === 'pass';
      step('Verificar', accepted ? 'Revisor independente aceitou todas as afirmações.' : `Revisor independente: ${review.verdict}; cobertura ${(review.coverage * 100).toFixed(0)}%.`);
      return { accepted, review };
    })
    .addEdge(START, 'plan').addEdge('plan', 'retrieve').addEdge('retrieve', 'generate').addEdge('generate', 'judge')
    .addConditionalEdges('judge', state => state.accepted || state.attempts >= 2 ? END : 'generate');
  const graph = workflow.compile();
  const result = await graph.invoke({ queries: [], sources: [], answer: '', citations: [], findings: [], comparison: false, accepted: false, attempts: 0, abstain: false, review: undefined, inputTokens: 0, outputTokens: 0 }, { recursionLimit: 12 });
  const abstained = result.abstain || !result.accepted;
  const reviewReason = !result.accepted && result.review?.claims.length
    ? '\n\nMotivo da revisão: ' + result.review.claims.filter(claim => claim.verdict !== 'pass').slice(0, 2).map(claim => claim.reason).join(' | ')
    : '';
  const run: Run = {
    id: runId, owner: principal.id, domain, conversationId, question, createdAt: new Date().toISOString(),
    answer: result.accepted ? result.answer : 'Não foi possível validar uma resposta com as evidências disponíveis. Consulte as fontes ou reformule a pergunta.' + reviewReason,
    sources: result.sources, steps, mode: llm ? 'model' : 'extractive', review: result.review, workflow: 'document-answer-v1',
    status: abstained ? 'abstained' : 'completed', durationMs: Date.now() - start,
    model: llm ? config.LLM_MODEL : undefined, inputTokens: result.inputTokens, outputTokens: result.outputTokens
  };
  await store.saveRun(run);
  const evaluation = evaluateRun(run);
  await store.saveEvaluation?.(evaluation);
  if (run.review) { await store.saveReview?.(run.review); answerReviews.inc({ verdict: run.review.verdict }); answerGroundedness.observe(run.review.coverage); }
  if (run.status === 'completed' && run.sources.length && typeof store.saveMemory === 'function') {
    await store.saveMemory({ id: run.id, owner: run.owner, domain: run.domain, question: run.question, answer: run.answer, sourceIds: run.sources.map(source => source.id), createdAt: run.createdAt, state: 'candidate', confidence: run.review?.coverage ?? 0 });
  }
  await store.audit(principal.id, 'query.' + run.status, run.id);
  return run;
}
