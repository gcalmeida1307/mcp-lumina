import { Annotation, StateGraph, START, END } from '@langchain/langgraph';

import { plan } from '../agents/planner.js';
import { retrieve, mergeEvidence } from '../rag/retrieval.js';

import {
  answerInstructions,
  answerSchema,
  formatCitedAnswer,
  validCitations
} from '../llmops/evidence.js';

import { generate } from '../llmops/provider.js';
import { reviewAnswer } from '../llmops/review.js';
import { evaluateRun } from '../llmops/evaluation.js';

import { config, generationEnabled } from '../../gateway/config.js';

import type { Store } from '../../data/storage/database.js';

import type {
  ComparativeFinding,
  ConversationTurn,
  Evidence,
  Principal,
  Run,
  RunReview,
  TraceStep
} from '../types.js';

import {
  contextualizeQuestion,
  conversationPrompt,
  isAnswerCorrection,
  relevantMemories
} from './context.js';

import { socialReply } from './dialogue.js';
import { routeMessage } from './taskRouter.js';

import {
  canonicalizeConfusables,
  sanitizeUntrustedText
} from '../../data/processing/text.js';

import {
  answerGroundedness,
  answerReviews
} from '../../observability/telemetry.js';


/**
 * Definição explícita do TaskType para compatibilidade e segurança de tipos.
 */
export type TaskType = 
  | 'lookup' 
  | 'explain' 
  | 'compare' 
  | 'analyze' 
  | 'investigate' 
  | 'continue'
  | 'correction';


/**
 * Compatibilidade temporária com a arquitetura anterior.
 *
 * O Task Router passa a ser a principal fonte de decisão sobre
 * necessidade de planejamento estruturado.
 *
 * Esta heurística continua existindo como fallback durante
 * a migração da arquitetura.
 */
const needsStructuredAnalysis = (question: string) =>
  /\b(compare|comparar|comparação|confront|relação|relacione|cruz|cruze|diferen[çc]a|diverg|converg|s[íi]ntese|resum|explique|detalh|risco|causa|consequ[êe]ncia|impacto|pontos? (em comum|distint)|entre .*document)/iu.test(
    question
  );


/**
 * Mantido temporariamente para compatibilidade com o judge atual.
 *
 * Futuramente esta responsabilidade deverá vir do InvestigationPlan.
 */
const comparisonRequested = (question: string) =>
  /\b(compare|comparar|comparação|confront|relação entre|relacione|cruz|cruze|diferen[çc]a|diverg|converg|pontos? (em comum|distint)|entre .*document)/iu.test(
    question
  );


/**
 * Estado interno do LangGraph.
 *
 * Atualizado para acomodar o contexto semântico retornado pelo Task Router.
 */
const State = Annotation.Root({
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

    step(
      'Conversar',
      'Interação social; nenhuma afirmação documental ou chamada ao provedor.'
    );

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

    await store.audit(
      principal.id,
      'query.completed',
      run.id
    );

    return run;
  }


  /*
   * ============================================================
   * NORMALIZAÇÃO
   * ============================================================
   */

  const normalizedQuestion =
    canonicalizeConfusables(
      sanitizeUntrustedText(question)
    );


  /*
   * ============================================================
   * TASK / MESSAGE ROUTER
   * ============================================================
   */

  const routing =
    await routeMessage(
      normalizedQuestion,
      history
    );


  step(
    'Entender',
    [
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
      .join('; ')
  );


  /*
   * ============================================================
   * CORRECTION MODE
   * ============================================================
   */

  const correction =
    routing.task === 'correction' ||
    isAnswerCorrection(normalizedQuestion);


  /*
   * ============================================================
   * CONTEXTUALIZAÇÃO
   * ============================================================
   */

  const contextualQuery =
    contextualizeQuestion(
      normalizedQuestion,
      history
    );


  const conversationContext =
    conversationPrompt(
      history,
      normalizedQuestion
    );


  /*
   * ============================================================
   * DOCUMENTOS DISPONÍVEIS
   * ============================================================
   */

  const documentNames =
    typeof store.documents === 'function'
      ? (
          await store.documents(domain)
        ).map(document => document.name)
      : [];


  /*
   * ============================================================
   * RESEARCH MEMORY
   * ============================================================
   */

  const researchMemory =
    typeof store.memories === 'function'
      ? await store.memories(
          principal.id,
          domain
        )
      : [];


  const memoryContext =
    relevantMemories(
      contextualQuery,
      researchMemory
    ).map(
      memory =>
        `Pergunta: ${memory.question}\n` +
        `Resposta anterior: ${memory.answer}`
    );


  /*
   * ============================================================
   * LANGGRAPH WORKFLOW
   * ============================================================
   */

  const workflow =
    new StateGraph(State)


      /*
       * ========================================================
       * PLAN
       * ========================================================
       */

      .addNode(
        'plan',
        async (state) => {

          const structured =
            agent ||
            routing.requiresPlanning ||
            needsStructuredAnalysis(
              normalizedQuestion
            );


          const p =
            await plan(
              contextualQuery,
              structured,
              documentNames,
              memoryContext
            );


          const queries =
            [
              ...new Set([
                contextualQuery,
                ...p.queries
              ])
            ].slice(0, 5);


          step(
            'Planejar',

            structured
              ? (
                  `task=${state.task}; ` +
                  queries.length +
                  ' consulta(s); análise estruturada ' +
                  'restrita à base autorizada. ' +
                  JSON.stringify(queries)
                )
              : 'Consulta documental direta.'
          );


          return {
            queries,

            comparison:
              state.task === 'compare' ||
              comparisonRequested(
                normalizedQuestion
              ),

            inputTokens:
              p.inputTokens,

            outputTokens:
              p.outputTokens,

            attempts: 0
          };
        }
      )


      /*
       * ========================================================
       * RETRIEVE
       * ========================================================
       */

      .addNode(
        'retrieve',
        async (state) => {

          const primary =
            await retrieve(
              store,
              state.queries[0],
              domain
            );


          const batches = [
            primary,

            ...(
              await Promise.all(
                state.queries
                  .slice(1)
                  .map(
                    query =>
                      retrieve(
                        store,
                        query,
                        domain
                      )
                  )
              )
            )
          ];


          const sources =
            mergeEvidence(
              batches,
              10
            );


          step(
            'Recuperar',

            sources.length +
            ' trecho(s) de ' +
            new Set(
              sources.map(
                source =>
                  source.documentId
              )
            ).size +
            ' documento(s) no domínio ' +
            domain +
            '. Consultas: ' +
            state.queries.length +
            '. Documentos: ' +
            [
              ...new Set(
                sources.map(
                  source =>
                    source.title
                )
              )
            ].join(' | ')
          );


          return {
            sources
          };
        }
      )


      /*
       * ========================================================
       * GENERATE
       * ========================================================
       */

      .addNode(
        'generate',
        async (state) => {

          if (!state.sources.length) {

            step(
              'Responder',
              'Abstenção: nenhuma evidência relevante.'
            );


            return {
              answer:
                'Não encontrei evidências suficientes nos documentos deste domínio para responder. ' +
                'Adicione uma fonte ou reformule a pergunta.',

              abstain: true,

              citations: [],

              accepted: true
            };
          }


          if (!llm) {

            step(
              'Responder',
              'Modo sem chave: trechos recuperados, sem síntese por IA.'
            );


            return {

              answer:
                'Encontrei estes trechos na base de conhecimento. ' +
                'A síntese por IA ficará disponível após configurar o provedor.\n\n' +

                state.sources
                  .slice(0, 3)
                  .map(
                    (source, index) =>
                      `[${index + 1}] ${source.text}`
                  )
                  .join('\n\n'),

              citations:
                state.sources
                  .slice(0, 3)
                  .map(
                    (_, index) =>
                      index + 1
                  ),

              findings: [],

              abstain: false,

              accepted: true
            };
          }


          const result =
            await generate(
              [
                {
                  role: 'system',
                  content:
                    answerInstructions
                },

                {
                  role: 'user',

                  content:
                    JSON.stringify({

                      question:
                        contextualQuery,

                      userMessage:
                        normalizedQuestion,

                      routing: {
                        mode:
                          routing.mode,

                        task:
                          state.task,

                        objective:
                          state.objective,

                        focus:
                          state.focus,

                        preserveState:
                          state.preserveState
                      },

                      feedbackMode:
                        correction,

                      conversation:
                        conversationContext,

                      researchMemory:
                        memoryContext,

                      sources:
                        state.sources.map(
                          (
                            source,
                            index
                          ) => ({
                            citation:
                              index + 1,

                            documentId:
                              source.documentId,

                            document:
                              source.title,

                            passage:
                              source.chunk,

                            page:
                              source.page,

                            text:
                              source.text
                          })
                        ),

                      retry:
                        state.attempts > 0
                          ? (
                              'A resposta anterior falhou na verificação de evidências. ' +
                              'Use apenas afirmações diretamente sustentadas.'
                            )
                          : undefined
                    })
                }
              ],

              4000
            );


          const parsed =
            answerSchema.safeParse(
              result.data
            );


          step(
            'Gerar',
            'Resposta estruturada recebida; aguardando verificação.'
          );


          const answer =
            parsed.success &&
            parsed.data.citations.length

              ? formatCitedAnswer(
                  parsed.data.answer,
                  parsed.data.citations
                )

              : parsed.success
                ? parsed.data.answer
                : '';


          return {

            answer,

            citations:
              parsed.success
                ? parsed.data.citations
                : [],

            findings:
              parsed.success
                ? parsed.data.findings
                : [],

            abstain:
              parsed.success
                ? parsed.data.abstain
                : false,

            accepted: false,

            attempts:
              state.attempts + 1,

            inputTokens:
              state.inputTokens +
              result.inputTokens,

            outputTokens:
              state.outputTokens +
              result.outputTokens
          };
        }
      )


      /*
       * ========================================================
       * JUDGE
       * ========================================================
       */

      .addNode(
        'judge',
        async (state) => {

          if (
            state.accepted ||
            state.abstain
          ) {

            step(
              'Verificar',

              state.abstain
                ? 'Abstenção preservada.'
                : 'Trechos literais com origem identificada.'
            );


            return {
              accepted: true
            };
          }


          const inline =
            [
              ...state.answer.matchAll(
                /\[(\d+)\]/g
              )
            ].map(
              match =>
                Number(match[1])
            );


          if (
            !validCitations(
              state.citations,
              state.sources.length
            ) ||

            !inline.length ||

            inline.some(
              citation =>
                !state.citations.includes(
                  citation
                )
            )
          ) {

            step(
              'Verificar',
              'Citações ausentes ou inválidas.'
            );


            return {
              accepted: false
            };
          }


          const documentIds =
            new Set(
              state.sources.map(
                source =>
                  source.documentId
              )
            );


          const completeFindings =
            state.findings.filter(
              finding =>

                validCitations(
                  [
                    finding.leftCitation,
                    finding.rightCitation
                  ],
                  state.sources.length
                )

                &&

                state.sources[
                  finding.leftCitation - 1
                ].documentId

                !==

                state.sources[
                  finding.rightCitation - 1
                ].documentId
            );


          if (
            state.comparison &&
            (
              documentIds.size < 2 ||
              !completeFindings.length
            )
          ) {

            step(
              'Verificar',

              'Cobertura comparativa insuficiente: ' +

              documentIds.size +
              ' documento(s), ' +

              completeFindings.length +
              ' confronto(s) verificável(is).'
            );


            return {
              accepted: false
            };
          }


          const review =
            await reviewAnswer(
              normalizedQuestion,
              state.answer,
              state.citations,
              state.sources,
              runId
            );


          const accepted =
            review.verdict === 'pass';


          step(
            'Verificar',

            accepted
              ? 'Revisor independente aceitou todas as afirmações.'
              : (
                  `Revisor independente: ${review.verdict}; ` +
                  `cobertura ${(review.coverage * 100).toFixed(0)}%.`
                )
          );


          return {
            accepted,
            review
          };
        }
      )


      /*
       * ========================================================
       * GRAPH EDGES
       * ========================================================
       */

      .addEdge(
        START,
        'plan'
      )

      .addEdge(
        'plan',
        'retrieve'
      )

      .addEdge(
        'retrieve',
        'generate'
      )

      .addEdge(
        'generate',
        'judge'
      )

      .addConditionalEdges(
        'judge',

        (state) =>
          state.accepted ||
          state.attempts >= 2

            ? END

            : 'generate'
      );


  /*
   * ============================================================
   * COMPILE GRAPH
   * ============================================================
   */

  const graph =
    workflow.compile();


  /*
   * ============================================================
   * EXECUTE GRAPH
   * ============================================================
   */

  const result =
    await graph.invoke(
      {
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
      },

      {
        recursionLimit: 12
      }
    );


  /*
   * ============================================================
   * RESULT STATUS
   * ============================================================
   */

  const abstained =
    result.abstain ||
    !result.accepted;


  const reviewReason =
    !result.accepted &&
    result.review?.claims.length

      ? (
          '\n\nMotivo da revisão: ' +

          result.review.claims

            .filter(
              claim =>
                claim.verdict !== 'pass'
            )

            .slice(0, 2)

            .map(
              claim =>
                claim.reason
            )

            .join(' | ')
        )

      : '';


  /*
   * ============================================================
   * FINAL RUN
   * ============================================================
   */

  const run: Run = {

    id:
      runId,

    owner:
      principal.id,

    domain,

    conversationId,

    question,

    createdAt:
      new Date().toISOString(),

    answer:
      result.accepted

        ? result.answer

        : (
            'Não foi possível validar uma resposta com as evidências disponíveis. ' +
            'Consulte as fontes ou reformule a pergunta.' +
            reviewReason
          ),

    sources:
      result.sources,

    steps,

    mode:
      llm
        ? 'model'
        : 'extractive',

    review:
      result.review,

    workflow:
      'document-answer-v1',

    status:
      abstained
        ? 'abstained'
        : 'completed',

    durationMs:
      Date.now() - start,

    model:
      llm
        ? config.LLM_MODEL
        : undefined,

    inputTokens:
      result.inputTokens,

    outputTokens:
      result.outputTokens
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

  const evaluation =
    evaluateRun(run);


  await store.saveEvaluation?.(
    evaluation
  );


  /*
   * ============================================================
   * REVIEW TELEMETRY
   * ============================================================
   */

  if (run.review) {

    await store.saveReview?.(
      run.review
    );


    answerReviews.inc({
      verdict:
        run.review.verdict
    });


    answerGroundedness.observe(
      run.review.coverage
    );
  }


  /*
   * ============================================================
   * RESEARCH MEMORY
   * ============================================================
   */

  if (
    run.status === 'completed' &&
    run.sources.length &&
    typeof store.saveMemory === 'function'
  ) {

    await store.saveMemory({
      id:
        run.id,

      owner:
        run.owner,

      domain:
        run.domain,

      question:
        run.question,

      answer:
        run.answer,

      sourceIds:
        run.sources.map(
          source =>
            source.id
        ),

      createdAt:
        run.createdAt,

      state:
        'candidate',

      confidence:
        run.review?.coverage ?? 0
    });
  }


  /*
   * ============================================================
   * AUDIT
   * ============================================================
   */

  await store.audit(
    principal.id,
    'query.' + run.status,
    run.id
  );


  return run;
}