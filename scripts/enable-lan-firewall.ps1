$ErrorActionPreference = 'Stop'
$ruleName = 'LUMINA-LAN-8080'
$nodePath = (Get-Command node.exe).Source
if (-not (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $ruleName -DisplayName 'LUMINA - rede local TCP 8080' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080 -RemoteAddress LocalSubnet -Profile Domain,Private -Program $nodePath -ErrorAction Stop | Out-Null
}
if (-not (Get-NetFirewallRule -Name $ruleName -ErrorAction Stop)) { throw 'Não foi possível confirmar a regra de firewall.' }
Write-Host 'Regra LUMINA configurada: TCP 8080, somente sub-rede local, perfis Dominio/Privado.'
