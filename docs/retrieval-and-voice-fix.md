# Correção de mudança de assunto e experiência de voz

## Diagnóstico observado

Em 24/09/2026, Medicina tinha 1.399 trechos publicados e apenas 83 vetores compatíveis com o modelo configurado. Os vetores concentravam-se em ética e prontuário. O histórico recente continha perguntas sobre gripe e CID-10 que recuperaram novamente essas fontes antigas.

O índice textual já continha os documentos de CID-10 e suas referências a gripe. Três comportamentos contribuíam para a falha:

1. A consulta de recuperação incluía até seis perguntas e respostas anteriores, mesmo quando a pergunta mudava de assunto. Colocar a pergunta atual no fim não conferia prioridade ao BM25 nem ao embedding.
2. A fusão de rankings favorecia documentos presentes simultaneamente na busca textual e no pequeno subconjunto vetorizado. A reordenação posterior também desfazia a diversidade das fontes.
3. A indexação em segundo plano não retomava documentos após reinicialização e só invalidava o cache no fim do documento.

## Alterações

- Perguntas independentes buscam seu próprio assunto. Apenas referências explícitas, como “qual deles”, herdam uma pergunta recente. Respostas geradas não viram termos de busca. A detecção é heurística e ainda pode precisar de ajuste para referências ambíguas.
- Consulta atual preservada mesmo no modo com planejamento. Contexto antigo não é enviado à geração para perguntas independentes.
- Peso específico para título e palavras úteis; expressões conversacionais comuns não dominam a busca. Relevância textual normalizada governa candidatos quando há correspondências; vetores ajudam na ordenação e assumem a recuperação quando não há correspondência textual. Essa política privilegia termos explícitos e não equivale a um reranker semântico treinado.
- Diversidade de fontes mantida e falha do provedor de embeddings não impede a busca textual. Consulta vetorial limitada a uma tentativa com timeout de 12 segundos.
- Fila de embeddings serializada, alternando lotes entre documentos, retomada ao iniciar a API e invalidando cache a cada lote. O mapa mostra trechos pendentes do modelo atual. Editores autorizados podem usar **Retomar indexação**; não é necessário excluir e reenviar arquivos.
- Relações do mapa calculadas em todo o domínio, independentemente da página/filtro. Conexões com documentos externos à página ficam navegáveis no painel. Busca do mapa considera também conteúdo. Vetores de amostras com cobertura inferior à metade não são usados para representar um documento inteiro; nesse caso, usa-se comparação lexical. Similaridade continua sendo uma aproximação, não causalidade ou prova clínica.

## Voz

**Voz e personalidade** permite escolher a voz portuguesa instalada, ouvir uma amostra e selecionar estilos **Acolhedora**, **Objetiva** ou **Serena**. O padrão prefere nomes conhecidos de vozes femininas, com escolha manual e fallback. A API do navegador não expõe gênero, portanto essa preferência é heurística e não garante que toda instalação possua uma voz feminina. Ritmo e tom variam conforme o sintetizador; não há clonagem nem modelo emocional de voz.

A resposta da LUMINA usa tom acolhedor e profissional sem relaxar as exigências de evidência. O novo painel usa esfera luminosa, órbitas, partículas e ondas com estados distintos de escuta, consulta e fala. As ondas representam o estado da sessão, não amplitude medida do microfone. Movimentos são desativados com a preferência de acessibilidade por movimento reduzido.

## Validação

- 22 testes automatizados passaram, incluindo regressão de ética/prontuário → gripe, orquestração completa com corpus de teste, consulta CID-10 por título, falha de embeddings, isolamento de domínio, relações fora da página e seleção de voz.
- Consulta de recuperação com o corpus real passou a retornar CID-10 Subcategorias, Categorias e Grupos para a pergunta sobre gripe, em lugar dos documentos antigos.
- Build de produção concluído. O bundle principal ainda gera aviso de tamanho do Vite.
- A retomada real foi observada: 83 → 261 vetores compatíveis durante a verificação. Esse número é uma fotografia; a fila continua em segundo plano, e falhas do provedor podem exigir retomar a indexação.
- Não foi feita validação auditiva com microfone/alto-falante nem inspeção visual por navegador automatizado. O teste da recuperação não assegura uma resposta médica completa: a geração continua limitada ao que os documentos recuperados sustentam.

Referências da API de voz: [SpeechSynthesisVoice](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice), [voiceschanged](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/voiceschanged_event), [pitch](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/pitch).
