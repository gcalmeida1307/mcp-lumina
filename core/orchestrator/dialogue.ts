/** Exact social intents only: a greeting prefix must never bypass document retrieval. */
export function socialReply(question: string): string | undefined {
  const text = question.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[!?.;,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(oi|ola|bom dia|boa tarde|boa noite)( lumina)?( tudo bem)?$/.test(text) || /^(tudo bem|como voce esta)$/.test(text)) return 'Olá! Estou aqui para conversar e ajudar com o conhecimento da sua organização. O que você gostaria de saber?';
  if (/^(obrigad[oa]|muito obrigad[oa]|valeu|obrigad[oa] lumina)$/.test(text)) return 'Por nada! Pode continuar: o que mais você gostaria de explorar?';
  if (/^(tchau|ate logo|ate mais|boa noite e ate amanha)$/.test(text)) return 'Até mais! Quando quiser continuar, é só me chamar.';
  if (/^(quem e voce|o que voce faz|como voce pode me ajudar)$/.test(text)) return 'Sou a LUMINA. Posso consultar os documentos do módulo selecionado, explicar o que as fontes dizem e continuar a conversa mantendo o contexto. Você também pode conversar comigo por voz.';
  return undefined;
}
