# Conhecimento em segundo plano

A implementação adapta a separação de responsabilidades e execução com limites mostrada no vídeo à arquitetura do LUMINA: publicar documentos → enfileirar → preparar embeddings e candidatos → verificar evidências → disponibilizar relações persistidas para o explorador e para a busca.

## Funcionamento

- A publicação continua liberando o índice textual sem esperar pelo provedor de embeddings. A mudança para `ready` e o enfileiramento são atômicos.
- `knowledge_jobs` guarda estado, versão de conteúdo/configuração, cursor, tentativas, próxima execução e uma reserva temporária (`lease`). Jobs duplicados não são recriados. Uma reserva vencida pode ser retomada; o trabalhador antigo não pode confirmar o resultado.
- A inicialização retoma documentos existentes. Novos documentos e alterações de conteúdo/metadados geram trabalho incremental. Exclusões removem fila, termos, relações e histórico associado.
- Um trabalhador por instância executa um lote por vez. O padrão é dois embeddings por lote, cinco documentos candidatos e amostras de até 32 trechos distribuídas pelo documento.
- Um índice de termos no banco seleciona os candidatos do mesmo domínio. Não há comparação de todos os documentos contra todos. Os vetores disponíveis ajudam a classificar os pares selecionados.
- O verificador `shared-statement-v1` confirma somente a presença de uma mesma frase nas duas fontes, com referências aos dois trechos. Similaridade lexical/vetorial sem essa evidência permanece candidata. A confiança 1 refere-se à correspondência textual exata, **não à verdade da frase, independência das fontes ou aplicabilidade de uma regra**. Não há julgamento interpretativo por LLM nesta versão, nem custo adicional de geração para correlações.
- As relações guardam hashes das fontes, versão do verificador, data e evidências; `knowledge_history` mantém versões anteriores. Hashes divergentes impedem uso de relações antigas.
- O chat lê apenas relações já confirmadas e pode ajustar em 2% a classificação de trechos que já passaram pelo filtro de relevância. Não acrescenta afirmações ao contexto e não espera processamento da fila. Uma falha nessa leitura preserva a busca normal.
- O explorador lê relações prontas, mostra candidatas e trechos confirmados, e permite inspecionar as duas fontes ao clicar em uma relação confirmada. O estado da fila é atualizado ao abrir o módulo ou acionar Atualizar mapa.

## Proteção da latência

O início de uma consulta pausa a admissão de trabalho de fundo e aborta a requisição de embedding em curso. A retomada espera todas as consultas terminarem e mais 1,5 segundo. Um provedor remoto pode continuar computando após o cancelamento HTTP; esse comportamento depende do provedor. Atrasos de mais de 100 ms no agendador também adiam o lote seguinte. Transações não incluem chamadas a modelos; amostragem, lotes pequenos e devolução do controle ao event loop limitam trabalho local contínuo.

O controle de prioridade e a concorrência são **por instância do servidor**. A reserva de jobs impede execução duplicada de um mesmo job entre instâncias, mas não implementa prioridade global de chat em um cluster. SQLite continua sendo a opção local; o repositório também implementa SQL para PostgreSQL. A validação executada nesta alteração usou SQLite, não uma instância real de PostgreSQL.

## Operação

Reinicie o servidor para carregar a alteração. A criação das tabelas e a retomada são automáticas e aditivas. Não é necessário reenviar os documentos publicados. O processamento inicial pode levar tempo; a busca textual continua disponível enquanto isso.

Configuração em `.env` (os valores abaixo já são os padrões):

```dotenv
KNOWLEDGE_ENABLED=true
KNOWLEDGE_POLL_MS=1500
KNOWLEDGE_MAX_LAG_MS=100
KNOWLEDGE_TOP_K=5
KNOWLEDGE_MAX_ATTEMPTS=3
KNOWLEDGE_EMBEDDING_BATCH=2
KNOWLEDGE_EMBEDDING_TIMEOUT_MS=180000
```

`KNOWLEDGE_ENABLED=false` desativa o trabalhador e o enriquecimento da busca; preserva os registros para retomada posterior. O timeout mantém margem para provedores locais lentos, com cancelamento ao chegar uma consulta. As tentativas usam espera exponencial; após o limite, o job permanece `failed` para inspeção/reprocessamento. Reservas de processos interrompidos expiram após o timeout configurado mais 30 segundos.

Endpoints autenticados:

- `GET /api/knowledge/status?domain=...`: contagens por estado, candidatas, confirmadas e pausa por chat. Exige leitura do domínio.
- `POST /api/knowledge/reprocess`, corpo `{"domain":"..."}`: reprocessa documentos prontos, incluindo falhas. Exige escrita no domínio e registra auditoria.
- `POST /api/neural-map/reindex`: mantém compatibilidade com a retomada de embeddings existente.

Métricas Prometheus: `lumina_knowledge_jobs_total` por tipo/resultado e `lumina_knowledge_job_seconds`. A auditoria registra correlações concluídas e solicitações de reprocessamento. O histórico persiste no banco; não há uma tela de comparação de versões nesta entrega.

## Verificação

```powershell
npm run build
npm test
npm run benchmark:knowledge
```

Os testes cobrem reserva concorrente, recuperação, deduplicação, evidência bilateral, rejeição de instruções e afirmações diferentes, isolamento por domínio, atualização/exclusão, prioridade do chat, cancelamento de embeddings, tentativas e cursores persistidos. Também continuam passando as regressões existentes de voz, upload, conversa, busca e importação web.

Benchmark sintético local de 25/09/2026: SQLite, 40 documentos, 1.000 trechos, 60 amostras por modo após aquecimento, consultas sem cache e sem modelo externo. Mediana: 60,10 ms sem enriquecimento e 60,70 ms com enriquecimento; p95: 62,66 ms e 63,66 ms. A diferença observada foi de 0,60 ms na mediana. Isso mede a recuperação documental nessa carga, não constitui garantia de latência total do chat ou de desempenho em PostgreSQL/produção. O comando cria e remove uma base temporária; não acessa a base real.
