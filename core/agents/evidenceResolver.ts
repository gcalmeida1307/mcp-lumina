import { z } from 'zod';

import { generate } from '../llmops/provider.js';
import { generationEnabled } from '../../gateway/config.js';

import type {
  Evidence
} from '../types.js';

import type {
  Intent
} from '../orchestrator/taskRouter.js';


export interface EvidenceTopic {
  id: string;
  topic: string;
  description?: string;
  terms: string[];
  sourceEvidenceIds: string[];
}


export interface EvidenceExpansionQuery {
  topicId: string;
  topic: string;
  query: string;
}


export interface EvidencePair {
  topicId: string;
  topic: string;
  left: Evidence[];
  right: Evidence[];
}


export interface EvidenceResolution {
  topics: EvidenceTopic[];
  queries: EvidenceExpansionQuery[];
  pairs: EvidencePair[];
  inputTokens: number;
  outputTokens: number;
}


export interface ResolveEvidenceInput {
  objective: string;
  question: string;
  intents: Intent[];
  evidence: Evidence[];
  documentNames: string[];
  maxTopics?: number;
}


const topicSchema = z.object({
  topic: z
    .string()
    .min(1)
    .max(200),

  description: z
    .string()
    .max(500)
    .optional(),

  terms: z
    .array(
      z.string()
        .min(1)
        .max(150)
    )
    .min(1)
    .max(8),

  evidenceIds: z
    .array(
      z.string()
        .min(1)
        .max(500)
    )
    .max(20)
    .default([])
});


const resolutionSchema = z.object({
  topics: z
    .array(topicSchema)
    .max(8)
});


function normalize(
  value: string
): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}


function compact(
  value: string,
  max: number
): string {
  const clean =
    value
      .replace(/\s+/g, ' ')
      .trim();

  if (
    clean.length <= max
  ) {
    return clean;
  }

  return clean
    .slice(0, max)
    .trim();
}


function uniqueStrings(
  values: string[]
): string[] {
  const result: string[] = [];
  const seen =
    new Set<string>();

  for (
    const value of values
  ) {
    const clean =
      value
        .replace(/\s+/g, ' ')
        .trim();

    if (!clean) {
      continue;
    }

    const key =
      normalize(clean);

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);
    result.push(clean);
  }

  return result;
}


function makeTopicId(
  topic: string,
  index: number
): string {
  const slug =
    normalize(topic)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

  return slug
    ? `topic-${index + 1}-${slug}`
    : `topic-${index + 1}`;
}


// FIX 1: Permitir expansão para perguntas diretas, conceituais e exploratórias
function relevantForExpansion(
  intents: Intent[]
): boolean {
  if (!intents || intents.length === 0) return true;

  const validIntents: string[] = [
    'compare',
    'investigate',
    'analyze',
    'explain',
    'overview',
    'summarize',
    'search',
    'document_rag'
  ];

  return intents.some(intent => validIntents.includes(intent as string));
}


function groupByDocument(
  evidence: Evidence[]
): Map<string, Evidence[]> {
  const groups =
    new Map<string, Evidence[]>();

  for (
    const item of evidence
  ) {
    const current =
      groups.get(
        item.documentId
      ) ?? [];

    current.push(item);

    groups.set(
      item.documentId,
      current
    );
  }

  return groups;
}


function evidenceContainsTopic(
  evidence: Evidence,
  topic: EvidenceTopic
): boolean {
  const haystack =
    normalize(
      [
        evidence.title,
        evidence.text
      ]
        .filter(Boolean)
        .join(' ')
    );

  const candidates =
    uniqueStrings([
      topic.topic,
      ...topic.terms
    ]);


  return candidates.some(
    candidate => {
      const needle =
        normalize(candidate);

      return (
        needle.length >= 3 &&
        haystack.includes(needle)
      );
    }
  );
}


function buildPairs(
  topics: EvidenceTopic[],
  evidence: Evidence[]
): EvidencePair[] {
  const groups =
    groupByDocument(evidence);

  const documentIds = [
    ...groups.keys()
  ];


  if (
    documentIds.length < 2
  ) {
    return [];
  }


  const leftDocument =
    documentIds[0];

  const rightDocuments =
    documentIds.slice(1);


  const result: EvidencePair[] = [];


  for (
    const topic of topics
  ) {
    const left =
      (
        groups.get(leftDocument) ??
        []
      ).filter(
        item =>
          evidenceContainsTopic(
            item,
            topic
          )
      );


    const right =
      rightDocuments.flatMap(
        documentId =>
          (
            groups.get(documentId) ??
            []
          ).filter(
            item =>
              evidenceContainsTopic(
                item,
                topic
              )
          )
      );


    if (
      left.length &&
      right.length
    ) {
      result.push({
        topicId:
          topic.id,

        topic:
          topic.topic,

        left,

        right
      });
    }
  }


  return result;
}


function buildExpansionQueries(
  topics: EvidenceTopic[]
): EvidenceExpansionQuery[] {
  const queries:
    EvidenceExpansionQuery[] = [];


  for (
    const topic of topics
  ) {
    const terms =
      uniqueStrings([
        topic.topic,
        ...topic.terms
      ])
        .slice(0, 5);


    if (
      !terms.length
    ) {
      continue;
    }


    queries.push({
      topicId:
        topic.id,

      topic:
        topic.topic,

      query:
        terms.join(' ')
    });
  }


  return queries;
}


function fallbackTopics(
  evidence: Evidence[],
  maxTopics: number,
  question: string = ''
): EvidenceTopic[] {
  const words =
    new Map<
      string,
      {
        original: string;
        count: number;
        evidenceIds: Set<string>;
      }
    >();


  const stopWords =
    new Set([
      'para',
      'como',
      'com',
      'uma',
      'uns',
      'umas',
      'que',
      'dos',
      'das',
      'por',
      'pela',
      'pelo',
      'pelas',
      'pelos',
      'este',
      'esta',
      'esse',
      'essa',
      'isso',
      'isto',
      'aos',
      'nas',
      'nos',
      'seu',
      'sua',
      'seus',
      'suas',
      'ser',
      'sao',
      'não',
      'nao',
      'mais',
      'menos',
      'entre',
      'sobre',
      'quando',
      'onde',
      'qual',
      'quais',
      'artigo',
      'pagina',
      'documento',
      'fale',
      'sobre',
      'me'
    ]);

  // FIX 2: Se houver pergunta, extrair termos principais para não zerar os tópicos
  if (question) {
    const questionTokens = normalize(question)
      .split(/[^a-z0-9]+/g)
      .filter(t => t.length >= 3 && !stopWords.has(t));

    if (questionTokens.length > 0) {
      const mainTopic = questionTokens.join(' ');
      const sourceIds = evidence.map(e => e.id);
      return [
        {
          id: makeTopicId(mainTopic, 0),
          topic: mainTopic,
          terms: questionTokens,
          sourceEvidenceIds: sourceIds
        }
      ];
    }
  }

  for (
    const item of evidence
  ) {
    const tokens =
      normalize(item.text)
        .split(
          /[^a-z0-9]+/g
        )
        .filter(
          token =>
            token.length >= 4 &&
            !stopWords.has(token)
        );


    const unique =
      new Set(tokens);


    for (
      const token of unique
    ) {
      const current =
        words.get(token) ?? {
          original:
            token,

          count:
            0,

          evidenceIds:
            new Set<string>()
        };


      current.count += 1;

      current.evidenceIds.add(
        item.id
      );

      words.set(
        token,
        current
      );
    }
  }


  return [
    ...words.values()
  ]
    .sort(
      (a, b) =>
        b.count - a.count
    )
    .slice(
      0,
      maxTopics
    )
    .map(
      (entry, index) => ({
        id:
          makeTopicId(
            entry.original,
            index
          ),

        topic:
          entry.original,

        terms: [
          entry.original
        ],

        sourceEvidenceIds: [
          ...entry.evidenceIds
        ]
      })
    );
}


function normalizeTopics(
  raw: z.infer<
    typeof resolutionSchema
  >,
  evidence: Evidence[],
  maxTopics: number
): EvidenceTopic[] {
  const evidenceIds =
    new Set(
      evidence.map(
        item =>
          item.id
      )
    );


  const result:
    EvidenceTopic[] = [];

  const seen =
    new Set<string>();


  for (
    const item of raw.topics
  ) {
    const topic =
      compact(
        item.topic,
        200
      );

    const key =
      normalize(topic);


    if (
      !topic ||
      seen.has(key)
    ) {
      continue;
    }


    const terms =
      uniqueStrings([
        topic,
        ...item.terms
      ])
        .slice(0, 8);


    if (
      !terms.length
    ) {
      continue;
    }


    const sourceEvidenceIds =
      uniqueStrings(
        item.evidenceIds
      ).filter(
        id =>
          evidenceIds.has(id)
      );


    seen.add(key);


    result.push({
      id:
        makeTopicId(
          topic,
          result.length
        ),

      topic,

      description:
        item.description
          ? compact(
              item.description,
              500
            )
          : undefined,

      terms,

      sourceEvidenceIds: sourceEvidenceIds.length ? sourceEvidenceIds : evidence.map(e => e.id)
    });


    if (
      result.length >=
      maxTopics
    ) {
      break;
    }
  }


  return result;
}


export async function resolveEvidence(
  input: ResolveEvidenceInput
): Promise<EvidenceResolution> {
  const maxTopics =
    Math.max(
      1,
      Math.min(
        input.maxTopics ?? 5,
        8
      )
    );


  if (
    !input.evidence.length &&
    !input.question
  ) {
    return {
      topics: [],
      queries: [],
      pairs: [],
      inputTokens: 0,
      outputTokens: 0
    };
  }


  if (
    !relevantForExpansion(
      input.intents
    )
  ) {
    const topics = fallbackTopics(input.evidence, maxTopics, input.question);
    return {
      topics,
      queries: buildExpansionQueries(topics),
      pairs: buildPairs(topics, input.evidence),
      inputTokens: 0,
      outputTokens: 0
    };
  }


  if (
    !generationEnabled()
  ) {
    const topics =
      fallbackTopics(
        input.evidence,
        maxTopics,
        input.question
      );


    return {
      topics,

      queries:
        buildExpansionQueries(
          topics
        ),

      pairs:
        buildPairs(
          topics,
          input.evidence
        ),

      inputTokens: 0,
      outputTokens: 0
    };
  }


  try {
    const evidencePayload =
      input.evidence.map(
        item => ({
          id:
            item.id,

          documentId:
            item.documentId,

          document:
            item.title,

          page:
            item.page,

          text:
            compact(
              item.text,
              1800
            )
        })
      );


    const result =
      await generate(
        [
          {
            role:
              'system',

            content:
              `
Você é o Evidence Resolver do LUMINA.

Sua função é descobrir tópicos, conceitos e entidades concretos presentes nas evidências recuperadas que sejam úteis para continuar uma investigação ou responder conceitualmente ao usuário.

Você NÃO responde à pergunta do usuário diretamente.
Você NÃO decide se existe ilegalidade, erro, conflito ou contradição.
Você NÃO cria conclusões definitivas.
Você NÃO inventa artigos, cláusulas, normas, páginas, fatos ou relações entre documentos.
Você NÃO assume que dois trechos são equivalentes apenas porque pertencem ao mesmo domínio.

Sua saída será usada para realizar novas buscas documentais ou compor a fundamentação da resposta.

OBJETIVO

Dado:

- objetivo da investigação;
- pergunta do usuário;
- intenções;
- documentos disponíveis;
- evidências iniciais;

identifique os principais tópicos concretos que devem ser aprofundados ou explicados.

Um tópico deve surgir das evidências fornecidas ou ser derivado da dúvida conceitual do usuário.

Exemplos genéricos de bons tópicos:

- jornada de trabalho
- rescisão
- adicional de horas extras
- política de acesso
- contraindicação
- dosagem
- retenção de dados
- prazo contratual

Esses são apenas exemplos de formato.
Prefira tópicos relevantes ao contexto fornecido.

EVITE TÓPICOS GENÉRICOS

Evite:

- problemas jurídicos
- legislação
- direitos
- documento
- análise
- comparação
- possíveis problemas
- informações
- regras
- questões

Prefira o conceito concreto encontrado no conteúdo ou na pergunta.

EVIDÊNCIA

Cada tópico deve ser sustentado pelas evidências fornecidas.

Use evidenceIds para informar quais evidências originaram o tópico.

TERMOS

Para cada tópico, forneça termos úteis para busca documental.

Os termos podem incluir:

- sinônimos;
- variações terminológicas;
- conceitos diretamente relacionados;
- expressão técnica presente na evidência.

Se a pergunta do usuário for conceitual (ex: "me fale sobre hora extra"), inclua termos amplos como "jornada", "adicional", "horas extraordinarias", "ponto", "banco de horas".

COMPARAÇÃO

Se a intenção incluir "compare", descubra O QUE deve ser pesquisado nos documentos.

INVESTIGAÇÃO / EXPLICAÇÃO

Sintetize e mapeie os conceitos fundamentais para garantir que o gerador de resposta tenha trechos validados.

SAÍDA

Retorne somente JSON válido:

{
  "topics": [
    {
      "topic": "nome concreto do tópico",
      "description": "por que este tópico é relevante para a investigação ou resposta",
      "terms": [
        "termo 1",
        "termo 2"
      ],
      "evidenceIds": [
        "id-real-da-evidencia"
      ]
    }
  ]
}

Retorne no máximo ${maxTopics} tópicos.

Se as evidências não permitirem identificar tópicos concretos, deduza do tema central da pergunta do usuário.
              `.trim()
          },

          {
            role:
              'user',

            content:
              JSON.stringify({
                objective:
                  input.objective,

                question:
                  input.question,

                intents:
                  input.intents,

                availableDocuments:
                  input.documentNames,

                evidence:
                  evidencePayload
              })
          }
        ],

        1800
      );


    const parsed =
      resolutionSchema.safeParse(
        result.data
      );


    if (
      !parsed.success
    ) {
      const topics =
        fallbackTopics(
          input.evidence,
          maxTopics,
          input.question
        );


      return {
        topics,

        queries:
          buildExpansionQueries(
            topics
          ),

        pairs:
          buildPairs(
            topics,
            input.evidence
          ),

        inputTokens:
          result.inputTokens,

        outputTokens:
          result.outputTokens
      };
    }


    const topics =
      normalizeTopics(
        parsed.data,
        input.evidence,
        maxTopics
      );


    return {
      topics,

      queries:
        buildExpansionQueries(
          topics
        ),

      pairs:
        buildPairs(
          topics,
          input.evidence
        ),

      inputTokens:
        result.inputTokens,

      outputTokens:
        result.outputTokens
    };
  } catch {
    const topics =
      fallbackTopics(
        input.evidence,
        maxTopics,
        input.question
      );


    return {
      topics,

      queries:
        buildExpansionQueries(
          topics
        ),

      pairs:
        buildPairs(
          topics,
          input.evidence
        ),

      inputTokens: 0,
      outputTokens: 0
    };
  }
}