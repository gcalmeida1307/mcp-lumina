$ErrorActionPreference = "Stop"

$graph = "core/orchestrator/graph.ts"
$models = "core/llmops/models.ts"
$app = "gateway/app.ts"

Copy-Item $graph "$graph.bak-stage2" -Force
Copy-Item $models "$models.bak-stage2" -Force
Copy-Item $app "$app.bak-stage2" -Force

# ============================================================
# 1. GRAPH
# Interpreter deixa de ser ponto único de falha.
# ============================================================

$content = Get-Content $graph -Raw

$old = @'
  const interpreted = config.COGNITIVE_INTERPRETER && llm
    ? await interpret(models, { message: normalizedQuestion, history, domain, resources: investigation.resources }, signal)
    : undefined;
'@

$new = @'
  let interpreted: Awaited<ReturnType<typeof interpret>> | undefined;

  if (config.COGNITIVE_INTERPRETER && llm) {
    try {
      interpreted = await interpret(
        models,
        {
          message: normalizedQuestion,
          history,
          domain,
          resources: investigation.resources
        },
        signal
      );
    } catch (error) {
      step(
        'Entender',
        'Interpreter indisponível; usando roteamento compatível. ' +
        (error instanceof Error ? error.message : 'Falha de interpretação.')
      );
    }
  }
'@

if (-not $content.Contains($old)) {
    throw "Bloco do Interpreter não encontrado em $graph"
}

$content = $content.Replace($old, $new)
Set-Content $graph $content -Encoding UTF8


# ============================================================
# 2. MODEL REGISTRY
# JSON estruturado robusto contra markdown / thinking wrappers.
# ============================================================

$content = Get-Content $models -Raw

$marker = @'
export class ModelRegistry {
'@

$helper = @'
function parseStructuredOutput(text: string): unknown {
  const raw = text.trim();

  try {
    return JSON.parse(raw);
  } catch {
    // Alguns modelos locais envolvem JSON em markdown.
  }

  const fenced =
    raw.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Continua para extração balanceada.
    }
  }

  const start = raw.indexOf('{');

  if (start >= 0) {
    let depth = 0;
    let quoted = false;
    let escaped = false;

    for (let i = start; i < raw.length; i++) {
      const char = raw[i];

      if (quoted) {
        if (escaped) {
          escaped = false;
        } else if (char === '\') {
          escaped = true;
        } else if (char === '"') {
          quoted = false;
        }

        continue;
      }

      if (char === '"') {
        quoted = true;
        continue;
      }

      if (char === '{') depth++;

      if (char === '}') {
        depth--;

        if (depth === 0) {
          const candidate = raw.slice(start, i + 1);

          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new SyntaxError(
    'O modelo não retornou uma resposta estruturada válida.'
  );
}

export class ModelRegistry {
'@

if (-not $content.Contains($marker)) {
    throw "ModelRegistry não encontrado em $models"
}

$content = $content.Replace($marker, $helper)

$oldParse = @'
        if (format === 'json') result.data = JSON.parse(result.text);
'@

$newParse = @'
        if (format === 'json') result.data = parseStructuredOutput(result.text);
'@

if (-not $content.Contains($oldParse)) {
    throw "JSON.parse esperado não encontrado em $models"
}

$content = $content.Replace($oldParse, $newParse)
Set-Content $models $content -Encoding UTF8


# ============================================================
# 3. LOG DO BACKEND
# Mantém erro seguro para usuário, mas registra causa real.
# ============================================================

$content = Get-Content $app -Raw

$oldLog = @'
      console.error(JSON.stringify({ event: 'query.failed', requestId: req.requestId, type: error instanceof Error ? error.name : 'Error', code: error instanceof ModelConfigurationError ? error.code : undefined, providerStatus: error instanceof ProviderHttpError ? error.status : undefined }));
'@

$newLog = @'
      console.error(JSON.stringify({
        event: 'query.failed',
        requestId: req.requestId,
        type: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        cause: error instanceof Error && 'cause' in error
          ? String(error.cause)
          : undefined,
        code: error instanceof ModelConfigurationError
          ? error.code
          : undefined,
        providerStatus: error instanceof ProviderHttpError
          ? error.status
          : undefined
      }));
'@

if (-not $content.Contains($oldLog)) {
    throw "Logger esperado não encontrado em $app"
}

$content = $content.Replace($oldLog, $newLog)
Set-Content $app $content -Encoding UTF8

Write-Host ""
Write-Host "Stage 2 runtime patch aplicado."
Write-Host "Backups:"
Write-Host "  $graph.bak-stage2"
Write-Host "  $models.bak-stage2"
Write-Host "  $app.bak-stage2"
Write-Host ""
Write-Host "Execute agora:"
Write-Host "  npm run check"
Write-Host "  npm test"