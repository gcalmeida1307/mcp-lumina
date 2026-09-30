# LUMINA

> O LUMINA não deve procurar uma resposta. Deve compreender o problema, descobrir o conhecimento necessário, usar os recursos disponíveis, verificar o que descobriu e então responder.

O fluxo cognitivo documental é o padrão quando há um modelo configurado: Interpreter,
leitura e busca iterativas, resposta e verificação com retorno à coleta.
A fundação da Fase 1 permanece; ferramentas externas e visão continuam fora deste executor.

Consulte o [mapa e plano de migração](docs/cognitive-migration.md).

## Model Registry

`ModelRegistry` oferece `understand`, `structured`, `reason`, `vision`, `code`,
`respond`, `review` e `embed`. Uma chamada seleciona um modelo por capacidade e
política. Nenhum modo dispara todos os modelos automaticamente.

- `LOCAL`: somente modelos marcados locais; padrão do novo registry.
- `HYBRID`: locais primeiro; remoto exige `allowRemote`, fallback exige `allowFallback`.
- `ENSEMBLE`: permite compor revisões explícitas, sem votação ou fan-out automático.

`review(request, authorModelId)` exige `crossFamilyReview` e famílias declaradas
diferentes. Ollama é um transporte: configure a família real (por exemplo, qwen).
Revisão de modelo não substitui validação de citações e proveniência.

`createChatProvider` registra Ollama, OpenAI, Anthropic e endpoints Gemini compatíveis
com Chat Completions. Para Gemini, configure explicitamente `LLM_BASE_URL` e chave;
não há descoberta automática de endpoints ou capacidades. Vision/coding precisam de
declaração explícita para o modelo instalado. Embeddings podem ser registrados com
implementação própria; a API legada `embed` mantém configuração e validações existentes.

## Fluxo cognitivo

```dotenv
LLM_PROVIDER=ollama
LLM_MODEL=seu-modelo-instalado
MODEL_FAMILY=familia-do-modelo
MODEL_MODE=LOCAL
COGNITIVE_INTERPRETER=true
```

O Interpreter seleciona os objetos e referências. O executor lê os originais e pode
buscar conceitos ou avançar a janela de leitura nos recursos selecionados. A revisão
recebe as evidências e pode devolver lacunas para nova coleta. Conversas sem necessidade
de conhecimento usam resposta textual sem retrieval. Blocos de texto cercados por três
crases são recursos separados; mensagens sem essa marcação ficam como um único recurso.
Texto do usuário só é consultado quando explicitamente selecionado pelo Interpreter.

READ e SEARCH são as operações executáveis. Comparação e explicação acontecem na síntese
verificada; código, cálculo especializado, visão e ferramentas externas não são executados.
Todos os originais coletados ficam no estado transitório; a janela de geração limita-se a
10 trechos, 4 mil caracteres por trecho e 24 mil caracteres no total. O ciclo admite até
12 passos, 8 leituras/buscas, 2 tentativas adicionais e 180 segundos. O consumo informado
pelo provider é conferido a cada resposta contra 24 mil tokens; uma chamada em andamento
pode ultrapassar esse limiar, mas seu resultado não será aceito.

Geração e revisão usam o ModelRegistry sob a mesma política de privacidade. A revisão é
uma chamada separada, sem garantia de família diferente. Embeddings mantêm a configuração
existente: para uso local, configure também seu endpoint local ou desative embeddings.
Sem provedor de geração, permanece a recuperação extrativa. O estado não é memória persistente.

Desative `COGNITIVE_INTERPRETER` para comparar com o router anterior.
`npm run check` verifica tipos; `npm test` executa a suíte.

### Provedor remoto já configurado

Se `LLM_PROVIDER` aponta para OpenAI, Anthropic ou Gemini, o fluxo cognitivo exige
permissão explícita para o provedor remoto: `MODEL_MODE=HYBRID` e
`MODEL_ALLOW_REMOTE=true`. Reinicie a API após alterar o `.env`. O padrão `LOCAL`
continua bloqueando envio a esses provedores; configurar uma chave não altera essa
política. Incompatibilidades agora retornam um diagnóstico específico em vez de uma
mensagem genérica de consulta incompleta.
