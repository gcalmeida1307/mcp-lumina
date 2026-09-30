import type {
  ConversationTurn,
  ResearchMemory
} from '../types.js';

import {
  sanitizeUntrustedText,
  tokenize
} from '../../data/processing/text.js';

import { socialReply } from './dialogue.js';


/*
 * ============================================================
 * LIMITES DE CONTEXTO
 * ============================================================
 *
 * O histórico conversacional serve para continuidade semântica.
 *
 * Ele NÃO deve virar uma fonte factual.
 *
 * Mantemos limites determinísticos para:
 *
 * - evitar crescimento ilimitado do prompt;
 * - reduzir custo;
 * - reduzir contaminação de contexto;
 * - privilegiar turnos recentes;
 * - impedir que respostas antigas dominem a recuperação atual.
 */

const MAX_HISTORY_TURNS = 6;

const MAX_QUESTION_CHARS = 1500;

const MAX_ANSWER_CHARS = 1200;

const MAX_CONTEXT_CHARS = 9000;


/*
 * ============================================================
 * NORMALIZAÇÃO
 * ============================================================
 */

function normalizeText(text: string): string {
  return sanitizeUntrustedText(text)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}


/*
 * ============================================================
 * MUDANÇA EXPLÍCITA DE ASSUNTO
 * ============================================================
 *
 * Se o usuário disser explicitamente que mudou de assunto,
 * não devemos herdar a investigação anterior.
 */

export function changesSubject(question: string): boolean {
  const text = normalizeText(question);

  return /\b(mudando de assunto|outro assunto|novo assunto|agora sobre|falando de outra coisa|vamos falar de|quero falar de outra coisa)\b/u
    .test(text);
}


/*
 * ============================================================
 * HISTÓRICO LIMITADO
 * ============================================================
 *
 * Seleciona apenas turnos recentes e completos dentro de um
 * orçamento determinístico.
 *
 * Interações puramente sociais são ignoradas.
 */

export function boundedHistory(
  history: ConversationTurn[]
): ConversationTurn[] {

  const selected: ConversationTurn[] = [];

  let remaining = MAX_CONTEXT_CHARS;

  const candidates = history
    .filter(turn => !socialReply(turn.question))
    .slice(-MAX_HISTORY_TURNS)
    .reverse();

  for (const turn of candidates) {

    const question = sanitizeUntrustedText(
      turn.question
    ).slice(
      0,
      MAX_QUESTION_CHARS
    );

    const answer = sanitizeUntrustedText(
      turn.answer
    ).slice(
      0,
      MAX_ANSWER_CHARS
    );

    const size =
      question.length +
      answer.length;

    /*
     * Se este turno sozinho exceder o orçamento restante,
     * ignoramos este turno e continuamos procurando outro
     * menor.
     *
     * Não usamos "break", pois um turno muito grande não deve
     * impedir automaticamente o aproveitamento de outros.
     */
    if (size > remaining) {
      continue;
    }

    selected.unshift({
      question,
      answer
    });

    remaining -= size;

    if (remaining <= 0) {
      break;
    }
  }

  return selected;
}


/*
 * ============================================================
 * REFERÊNCIA À CONVERSA ANTERIOR
 * ============================================================
 *
 * Esta função é propositalmente conservadora.
 *
 * O TaskRouter passa a ser responsável pela interpretação
 * semântica principal.
 *
 * Esta heurística continua existindo para:
 *
 * - fallback sem LLM;
 * - compatibilidade;
 * - referências conversacionais óbvias.
 */

export function refersToPrevious(
  question: string
): boolean {

  const text = normalizeText(question);

  if (!text) {
    return false;
  }

  /*
   * Mudança explícita de assunto sempre vence.
   */
  if (changesSubject(text)) {
    return false;
  }


  /*
   * ----------------------------------------------------------
   * PRONOMES / REFERÊNCIAS
   * ----------------------------------------------------------
   *
   * Exemplos:
   *
   * "Isso é um problema?"
   * "Explique essa parte."
   * "Qual o impacto disso?"
   */

  if (
    /\b(isso|disso|nisso|aquilo|daquilo|naquilo|deles|delas|dele|dela|esse|essa|esses|essas|desse|dessa|desses|dessas|nesse|nessa|nesses|nessas|anterior|anteriores|acima|mencionado|mencionada|citado|citada)\b/u
      .test(text)
  ) {
    return true;
  }


  /*
   * ----------------------------------------------------------
   * CONTINUAÇÕES NATURAIS
   * ----------------------------------------------------------
   *
   * Resolve justamente casos como:
   *
   * "E quanto a hora extra?"
   * "E sobre férias?"
   * "Quanto ao adicional?"
   */

  if (
    /^(e\s+)?quanto\s+(a|ao|as|aos)\b/u
      .test(text)
  ) {
    return true;
  }

  if (
    /^(e\s+)?sobre\b/u
      .test(text)
  ) {
    return true;
  }

  if (
    /^(quanto\s+(a|ao|as|aos))\b/u
      .test(text)
  ) {
    return true;
  }


  /*
   * ----------------------------------------------------------
   * PEDIDOS CURTOS DE CONTINUAÇÃO
   * ----------------------------------------------------------
   */

  if (
    /^(e\s+)?(por que|porque|como assim|continue|continua|aprofunde|detalhe|detalhe melhor|explique melhor|pode explicar melhor|resuma|resuma melhor|qual (e )?o prazo|qual o impacto|qual a consequencia|quais as consequencias)\s*[?!.]*$/u
      .test(text)
  ) {
    return true;
  }


  /*
   * ----------------------------------------------------------
   * CONTINUAÇÃO POR FOCO
   * ----------------------------------------------------------
   *
   * Exemplos:
   *
   * "Nesse caso?"
   * "Nesse ponto?"
   * "Sobre esse ponto?"
   */

  if (
    /^(e\s+)?(nesse caso|neste caso|nesse ponto|neste ponto|sobre esse ponto|sobre isso)\s*[?!.]*$/u
      .test(text)
  ) {
    return true;
  }


  return false;
}


/*
 * ============================================================
 * CORREÇÃO / CONTESTAÇÃO DO USUÁRIO
 * ============================================================
 *
 * IMPORTANTE:
 *
 * Detectar correção NÃO significa aceitar a correção como
 * verdadeira.
 *
 * Significa apenas:
 *
 * "o usuário apresentou uma afirmação que precisa ser
 * reavaliada contra as evidências."
 */

export function isAnswerCorrection(
  question: string
): boolean {

  const text = normalizeText(question);

  if (!text) {
    return false;
  }


  /*
   * Alternativas isoladas:
   *
   * A
   * A)
   * A.
   * alternativa A
   */

  if (
    /^(?:[a-e]\s*[\).:\-]?|alternativa\s+[a-e]\b.*)$/u
      .test(text)
  ) {
    return true;
  }


  /*
   * Resposta/gabarito explícito.
   *
   * Exemplos:
   *
   * "A resposta correta é A."
   * "Segundo o gabarito é A."
   * "O gabarito correto é letra A."
   */

  if (
    /\b(a resposta correta|resposta correta|o gabarito correto|gabarito correto|segundo o gabarito|de acordo com o gabarito)\b/u
      .test(text)
  ) {
    return true;
  }


  /*
   * Correção explícita.
   *
   * Exemplos:
   *
   * "Você errou."
   * "Isso está errado."
   * "Sua resposta está incorreta."
   * "Na verdade é..."
   */

  if (
    /\b(voce errou|isso esta errado|isso esta incorreto|essa resposta esta errada|essa resposta esta incorreta|sua resposta esta errada|sua resposta esta incorreta|na verdade e|o correto e|a correta e|a resposta e)\b/u
      .test(text)
  ) {
    return true;
  }


  /*
   * Contestação que solicita reavaliação.
   */

  if (
    /\b(nao concordo|discordo|reveja|reavalie|verifique novamente|confira novamente)\b/u
      .test(text)
  ) {
    return true;
  }


  /*
   * Compatibilidade com expressões anteriores.
   */

  if (
    /\bessa seria a resposta correta\b/u
      .test(text)
  ) {
    return true;
  }


  return false;
}


/*
 * ============================================================
 * ENCONTRAR ÂNCORA DA CONVERSA
 * ============================================================
 *
 * A âncora representa a pergunta independente que originou
 * a sequência atual.
 *
 * Exemplo:
 *
 * P1:
 * "Como o SAAE pode ter problemas quando olhamos o VADE?"
 *
 * P2:
 * "E quanto a hora extra?"
 *
 * P3:
 * "Isso é um problema?"
 *
 * A âncora continua sendo P1.
 */

function findConversationAnchor(
  history: ConversationTurn[]
): ConversationTurn | undefined {

  const recent = boundedHistory(history);

  if (!recent.length) {
    return undefined;
  }

  /*
   * Procuramos de trás para frente a pergunta independente
   * mais recente.
   */

  return (
    [...recent]
      .reverse()
      .find(
        turn =>
          changesSubject(turn.question) ||
          (!refersToPrevious(turn.question) &&
          !isAnswerCorrection(turn.question))
      )
    ??
    recent.at(-1)
  );
}


/*
 * ============================================================
 * CONTEXTUALIZAÇÃO PARA RETRIEVAL / PLANNER
 * ============================================================
 *
 * ATENÇÃO:
 *
 * Aqui usamos PERGUNTAS anteriores como contexto.
 *
 * Não transformamos respostas anteriores do LLM em termos
 * de busca ou evidências.
 *
 * Isso evita reforçar alucinações anteriores.
 */

export function contextualizeQuestion(
  question: string,
  history: ConversationTurn[],
  forceContinuation = false
): string {

  const cleanQuestion =
    sanitizeUntrustedText(question);

  const recent =
    boundedHistory(history);


  /*
   * Sem histórico não existe continuidade.
   */

  if (!recent.length) {
    return cleanQuestion;
  }


  /*
   * Mudança explícita de assunto cancela herança.
   */

  if (changesSubject(cleanQuestion)) {
    return cleanQuestion;
  }


  const correction =
    isAnswerCorrection(cleanQuestion);

  const continuation =
    forceContinuation ||
    refersToPrevious(cleanQuestion);


  /*
   * Pergunta independente.
   */

  if (
    !continuation &&
    !correction
  ) {
    return cleanQuestion;
  }


  /*
   * ----------------------------------------------------------
   * CORREÇÃO
   * ----------------------------------------------------------
   *
   * A correção do usuário é anexada como FEEDBACK,
   * nunca como evidência.
   */

  if (correction) {

    const previous =
      recent.at(-1)!;

    const anchor =
      findConversationAnchor(recent)
      ?? previous;


    const parts = [
      `Pergunta original: ${anchor.question.slice(0, MAX_QUESTION_CHARS)}`
    ];


    if (
      previous.question !==
      anchor.question
    ) {
      parts.push(
        `Última pergunta relacionada: ${previous.question.slice(0, 1000)}`
      );
    }


    parts.push(
      `Feedback do usuário para verificação, não uma fonte: ${cleanQuestion.slice(0, 1200)}`
    );


    return parts.join('\n');
  }


  /*
   * ----------------------------------------------------------
   * CONTINUAÇÃO
   * ----------------------------------------------------------
   */

  const anchor =
    findConversationAnchor(recent)
    ?? recent.at(-1)!;

  const previous =
    recent.at(-1)!;


  const parts = [
    `Pergunta atual: ${cleanQuestion}`,
    `Objetivo/contexto de origem: ${anchor.question.slice(0, MAX_QUESTION_CHARS)}`
  ];


  /*
   * Se já existiu um follow-up entre a âncora e a pergunta
   * atual, preservamos também o foco imediatamente anterior.
   */

  if (
    previous.question !==
    anchor.question
  ) {
    parts.push(
      `Último foco da conversa: ${previous.question.slice(0, 1000)}`
    );
  }


  return parts.join('\n');
}


/*
 * ============================================================
 * CONTEXTO CONVERSACIONAL PARA O LLM
 * ============================================================
 *
 * Diferentemente de contextualizeQuestion(), aqui respostas
 * anteriores podem aparecer.
 *
 * Porém elas são explicitamente apresentadas como HISTÓRICO
 * CONVERSACIONAL, não como evidência.
 *
 * As evidências continuam vindo exclusivamente do retrieval.
 */

export function conversationPrompt(
  history: ConversationTurn[],
  question?: string,
  forceContinuation = false
): string {

  /*
   * Mudança explícita de assunto.
   */

  if (
    question &&
    changesSubject(question)
  ) {
    return (
      'Pergunta independente. ' +
      'O usuário mudou explicitamente de assunto. ' +
      'Não herde conclusões da conversa anterior. ' +
      'Use apenas as fontes recuperadas para a pergunta atual.'
    );
  }


  /*
   * Pergunta independente.
   */

  if (
    question &&
    !forceContinuation &&
    !refersToPrevious(question) &&
    !isAnswerCorrection(question)
  ) {
    return (
      'Pergunta independente. ' +
      'Responda ao assunto atual usando as fontes recuperadas.'
    );
  }


  const recent =
    boundedHistory(history);


  if (!recent.length) {
    return 'Nenhum turno anterior.';
  }


  const header = [
    'Histórico conversacional para resolução de contexto.',
    'IMPORTANTE: respostas anteriores não são fontes nem evidências.',
    'Qualquer afirmação factual da nova resposta deve ser sustentada pelas fontes recuperadas.'
  ].join(' ');


  const turns =
    recent
      .map(
        (turn, index) =>
          [
            `Turno ${index + 1}:`,
            `Pergunta: ${turn.question}`,
            `Resposta anterior (apenas contexto, não evidência): ${turn.answer}`
          ].join('\n')
      )
      .join('\n\n');


  return `${header}\n\n${turns}`;
}


/*
 * ============================================================
 * MEMÓRIA DE PESQUISA
 * ============================================================
 *
 * A memória continua sendo filtrada deterministicamente.
 *
 * Apenas memórias governadas/aceitas podem participar.
 *
 * candidate, rejected, revoked e expired permanecem fora.
 */

export function relevantMemories(
  query: string,
  memories: ResearchMemory[],
  limit = 4
): ResearchMemory[] {

  const queryTerms =
    new Set(
      tokenize(query)
    );


  /*
   * Consulta sem termos úteis não deve recuperar memória
   * arbitrariamente.
   */

  if (!queryTerms.size) {
    return [];
  }


  return memories

    /*
     * --------------------------------------------------------
     * GOVERNANÇA
     * --------------------------------------------------------
     */

    .filter(
      memory =>
        memory.state !== 'candidate' &&
        memory.state !== 'rejected' &&
        memory.state !== 'revoked' &&
        memory.state !== 'expired'
    )


    /*
     * --------------------------------------------------------
     * SCORE LEXICAL
     * --------------------------------------------------------
     */

    .map(
      memory => {

        const memoryTerms =
          new Set(
            tokenize(
              memory.question +
              ' ' +
              memory.answer
            )
          );


        const matches =
          [...queryTerms]
            .filter(
              term =>
                memoryTerms.has(term)
            )
            .length;


        const score =
          matches /
          Math.max(
            1,
            queryTerms.size
          );


        return {
          memory,
          score
        };
      }
    )


    /*
     * --------------------------------------------------------
     * REMOVE MEMÓRIAS SEM SOBREPOSIÇÃO
     * --------------------------------------------------------
     */

    .filter(
      item =>
        item.score > 0
    )


    /*
     * --------------------------------------------------------
     * RELEVÂNCIA PRIMEIRO, RECÊNCIA DESEMPATA
     * --------------------------------------------------------
     */

    .sort(
      (a, b) =>
        b.score -
        a.score
        ||
        b.memory.createdAt.localeCompare(
          a.memory.createdAt
        )
    )


    /*
     * --------------------------------------------------------
     * LIMITE
     * --------------------------------------------------------
     */

    .slice(
      0,
      Math.max(
        0,
        limit
      )
    )


    .map(
      item =>
        item.memory
    );
}