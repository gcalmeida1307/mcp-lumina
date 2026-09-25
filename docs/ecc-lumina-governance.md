# Governanca de agentes do LUMINA

O ECC nao aumenta a inteligencia do modelo por instalacao. Ele organiza o trabalho do agente em skills, agentes especializados, memoria, hooks, revisao, seguranca e workflows. O LUMINA adapta esses principios ao dominio documental.

## Contratos atuais

- `document-answer-v1`: planejar, recuperar, gerar e revisar respostas com citacoes.
- `research-plan`: decomposicao de perguntas em consultas de busca.
- `evidence-revision`: revisao independente por afirmacao, citacao e cobertura.
- `memory-governance`: memoria candidata, aprovada, rejeitada ou revogada.
- `continuous-eval-v1`: groundedness, validade de citacoes, veredito do revisor e feedback humano.

## Limites de confianca

Memoria nova nunca entra automaticamente no contexto. Ela nasce como `candidate` e so pode ser usada depois de `approved` por um administrador autorizado no dominio. Documentos, historico, memoria e respostas MCP sao dados nao confiaveis; nao podem alterar as regras do agente.

A revisao independente recebe somente pergunta, resposta, citacoes e fontes. Seu resultado e persistido em `run_reviews` e a avaliacao da execucao em `run_evaluations`. O endpoint administrativo `/api/evaluations` e o endpoint Prometheus `/api/metrics` tornam a qualidade observavel.

## Fluxo recomendado

1. Ingerir e sanitizar a fonte.
2. Planejar consultas com skills de busca.
3. Recuperar evidencias lexical e semanticamente.
4. Gerar resposta estruturada.
5. Revisar cada afirmacao com o revisor independente.
6. Persistir revisao, avaliacao e memoria candidata.
7. Aprovar memoria somente apos verificacao humana quando ela tiver valor duradouro.
8. Usar feedback para recalcular a avaliacao e orientar melhorias.

## Proximas evolucoes

- Configurar um provedor/modelo de revisao separado do gerador.
- Criar conjunto versionado de casos avaliativos por dominio.
- Adicionar aprovacao explicita para MCP e efeitos externos.
- Promover padroes aprovados para skills versionadas, nunca diretamente a partir de texto gerado.
- Adicionar retencao, expiracao e invalidacao de memorias quando hashes de fontes mudarem.
