# Execute sempre na pasta do projeto, mesmo quando chamado por caminho absoluto.

$ErrorActionPreference = 'Stop'



# Define a codifica��o do terminal para UTF-8 via CHCP

chcp 65001 | Out-Null

$utf8 = [System.Text.Encoding]::GetEncoding(65001)

[Console]::OutputEncoding = $utf8

$OutputEncoding = $utf8



Push-Location $PSScriptRoot

try {

    if (-not (Test-Path -LiteralPath '.env')) {

        throw 'Arquivo .env ausente. Configure o ambiente usando .env.example antes de iniciar.'

    }

    Write-Host 'Iniciando o LUMINA em http://127.0.0.1:5174'

    Write-Host 'A preparacao do banco pode levar alguns minutos. A pagina aguardara a API automaticamente.'

    $env:NODE_USE_SYSTEM_CA = '1'

    npm run dev

} finally {

    Pop-Location

} 

