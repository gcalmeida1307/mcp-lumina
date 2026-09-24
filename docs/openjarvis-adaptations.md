# Melhorias de interface, navegação e conversa

Implementação em 24/09/2026. Referência revisada: [OpenJarvis](https://github.com/open-jarvis/OpenJarvis), incluindo os arquivos da cópia em `work/references/OpenJarvis`. As funcionalidades abaixo foram adaptadas à arquitetura TypeScript do LUMINA; o runtime Python do OpenJarvis não foi instalado nem incorporado.

## Entregue

- Paleta violeta compartilhada entre a página, menus, painéis, chat e mapa, centralizada em `frontend/src/theme.css`. Cores semânticas de status e identidade dos módulos continuam distinguíveis.
- Constelação em todos os níveis: LUMINA no centro dos módulos; módulo no centro dos documentos; documento no centro dos trechos. Breadcrumbs, retorno, busca, paginação, lista, zoom e minimapa continuam disponíveis. Um módulo vazio ainda exibe seu núcleo.
- Sessão de voz por turnos: reconhecer português, mostrar transcrição, enviar automaticamente após 1,3 segundo de pausa com resultado final, ler a resposta e retomar a escuta. Botões para interromper a leitura e encerrar a sessão.
- A sessão encerra ao trocar de página, módulo ou conversa, ocultar a aba ou desmontar a aplicação. O microfone fica desativado durante consulta e reprodução, evitando que a resposta seja captada como pergunta. Encerrar cancela a espera no navegador e ignora callbacks atrasados; uma consulta já recebida pelo servidor pode terminar e ficar no histórico.
- Saudações, agradecimentos e apresentação usam respostas sociais explícitas, sem custo de geração. Perguntas sobre documentos continuam no fluxo de recuperação e verificação. Uma saudação seguida de pergunta factual não contorna a recuperação.
- Suporte explícito a Ollama para geração sem chave paga, com endpoint separado, sem encaminhamento automático para nuvem e sem enviar credenciais do provedor em nuvem ao Ollama.
- Contexto limitado a seis turnos factuais recentes, até 9.000 caracteres de conteúdo, com truncamento de perguntas e respostas. O histórico completo persistido não é alterado. É compressão determinística, não memória aprendida ou resumo por IA.

## Relação com OpenJarvis

| Referência | Adaptação |
| --- | --- |
| `speech/voice_io.py`, `cli/_voice_chat.py` | Sessão de voz, parada após silêncio, ciclo de resposta e recuperação de erros, usando as APIs do navegador disponíveis no LUMINA. |
| Modelo de execução local descrito no README | Backend Ollama selecionável, sem depender de chave de provedor em nuvem. |
| `sessions/compression.py` | Orçamento de contexto e truncamento determinístico de turnos recentes, sem chamada adicional ao modelo. |

## Como usar

No chat, clique em **Conversar por voz**, autorize o microfone e fale. Depois da resposta, a escuta recomeça automaticamente. **Interromper e falar** interrompe a leitura; **Encerrar voz** termina a sessão. Não há escuta simultânea durante a leitura nem detecção de palavra de ativação.

O reconhecimento depende da Web Speech API do navegador e pode enviar áudio ao serviço do navegador; não é prometido funcionamento offline. A leitura usa uma voz portuguesa disponível no sistema/navegador. Negação de permissão, ausência de microfone, falha de rede ou de reprodução encerram a sessão com mensagem. A resposta textual continua disponível.

Para geração local, instale/inicie o Ollama e baixe um modelo que suporte saída JSON. No `.env` do servidor:

```dotenv
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=nome-do-modelo-instalado
```

Reinicie a API. Essa opção não foi ativada sobre a configuração existente do usuário. A configuração de embeddings permanece independente.

## Validação e limites

Testes automatizados cobrem ciclos de voz com adaptadores simulados, envio único, pausa, interrupção, cancelamento e callbacks atrasados; espaçamento das órbitas; intents sociais; orçamento de contexto; requisição Ollama sem credenciais e sem fallback. Não equivalem a um teste de microfone ou alto-falante físico. A validação de áudio real e a inspeção visual precisam ser feitas no navegador.

Não foram importados agentes com execução de shell, conectores de contas, treinamento automático, memória aprendida, rotinas agendadas, STT Whisper nem TTS Kokoro do OpenJarvis. Esses recursos exigem infraestrutura, modelos, credenciais ou políticas próprias e não são oferecidos como recursos já implementados.

Fontes técnicas: [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition), [compatibilidade Ollama](https://docs.ollama.com/api/openai-compatibility).
