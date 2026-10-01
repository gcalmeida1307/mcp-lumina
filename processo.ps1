# Descobrir quem está usando a porta 5173
Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, State, OwningProcess




Get-Process -Id   20244

Stop-Process -Id  13564 -Force

cls

Get-Process node -ErrorAction SilentlyContinue

cls
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

cls
Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue

cd C:\Users\glauco.almeida\Documents\LUMINA
.\start.ps1