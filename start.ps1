# LUMINA roda localmente com SQLite e nao exige os servicos Docker para iniciar.
if (-not (Test-Path .env)) {
	New-Item -ItemType File -Path .env | Out-Null
}

Write-Host 'Iniciando o gateway e o frontend em http://127.0.0.1:5173'
npm run dev