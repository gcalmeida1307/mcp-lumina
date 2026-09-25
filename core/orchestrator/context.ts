import type { ConversationTurn, ResearchMemory } from '../types.js';
import { tokenize } from '../../data/processing/text.js';
import { sanitizeUntrustedText } from '../../data/processing/text.js';
import { socialReply } from './dialogue.js';

const MAX_HISTORY_TURNS = 6;
const MAX_ANSWER_CHARS = 1200;
const MAX_CONTEXT_CHARS = 9000;

/** Prefer recent complete turns within a deterministic character budget, without another model call. */
export function boundedHistory(history: ConversationTurn[]): ConversationTurn[] {
  const selected: ConversationTurn[] = [];
  let remaining = MAX_CONTEXT_CHARS;
  for (const turn of history.filter(turn => !socialReply(turn.question)).slice(-MAX_HISTORY_TURNS).reverse()) {
    const question = sanitizeUntrustedText(turn.question).slice(0, 1500);
    const answer = sanitizeUntrustedText(turn.answer).slice(0, MAX_ANSWER_CHARS);
    if (question.length + answer.length > remaining) break;
    selected.unshift({ question, answer }); remaining -= question.length + answer.length;
  }
  return selected;
}

export function refersToPrevious(question: string): boolean {
  const text = question.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (/\b(mudando de assunto|outro assunto|agora sobre)\b/.test(text)) return false;
  return /\b(isso|disso|nisso|deles|delas|dele|dela|esse|essa|esses|essas|desse|dessa|desses|dessas|nesse|nessa|anterior|acima)\b/.test(text)
    || /^(e\s+)?(qual (e )?o prazo|por que|como assim|explique melhor|continue|resuma|pode explicar melhor)\s*[?!.]*$/.test(text.trim());
}

export function isAnswerCorrection(question: string): boolean {
  const text = question.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
  return /^(?:[a-d]\s*[\)\.:\-]|alternativa\s+[a-d]\b|essa\s+(?:e|seria)|a\s+resposta\s+(?:e|seria)|correto\s*:)/.test(text)
    || /\bessa seria a resposta correta\b/.test(text);
}

/** Only explicit references inherit a recent question. Model answers never become search terms. */
export function contextualizeQuestion(question: string, history: ConversationTurn[]): string {
  const recent = boundedHistory(history);
  if (!recent.length || (!refersToPrevious(question) && !isAnswerCorrection(question))) return question;
  if (isAnswerCorrection(question)) {
    const previous = recent.at(-1)!;
    return `${previous.question}\nFeedback do usuário para verificação, não uma fonte: ${question.slice(0, 1200)}`;
  }
  const subject = [...recent].reverse().find(turn => !refersToPrevious(turn.question)) ?? recent.at(-1)!;
  return `${question}\nContexto da pergunta anterior: ${subject.question.slice(0, 500)}`;
}

export function conversationPrompt(history: ConversationTurn[], question?: string): string {
  if (question && !refersToPrevious(question) && !isAnswerCorrection(question)) return 'Pergunta independente. Responda ao assunto atual usando as fontes recuperadas.';
  const recent = boundedHistory(history);
  if (!recent.length) return 'Nenhum turno anterior.';
  return recent.map((turn, index) =>
    `Turno ${index + 1}:\nPergunta: ${turn.question}\nResposta: ${turn.answer}`
  ).join('\n\n');
}

export function relevantMemories(query: string, memories: ResearchMemory[], limit = 4): ResearchMemory[] {
  const terms = new Set(tokenize(query));
  return memories.filter(memory => memory.state !== 'candidate' && memory.state !== 'rejected' && memory.state !== 'revoked' && memory.state !== 'expired').map(memory => {
    const text = new Set(tokenize(memory.question + ' ' + memory.answer));
    const matches = [...terms].filter(term => text.has(term)).length;
    return { memory, score: matches / Math.max(1, terms.size) };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.memory.createdAt.localeCompare(a.memory.createdAt)).slice(0, limit).map(item => item.memory);
}
