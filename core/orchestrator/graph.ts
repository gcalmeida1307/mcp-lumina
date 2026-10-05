import { Annotation, StateGraph, START, END } from '@langchain/langgraph';

import { plan } from '../agents/planner.js';

import { retrieve, mergeEvidence } from '../rag/retrieval.js';
import { mentionedDocuments, contentQuery, planningExcerpts } from '../rag/document-scope.js';

import { answerInstructions, answerSchema, extractInlineCitations, validCitations } from '../llmops/evidence.js';

import { generate, configuredModels } from '../llmops/provider.js';

import { interpret } from './interpreter.js';

import { executeCognitive, evidenceWindow } from './cognitive.js';

import { describeDocument } from '../resources.js';

import { createInvestigation, accumulateEvidence, type InvestigationState } from './investigation.js';

import { reviewAnswer } from '../llmops/review.js';

import { generalKnowledgeAnswer, generalKnowledgeNotice, isTimeout } from '../llmops/general.js';

import { evaluateRun } from '../llmops/evaluation.js';

import { config, generationEnabled } from '../../gateway/config.js';

import type { Store } from '../../data/storage/database.js';

import type { ComparativeFinding, ConversationTurn, Evidence, Principal, Run, RunReview, TraceStep } from '../types.js';

import { contextualizeQuestion, conversationPrompt, isAnswerCorrection, relevantMemories } from './context.js';

import { socialReply } from './dialogue.js';

import { routeMessage } from './taskRouter.js';

import { canonicalizeConfusables, sanitizeUntrustedText } from '../../data/processing/text.js';

import { answerGroundedness, answerReviews } from '../../observability/telemetry.js';



/**

 * Definição explícita do TaskType para compatibilidade e segurança de tipos.

 */

export type TaskType = 'lookup' | 'explain' | 'compare' | 'analyze' | 'investigate' | 'continue' | 'correction';

// A slow provider must degrade to the retrieved passages instead of failing the whole query.
async function generateOrTimeout(...args: Parameters<typeof generate>) {
  try { return await generate(...args); }
  catch (error) { if (isTimeout(error)) return undefined; throw error; }
}



/**

 * Compatibilidade temporária com a arquitetura anterior.

 *

 * O Task Router passa a ser a principal fonte de decisão sobre

 * necessidade de planejamento estruturado.

 *

 * Esta heurística continua existindo como fallback durante

 * a migração da arquitetura.

 */

const needsStructuredAnalysis = (question: string) => /\b(compare|comparar|comparação|confront|relação|relacione|cruz|cruze|diferen[çc]a|diverg|converg|s[íi]ntese|resum|explique|detalh|risco|causa|consequ[êe]ncia|impacto|pontos? (em comum|distint)|entre .*document)/iu.test(question);



/**

 * Mantido temporariamente para compatibilidade com o judge atual.

 *

 * Futuramente esta responsabilidade deverá vir do InvestigationPlan.

 */

const comparisonRequested = (question: string) => /\b(compare|comparar|comparação|confront|relação entre|relacione|cruz|cruze|diferen[çc]a|diverg|converg|pontos? (em comum|distint)|entre .*document)/iu.test(question);



/**

 * Estado interno do LangGraph.

 *

 * Atualizado para acomodar o contexto semântico retornado pelo Task Router.

 */

const State = Annotation.Root({

  investigation: Annotation<InvestigationState>(),

  queries: Annotation<string[]>(),

  sources: Annotation<Evidence[]>(),

  answer: Annotation<string>(),

  citations: Annotation<number[]>(),

  accepted: Annotation<boolean>(),

  attempts: Annotation<number>(),

  findings: Annotation<ComparativeFinding[]>(),

  comparison: Annotation<boolean>(),

  abstain: Annotation<boolean>(),

  review: Annotation<RunReview | undefined>(),

  validationError: Annotation<string | undefined>(),

  inputTokens: Annotation<number>(),

  outputTokens: Annotation<number>(),

  // Contexto expandido do Task Router (LUMINA CORE Alignment)

  task: Annotation<TaskType>(),

  objective: Annotation<string | undefined>(),

  focus: Annotation<string | undefined>(),

  preserveState: Annotation<boolean>()

});



export async function orchestrate(

  store: Store,

  principal: Principal,

  question: string,

  domain: string,

  agent: boolean,

  history: ConversationTurn[] = [],

  conversationId?: string,

  onStep?: (step: TraceStep) => void

): Promise<Run> {

  const start = Date.now();

  const runId = crypto.randomUUID();

  const steps: TraceStep[] = [];

  let tick = start;



  /**

   * Registra observabilidade do workflow.

   */

  function step(name: string, detail: string) {

    const now = Date.now();

    const item = {

      name,

      detail,

      ms: now - tick

    };

    steps.push(item);

    onStep?.(item);

    tick = now;

  }

  const llm = generationEnabled();



  /*

   * ============================================================

   * SOCIAL FAST PATH

   * ============================================================

   *

   * Mantemos o mecanismo existente.

   *

   * "Bom dia", "Olá" etc. não precisam passar pelo RAG.

   */

  const greeting = socialReply(question);

  if (greeting) {

    step('Conversar', 'Interação social; nenhuma afirmação documental ou chamada ao provedor.');

    const run: Run = {

      id: crypto.randomUUID(),

      owner: principal.id,

      domain,

      conversationId,

      question,

      createdAt: new Date().toISOString(),

      answer: greeting,

      sources: [],

      steps,

      mode: 'extractive',

      status: 'completed',

      durationMs: Date.now() - start,

      inputTokens: 0,

      outputTokens: 0

    };

    await store.saveRun(run);

    await store.audit(principal.id, 'query.completed', run.id);

    return run;

  }



  /*

   * ============================================================

   * NORMALIZAÇÃO

   * ============================================================

   */

  const normalizedQuestion = canonicalizeConfusables(sanitizeUntrustedText(question));



  /*

   * ============================================================

   * TASK / MESSAGE ROUTER

   * ============================================================

   */

  const documents = typeof store.documents === 'function' ? await store.documents(domain) : [];

  const investigation = createInvestigation(documents.map(describeDocument));

  const models = configuredModels();

  const signal = AbortSignal.timeout(investigation.budget.timeoutMs);

  const inlineEvidence: Evidence[] = [];

  if (config.COGNITIVE_INTERPRETER && llm) {

    // Only genuinely pasted text (fenced blocks) becomes a user-text resource; a plain question is not its own evidence.

    const blocks = [...normalizedQuestion.matchAll(/\x60{3}[^\n]*\n([\s\S]*?)\x60{3}/g)].map(match => match[1].trim());

    for (const [index, text] of blocks.entries()) {

      const id = 'user-text:' + runId + ':' + index;

      investigation.resources.push({

        id, kind: 'document', name: 'Texto da mensagem ' + (index + 1), domains: [domain],

        roles: ['context'], capabilities: ['READ', 'SEARCH'], provenance: { source: 'user-text' }, metadata: {}

      });

      for (let offset = 0; offset < text.length; offset += 3000) {

        inlineEvidence.push({

          id: id + ':' + offset, documentId: id, title: 'Texto da mensagem ' + (index + 1),

          text: text.slice(offset, offset + 3000), chunk: offset / 3000 + 1, score: 1

        });

      }

    }

  }

  const interpreted = config.COGNITIVE_INTERPRETER && llm

    ? await interpret(models, { message: normalizedQuestion, history, domain, resources: investigation.resources }, signal)

      .catch(error => {

        // The legacy router below is the safety net when the Interpreter itself cannot produce a valid plan.

        step('Entender', 'Interpreter indisponível (' + (error instanceof Error ? error.message : 'erro desconhecido') + '); usando roteamento padrão.');

        return undefined;

      })

    : undefined;

  // Social-only messages already returned above. Every remaining request must
  // consult the authorized knowledge base, even if the model calls it conversation.
  const understanding = interpreted ? {
    ...interpreted.understanding,
    interaction: interpreted.understanding.interaction === 'conversation'
      ? 'knowledge' as const : interpreted.understanding.interaction,
    needsKnowledge: true
  } : undefined;

  investigation.understanding = understanding;

  const proposedRouting = understanding ? {

    mode: 'task',

    task: undefined, objective: understanding.objective, focus: undefined,

    preserveState: understanding.needsContext, requiresRetrieval: understanding.needsKnowledge,

    requiresPlanning: understanding.suggestedOperations.length > 1,

    confidence: understanding.uncertainty.length ? 'low' : 'high', reason: 'Interpreter'

  } : await routeMessage(normalizedQuestion, history, { useModel: !config.COGNITIVE_INTERPRETER });

  const routing = {
    ...proposedRouting,
    requiresRetrieval: true,
    reason: proposedRouting.reason + '; base de conhecimento consultada antes da resposta.'
  };

  step('Entender', [

    `mode=${routing.mode}`,

    routing.task

      ? `task=${routing.task}`

      : undefined,

    routing.objective

      ? `objective=${routing.objective}`

      : undefined,

    routing.focus

      ? `focus=${routing.focus}`

      : undefined,

    `preserveState=${routing.preserveState}`,

    `retrieval=${routing.requiresRetrieval}`,

    `planning=${routing.requiresPlanning}`,

    `confidence=${routing.confidence}`,

    `reason=${routing.reason}`

  ]

    .filter(Boolean)

    .join('; '));



  /*

   * ============================================================

   * CORRECTION MODE

   * ============================================================

   */

  const correction = routing.task === 'correction' ||

    isAnswerCorrection(normalizedQuestion);



  /*

   * ============================================================

   * CONTEXTUALIZAÇÃO

   * ============================================================

   */

  const contextualQuery = contextualizeQuestion(normalizedQuestion, history);

  const conversationContext = conversationPrompt(history, normalizedQuestion);



  /*

   * ============================================================

   * DOCUMENTOS DISPONÍVEIS

   * ============================================================

   */

  const documentaryReference = /\b(documentos?|arquivos?|fontes?|pdf|cl[áa]usulas?|vade|saae)\b|\b\w+_\w+/iu.test(contextualQuery);
  const selectedDocuments = documentaryReference ? mentionedDocuments(contextualQuery, documents) : [];
  const documentNames = (selectedDocuments.length ? selectedDocuments : documents).map(document => document.name);



  /*

   * ============================================================

   * RESEARCH MEMORY

   * ============================================================

   */

  const researchMemory = !interpreted && typeof store.memories === 'function'

    ? await store.memories(principal.id, domain)

    : [];

  const memoryContext = relevantMemories(contextualQuery, researchMemory).map(memory => `Pergunta: ${memory.question}\n` +

    `Resposta anterior: ${memory.answer}`);



  /*

   * ============================================================

   * LANGGRAPH WORKFLOW

   * ============================================================

   */

  const workflow = new StateGraph(State)



    /*

     * ========================================================

     * PLAN

     * ========================================================

     */

    .addNode('plan', async (state) => {

      const structured = agent ||

        routing.requiresPlanning ||

        needsStructuredAnalysis(normalizedQuestion);

      const excerpts = structured && selectedDocuments.length > 1
        ? planningExcerpts(selectedDocuments, await store.chunks(domain, selectedDocuments.map(document => document.id)))
        : [];
      const p = await plan(contextualQuery, structured, documentNames, memoryContext, excerpts).catch(error => {
        if (!isTimeout(error)) throw error;
        step('Limitar', 'Planejamento excedeu o tempo; usando a pergunta como consulta.');
        return { queries: [contextualQuery], inputTokens: 0, outputTokens: 0 };
      });

      const queries = [

        ...new Set([

          contextualQuery,

          ...p.queries

        ])

      ].slice(0, 5);

      step('Planejar', structured

        ? (`task=${state.task}; ` +

          queries.length +

          ' consulta(s); análise estruturada ' +

          'restrita à base autorizada. ' +

          JSON.stringify(queries))

        : 'Consulta documental direta.');

      return {

        queries,

        // Two concepts can be supported by one document. Require two documents
        // only when the request actually compares documentary sources.
        comparison: (state.task === 'compare' || comparisonRequested(normalizedQuestion)) &&
          (mentionedDocuments(contextualQuery, documents).length > 1 || /\b(documentos|arquivos|fontes)\b/iu.test(contextualQuery)),

        inputTokens: p.inputTokens + (interpreted?.inputTokens ?? 0),

        outputTokens: p.outputTokens + (interpreted?.outputTokens ?? 0),

        attempts: 0

      };

    })



    /*

     * ========================================================

     * RETRIEVE

     * ========================================================

     */

    .addNode('retrieve', async (state) => {

      const batches = await Promise.all(state.queries.map(query => {
        const queryDocuments = mentionedDocuments(query, selectedDocuments);
        const scope = queryDocuments.length ? queryDocuments : selectedDocuments;
        return retrieve(store, scope.length ? contentQuery(query, scope) : query, domain,
          scope.length ? scope.map(document => document.id) : undefined);
      }));

      const evidence = accumulateEvidence(state.investigation.evidence, batches);

      // Legacy prompt window; the investigation retains all original passages.

      const sources = evidenceWindow(mergeEvidence(batches, 30), 10);

      step('Recuperar', sources.length +

        ' trecho(s) de ' +

        new Set(sources.map(source => source.documentId)).size +

        ' documento(s) no domínio ' +

        domain +

        '. Consultas: ' +

        state.queries.length +

        '. Documentos: ' +

        [

          ...new Set(sources.map(source => source.title))

        ].join(' | '));

      return {

        investigation: { ...state.investigation, evidence },

        sources

      };

    })



    /*

     * ========================================================

     * GENERATE

     * ========================================================

     */

    .addNode('generate', async (state) => {

      if (!state.sources.length) {

        step('Responder', 'Abstenção: nenhuma evidência relevante.');

        return {

          answer: 'Não encontrei evidências suficientes nos documentos deste domínio para responder. ' +

            'Adicione uma fonte ou reformule a pergunta.',

          abstain: true,

          citations: [],

          accepted: true

        };

      }

      if (!llm) {

        step('Responder', 'Modo sem chave: trechos recuperados, sem síntese por IA.');

        return {

          answer: 'Encontrei estes trechos na base de conhecimento. ' +

            'A síntese por IA ficará disponível após configurar o provedor.\n\n' +

            state.sources

              .slice(0, 3)

              .map((source, index) => `[${index + 1}] ${source.text}`)

              .join('\n\n'),

          citations: state.sources

            .slice(0, 3)

            .map((_, index) => index + 1),

          findings: [],

          abstain: false,

          accepted: true

        };

      }

      const result = await generateOrTimeout([

        {

          role: 'system',

          content: answerInstructions

        },

        {

          role: 'user',

          content: JSON.stringify({

            question: contextualQuery,

            userMessage: normalizedQuestion,

            routing: {

              mode: routing.mode,

              task: state.task,

              objective: state.objective,

              focus: state.focus,

              preserveState: state.preserveState

            },

            feedbackMode: correction,

            conversation: conversationContext,

            researchMemory: memoryContext,

            sources: state.sources.map((source, index) => ({

              citation: index + 1,

              documentId: source.documentId,

              document: source.title,

              passage: source.chunk,

              page: source.page,

              text: source.text

            })),

            retry: state.attempts > 0
              ? { reason: state.validationError, instruction: 'Corrija o formato indicado e use apenas afirmações sustentadas. Toda afirmação factual precisa de citação inline [n]; citations deve listar esses índices. Em confrontos, preencha findings com as evidências dos dois lados.' }
              : undefined

          })

        }

      ], 4000);

      if (!result) {
        step('Limitar', 'O modelo excedeu o tempo; exibindo os trechos recuperados.');
        const shown = state.sources.slice(0, 3);
        return {
          answer: 'O modelo de IA demorou demais para sintetizar a resposta. Estes são os trechos mais relevantes encontrados na base:\n\n' +
            shown.map((source, index) => `[${index + 1}] ${source.text}`).join('\n\n'),
          citations: shown.map((_, index) => index + 1),
          findings: [],
          abstain: false,
          accepted: true
        };
      }

      const parsed = answerSchema.safeParse(result.data);

      const validationError = parsed.success ? undefined : 'Formato da resposta inválido: ' +
        parsed.error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('; ');
      step('Gerar', validationError ?? 'Resposta estruturada recebida; aguardando verificação.');
      const answer = parsed.success ? parsed.data.answer : '';

      return {

        answer,

        validationError,

        citations: parsed.success

          ? parsed.data.citations

          : [],

        findings: parsed.success

          ? parsed.data.findings

          : [],

        abstain: parsed.success

          ? parsed.data.abstain

          : false,

        accepted: false,

        attempts: state.attempts + 1,

        inputTokens: state.inputTokens +

          result.inputTokens,

        outputTokens: state.outputTokens +

          result.outputTokens

      };

    })



    /*

     * ========================================================

     * JUDGE

     * ========================================================

     */

    .addNode('judge', async (state) => {

      if (state.accepted ||

        state.abstain) {

        step('Verificar', state.abstain

          ? 'Abstenção preservada.'

          : 'Trechos literais com origem identificada.');

        return {

          accepted: true

        };

      }

      if (state.validationError) return { accepted: false };

      const inline = extractInlineCitations(state.answer);

      if (!validCitations(state.citations, state.sources.length) ||

        !inline.length ||

        inline.some(citation => !state.citations.includes(citation))) {

        const validationError = 'Citações ausentes ou inválidas. Use índices de 1 a ' + state.sources.length + ' no texto e no array citations.';
        step('Verificar', validationError);

        return {

          accepted: false,
          validationError

        };

      }

      const documentIds = new Set(state.sources.map(source => source.documentId));

      const completeFindings = state.findings.filter(finding => validCitations([

        finding.leftCitation,

        finding.rightCitation

      ], state.sources.length)

        &&

        state.sources[finding.leftCitation - 1].documentId

        !==

        state.sources[finding.rightCitation - 1].documentId);

      if (state.comparison &&

        (documentIds.size < 2 ||

          !completeFindings.length)) {

        step('Verificar', 'Cobertura comparativa insuficiente: ' +

          documentIds.size +

          ' documento(s), ' +

          completeFindings.length +

          ' confronto(s) verificável(is).');

        return {

          accepted: false,
          validationError: 'Cobertura comparativa insuficiente: findings precisa de evidências de documentos distintos. Se faltar evidência, declare a lacuna.'

        };

      }

      const review = await reviewAnswer(normalizedQuestion, state.answer, state.citations, state.sources, runId);

      const accepted = review.verdict === 'pass';

      step('Verificar', accepted

        ? 'Revisor independente aceitou todas as afirmações.'

        : (`Revisor independente: ${review.verdict}; ` +

          `cobertura ${(review.coverage * 100).toFixed(0)}%.`));

      return {

        accepted,
        validationError: accepted ? undefined : ('Revisão: ' + review.verdict + '. ' + review.claims.filter(claim => claim.verdict !== 'pass').map(claim => claim.reason).join(' | ')),

        review

      };

    })



    /*

     * ========================================================

     * GRAPH EDGES

     * ========================================================

     */

    .addEdge(START, 'plan')

    .addEdge('plan', 'retrieve')

    .addEdge('retrieve', 'generate')

    .addEdge('generate', 'judge')

    .addConditionalEdges('judge', (state) => state.accepted ||

      state.attempts >= 2

      ? END

      : 'generate');



  /*

   * ============================================================

   * COMPILE GRAPH

   * ============================================================

   */

  const graph = workflow.compile();



  /*

   * ============================================================

   * EXECUTE GRAPH

   * ============================================================

   */

  step('Rota', interpreted
    ? 'COGNITIVE: Interpreter válido.'
    : 'LEGACY-RAG: consulta obrigatória à base de conhecimento.');

  const result = interpreted
    ? await executeCognitive({
        store, models, domain, question: normalizedQuestion,
        conversation: conversationContext, investigation, runId, signal, inlineEvidence, step,
        inputTokens: interpreted.inputTokens, outputTokens: interpreted.outputTokens
      })
    : await graph.invoke({
          investigation,
          queries: [],
          sources: [],
          answer: '',
          citations: [],
          findings: [],
          comparison: false,
          accepted: false,
          attempts: 0,
          abstain: false,
          review: undefined,
          inputTokens: 0,
          outputTokens: 0,
          task: (routing.task as TaskType) ?? 'lookup',
          objective: routing.objective,
          focus: routing.focus,
          preserveState: routing.preserveState
        }, {
          recursionLimit: 12
        });

  if ('diagnostics' in result && result.diagnostics) {

    const d = result.diagnostics as Awaited<ReturnType<typeof executeCognitive>>['diagnostics'];

    step('Diagnóstico', `adaptive=${d.adaptiveResearch}; comparative=${d.comparative}; steps=${d.steps}; ` +

      `toolCalls=${d.toolCalls}; retries=${d.retries}; evidence=${d.evidence}; tokens=${d.tokens}`);

  }



  /*

   * ============================================================

   * RESULT STATUS

   * ============================================================

   */

  const abstained = result.abstain ||

    !result.accepted;

  // Documents could not support an answer: complete it with clearly labelled general model knowledge.
  const complement = llm && abstained
    ? await generalKnowledgeAnswer(models, { question: contextualQuery, conversation: conversationContext })
      .catch(error => {
        step('Limitar', 'Complemento de conhecimento geral indisponível (' + (error instanceof Error ? error.name : 'erro') + ').');
        return undefined;
      })
    : undefined;
  if (complement?.text) step('Responder', 'Sem sustentação documental suficiente; conhecimento geral do modelo adicionado e identificado como tal.');
  const complementText = complement?.text ? '\n\n---\n\n' + generalKnowledgeNotice + '\n\n' + complement.text : '';

  const reviewReason = !result.accepted &&

    result.review?.claims.length

    ? ('\n\nMotivo da revisão: ' +

      result.review.claims

        .filter(claim => claim.verdict !== 'pass')

        .slice(0, 2)

        .map(claim => claim.reason)

        .join(' | '))

    : ('validationError' in result && result.validationError ? '\n\nMotivo da validação: ' + result.validationError : '');



  /*

   * ============================================================

   * FINAL RUN

   * ============================================================

   */

  const run: Run = {

    id: runId,

    owner: principal.id,

    domain,

    conversationId,

    question,

    createdAt: new Date().toISOString(),

    answer: result.accepted

      ? result.answer + complementText

      : ('Não foi possível validar uma resposta com as evidências disponíveis. ' +

        'Consulte as fontes ou reformule a pergunta.' +

        reviewReason + complementText),

    sources: result.sources,

    steps,

    mode: llm

      ? 'model'

      : 'extractive',

    review: result.review,

    workflow: interpreted ? 'cognitive-investigation-v1' : 'document-answer-v1',

    status: abstained

      ? 'abstained'

      : 'completed',

    durationMs: Date.now() - start,

    model: llm

      ? config.LLM_MODEL

      : undefined,

    inputTokens: result.inputTokens + (complement?.inputTokens ?? 0),

    outputTokens: result.outputTokens + (complement?.outputTokens ?? 0)

  };



  /*

   * ============================================================

   * PERSIST RUN

   * ============================================================

   */

  await store.saveRun(run);



  /*

   * ============================================================

   * EVALUATION

   * ============================================================

   */

  const evaluation = evaluateRun(run);

  await store.saveEvaluation?.(evaluation);



  /*

   * ============================================================

   * REVIEW TELEMETRY

   * ============================================================

   */

  if (run.review) {

    await store.saveReview?.(run.review);

    answerReviews.inc({

      verdict: run.review.verdict

    });

    answerGroundedness.observe(run.review.coverage);

  }



  /*

   * ============================================================

   * RESEARCH MEMORY

   * ============================================================

   */

  if (run.status === 'completed' &&

    run.sources.length &&

    typeof store.saveMemory === 'function') {

    await store.saveMemory({

      id: run.id,

      owner: run.owner,

      domain: run.domain,

      question: run.question,

      answer: run.answer,

      sourceIds: run.sources.map(source => source.id),

      createdAt: run.createdAt,

      state: 'candidate',

      confidence: run.review?.coverage ?? 0

    });

  }



  /*

   * ============================================================

   * AUDIT

   * ============================================================

   */

  await store.audit(principal.id, 'query.' + run.status, run.id);

  return run;

}
