const stopwords = new Set('a o os as de da do das dos e em um uma que qual quais como para por no na nos nas ao aos com sobre se me meu minha eu voce voces este esta isso sao ser foi tem the is of and to'.split(' '));
for (const word of 'nao sim pode podem poderia consegue conseguem conseguiria falar dizer explicar explique saber quero gostaria entendi questao forma clara favor porfavor assunto'.split(' ')) stopwords.add(word);
export function tokenize(text: string) {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/(\p{L})-\s+(\p{L})/gu, '$1$2').match(/[\p{L}\p{N}]{2,}/gu)?.filter(t => !stopwords.has(t)) ?? [];
}
const windows1252Bytes = new Map(Object.entries({ '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f }));
export function repairMojibake(text: string) {
  if (!/(?:Ã.|Â.|â€|â€™|â€œ|â€�|�)/u.test(text)) return text;
  try {
    const bytes = Uint8Array.from([...text], character => character.charCodeAt(0) <= 0xff ? character.charCodeAt(0) : windows1252Bytes.get(character) ?? 0);
    const repaired = Buffer.from(bytes).toString('utf8');
    return repaired.includes('�') ? text : repaired;
  } catch { return text; }
}
export function normalize(text: string) { return text.normalize('NFC').replace(/\0/g, '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); }
// Legal texts read better when chunks respect article/clause boundaries instead of raw word windows.
const clauseBoundary = /(?=(?:Art\.\s?\d+|Artigo\s+\d+|Cláusula\s+\d+|§\s?\d+|CAPÍTULO\s+[IVXLCDM]+|TÍTULO\s+[IVXLCDM]+|SEÇÃO\s+[IVXLCDM]+)\b)/g;
export function chunkText(text: string, size = 300, overlap = 45) {
  if (size < 1 || overlap < 0 || overlap >= size) throw new Error('Tamanho de chunk inválido.');
  const segments = text.split(/\n{2,}/).flatMap(block => block.split(clauseBoundary)).map(s => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buffer: string[] = [], bufferWords = 0;
  const flush = () => { if (buffer.length) { chunks.push(buffer.join('\n\n')); buffer = []; bufferWords = 0; } };
  for (const segment of segments) {
    const words = segment.split(/\s+/).filter(Boolean);
    if (words.length > size) {
      flush();
      for (let i = 0; i < words.length; i += size - overlap) {
        chunks.push(words.slice(i, i + size).join(' '));
        if (i + size >= words.length) break;
      }
      continue;
    }
    if (bufferWords + words.length > size) flush();
    buffer.push(segment); bufferWords += words.length;
  }
  flush();
  return chunks;
}
