# Migração cognitiva — Fase 1

## Mapa atual

`gateway → graph → socialReply/taskRouter → planner → retrieve → generate → judge → persistência`.
O provider expõe JSON e embeddings; a revisão usa o mesmo provider com modelo opcional.
Retrieval já aceita IDs de documentos, mas o Graph legado não transmite esse escopo.
Knowledge worker mantém índices auxiliares; MCP tem registry separado do Graph.

## Inventário e dependências

Preservar: autenticação/autorização (`security`, `gateway`), armazenamento (`data/storage`),
ingestão (`data/processing`), conhecimento (`core/knowledge`), MCP, frontend, auditoria,
telemetria, citações e embeddings. Nenhuma integração destrutiva nesta entrega.

Alterar: `core/llmops/provider.ts` (adaptadores e compatibilidade), `gateway/config.ts`
(opt-in), `core/orchestrator/graph.ts` (estado de investigação e Interpreter opcional).
Criar: contratos/registry de modelos, recursos, operações, Understanding, Interpreter,
estado de investigação, testes e README.
Candidatos futuros a remoção: taskRouter e evidenceResolver, somente após migração de
todos os consumidores. Nenhum arquivo removido na Fase 1.

## Fases

1. Contratos → registry/política → Interpreter → estado do Graph, mantendo caminho legado.
2. DocumentKnowledge versionado e mapa global; retrieval por escopo; READ do original;
   orçamento de contexto separado do acervo da investigação.
3. Agent Loop com operações autorizadas, limites de passos/tokens/tempo/ferramentas;
   raciocínio e claims; verificação que pode solicitar novas evidências.
4. Resposta natural após verificação, memória separada, visão e artefatos autorizados.
5. Avaliação A/B e revisão entre famílias sob política explícita; retirar legado validado.

## Riscos e validação

LOCAL não pode enviar dados para nuvem nem em fallback. Capacidades devem ser declaradas,
não deduzidas do nome do provider. Ollama é transporte, não família de modelo; revisão
independente exige famílias declaradas distintas. JSON inválido deve falhar fechado.
Recursos/histórico não concedem permissões nem autoridade. Não persistir chain-of-thought.
Acumular evidências não autoriza enviar todo o acervo ao modelo.

Testar seleção local, fallback permitido, privacidade, revisão entre famílias, JSON vs
texto, capacidades ausentes, referências inventadas, operações não autorizadas e
preservação de mais de dez evidências. Os cenários A–I do projeto serão cobertos
integralmente nas fases que entregam execução, ingestão visual e workspace.

Baseline e resultados finais são registrados ao concluir os comandos de validação.

## Validação da entrega

- Branch: `v3-agentic-rag`; nenhum merge realizado.
- Antes das alterações: `npm run check` passou; `npm test`: 58 testes, 55 pass, 3 fail.
- Após a Fase 1: `npm run check` passou; `npm test`: 69 testes, 66 pass, 3 fail.
- Os 11 testes novos passaram, incluindo integração opt-in do Interpreter no Graph.
- `git diff --check` passou.
- Testes usam transportes simulados; modelos reais/credenciais não foram exercitados.

As três falhas anteriores permanecem intactas: duas expectativas de rodapé “Fontes”
conflitam com o contrato explícito de citações inline; a terceira espera roteamento
comparativo e reparo específico que o pipeline atual não entrega (o mock também não
responde ao protocolo atual do router). Não foram alteradas para mascarar o baseline.
Essas regressões precisam de revisão na migração do fluxo de comparação/verificação.

A Fase 1 não executa o Agent Loop. Os limites no estado são contratos para o runtime
futuro, não um orçamento já imposto ao fluxo legado. A revisão entre famílias está
disponível pela API do registry, mas o judge legado ainda usa `reviewAnswer`.

## Continuação — executor cognitivo documental

O fluxo com `COGNITIVE_INTERPRETER=true` agora executa
`Interpreter → READ/SEARCH → síntese → verificação → nova coleta quando necessário`.
O valor padrão é `true`; sem provedor de geração, continua disponível o fluxo extrativo.
O Planner e o Task Router legados só participam do caminho de compatibilidade.

- Objetos e referências selecionados delimitam as operações; a validação também exige
  domínio e capacidade do recurso. Sugestões não concedem permissão de execução.
- READ consulta janelas dos originais no armazenamento; SEARCH recebe IDs explícitos.
- Textos delimitados por três crases são recursos distintos. Fora dessa marcação,
  a mensagem inteira é um recurso e a comparação pode citar trechos desse recurso.
- Originais permanecem no estado; a janela enviada ao modelo tem até 10 trechos e
  24 mil caracteres, com até 4 mil caracteres por trecho. A truncagem não prova ausência.
- O ciclo limita passos, chamadas de leitura/busca, tentativas e duração. Tokens são
  contabilizados após cada resposta; o provider não oferece reserva exata antecipada.
- Conversas sem consulta documental usam resposta textual. Revisão factual permanece
  uma chamada separada sob a política do registry, sem exigir família distinta.
- EXECUTE, cálculo especializado, ferramentas externas e ingestão visual não foram
  habilitados. A investigação continua transitória, sem persistência entre execuções.

A seção anterior registra o baseline histórico da Fase 1. Os testes de comparação
agora exercitam o protocolo do executor e verificam nova leitura após a revisão.
As duas expectativas de rodapé foram alinhadas ao contrato existente de citações
inline, que proíbe uma seção Fontes dentro da resposta.

Validação da continuação: `npm run build` passou (TypeScript e Vite), `npm test`
passou com 76 testes e nenhuma falha, e `git diff --check` passou. O Vite informou
apenas o aviso de bundles acima de 500 kB. Foram usados modelos simulados; não houve
validação contra um provedor real. Nenhum commit, merge ou deploy foi realizado.
