import type { ConversationTurn } from '../types.js';
import { socialReply } from './dialogue.js';

const MAX_HISTORY_TURNS = 6;
const MAX_ANSWER_CHARS = 1200;
const MAX_CONTEXT_CHARS = 9000;

/** Prefer recent complete turns within a deterministic character budget, without another model call. */
export function boundedHistory(history: ConversationTurn[]): ConversationTurn[] {
  const selected: ConversationTurn[] = [];
  let remaining = MAX_CONTEXT_CHARS;
  for (const turn of history.filter(turn => !socialReply(turn.question)).slice(-MAX_HISTORY_TURNS).reverse()) {
    const question = turn.question.slice(0, 1500);
    const answer = turn.answer.slice(0, MAX_ANSWER_CHARS);
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

/** Only explicit references inherit a recent question. Model answers never become search terms. */
export function contextualizeQuestion(question: string, history: ConversationTurn[]): string {
  const recent = boundedHistory(history);
  if (!recent.length || !refersToPrevious(question)) return question;
  const subject = [...recent].reverse().find(turn => !refersToPrevious(turn.question)) ?? recent.at(-1)!;
  return `${question}\nContexto da pergunta anterior: ${subject.question.slice(0, 500)}`;
}

export function conversationPrompt(history: ConversationTurn[], question?: string): string {
  if (question && !refersToPrevious(question)) return 'Pergunta independente. Responda ao assunto atual usando as fontes recuperadas.';
  const recent = boundedHistory(history);
  if (!recent.length) return 'Nenhum turno anterior.';
  return recent.map((turn, index) =>
    `Turno ${index + 1}:\nPergunta: ${turn.question}\nResposta: ${turn.answer}`
  ).join('\n\n');
}
