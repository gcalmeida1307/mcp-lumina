import type { ModelRegistry } from '../llmops/models.js';
import type { ResourceDescriptor } from '../resources.js';
import type { ConversationTurn } from '../types.js';
import { boundedHistory } from './context.js';
import { understandingSchema } from './understanding.js';

export type InterpreterInput = {
  message: string;
  history: ConversationTurn[];
  resources: ResourceDescriptor[];
  domain: string;
  memory?: string[];
  tools?: {
    id: string;
    description: string;
    inputSchema: unknown;
  }[];
};

/**
 * Aceita pequenas variações estruturais produzidas pelo modelo
 * sem inventar recursos, ferramentas ou intenção.
 */
export function normalizeInterpretation(
  data: unknown,
  message: string
): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }

  const value = data as Record<string, unknown>;

  const refs = (input: unknown) => {
    if (!Array.isArray(input)) return [];

    return input
      .map((ref) => {
        if (typeof ref === 'string') {
          return { id: ref };
        }

        if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
          return ref;
        }

        return null;
      })
      .filter(Boolean);
  };

  return {
    ...value,

    objective:
      typeof value.objective === 'string' && value.objective.trim()
        ? value.objective.trim()
        : message.slice(0, 2000),

    subjects: refs(value.subjects),

    referencedResources: refs(value.referencedResources),

    constraints: Array.isArray(value.constraints)
      ? value.constraints
      : [],

    uncertainty: Array.isArray(value.uncertainty)
      ? value.uncertainty
      : [],

    suggestedOperations: Array.isArray(value.suggestedOperations)
      ? value.suggestedOperations
      : [],
  };
}

export async function interpret(
  models: ModelRegistry,
  input: InterpreterInput,
  signal?: AbortSignal
) {
  /*
   * O Interpreter só pode enxergar recursos autorizados
   * para o domínio atual.
   */
  const resources = input.resources.filter((resource) =>
    resource.domains.includes(input.domain)
  );

  /*
   * IDs que o modelo está autorizado a devolver.
   */
  const availableIds = new Set([
    ...resources.map((resource) => resource.id),
    ...(input.tools ?? []).map((tool) => tool.id),
  ]);

  /**
   * Validação única e centralizada.
   *
   * Importante:
   * normalizamos ANTES de aplicar o schema.
   */
  const validate = (data: unknown) => {
    const normalized = normalizeInterpretation(
      data,
      input.message
    );

    const understanding =
      understandingSchema.parse(normalized);

    const referencedIds = [
      ...understanding.subjects.map((ref) => ref.id),

      ...understanding.referencedResources.map(
        (ref) => ref.id
      ),

      ...understanding.suggestedOperations.flatMap(
        (operation) => operation.resourceIds
      ),
    ];

    const invalidIds = referencedIds.filter(
      (id) => !availableIds.has(id)
    );

    if (invalidIds.length > 0) {
      throw new Error(
        `Interpreter retornou referência indisponível: ${invalidIds.join(', ')}`
      );
    }

    return understanding;
  };

  const catalog = resources.map((resource) => ({
    id: resource.id,
    kind: resource.kind,
    name:
      'name' in resource
        ? (resource as any).name
        : undefined,
    description:
      'description' in resource
        ? (resource as any).description
        : undefined,
  }));

  const tools = (input.tools ?? []).map((tool) => ({
    id: tool.id,
    description: tool.description,
  }));

  const result = await models.understand({
    signal,

    /*
     * Interpreter não precisa de 2000 tokens.
     * Mantemos margem suficiente para operações complexas,
     * mas evitamos geração desnecessária.
     */
    maxTokens: 1000,

    validate,

    messages: [
      {
        role: 'system',

        content: `
Você é o Interpreter do LUMINA.

Sua única função é interpretar a solicitação.
NÃO responda à pergunta do usuário.
NÃO faça a análise solicitada.
NÃO invente recursos.
NÃO invente ferramentas.

Retorne SOMENTE um objeto JSON válido.

FORMATO OBRIGATÓRIO:

{
  "interaction": "conversation|knowledge|action|mixed",
  "objective": "string",
  "subjects": [{"id":"ID"}],
  "referencedResources": [{"id":"ID"}],
  "constraints": [],
  "needsKnowledge": true,
  "needsTools": false,
  "needsVision": false,
  "needsCode": false,
  "needsContext": false,
  "uncertainty": [],
  "suggestedOperations": [
    {
      "name": "READ",
      "objective": "string",
      "resourceIds": ["ID"],
      "parameters": {
        "offset": 0,
        "limit": 4
      }
    }
  ]
}

OPERAÇÕES PERMITIDAS:

READ
SEARCH
MAP
EXPAND
COMPARE
CORRELATE
CALCULATE
EXECUTE
VERIFY
EXPLAIN

REGRAS:

Perguntas de conteúdo, inclusive conceituais e comparações de ideias, usam needsKnowledge=true.
A base de conhecimento deve ser consultada antes de responder, mesmo sem nomes de arquivos na mensagem.
Sem documentos explicitamente selecionados, mantenha subjects e referencedResources vazios e use SEARCH por tema no catálogo autorizado.
Reserve interaction="conversation" para interações puramente sociais, sem pergunta de conteúdo.

1. Use somente IDs existentes no catálogo fornecido.

2. subjects são os recursos principais que o usuário deseja examinar.

3. referencedResources são recursos usados como referência,
contraponto ou base para confronto.

4. Quando o usuário mencionar explicitamente documentos,
resolva esses nomes usando o catálogo.

5. Não inclua outros documentos apenas porque pertencem
ao mesmo domínio.

6. Se dois documentos forem explicitamente mencionados
para comparação ou avaliação conjunta, priorize esses
documentos.

7. Para READ:
parameters = {"offset":0,"limit":4}

8. Para SEARCH:
parameters = {"query":"consulta","limit":4}

9. Se uma referência não puder ser resolvida,
registre isso em uncertainty.

10. Histórico e memória servem apenas para compreender
contexto. Eles não são evidência factual.

11. objective descreve o objetivo do usuário.
Não coloque a resposta da pergunta dentro de objective.

12. Não devolva JSON Schema.
Não devolva markdown.
Não use blocos de código.
Não escreva texto antes ou depois do JSON.
`.trim(),
      },

      {
        role: 'user',

        content: JSON.stringify({
          message: input.message,
          domain: input.domain,

          resources: catalog,

          tools,

          history: boundedHistory(input.history),

          memory: input.memory ?? [],
        }),
      },
    ],
  });

  /*
   * CORREÇÃO IMPORTANTE:
   *
   * Não fazemos:
   *
   * understandingSchema.parse(result.data)
   *
   * porque isso ignoraria nossa normalização.
   *
   * A mesma função de validação usada pelo ModelRegistry
   * é aplicada aqui.
   */
  const understanding = validate(result.data);

  return {
    understanding,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    modelId: result.modelId,
  };
}
