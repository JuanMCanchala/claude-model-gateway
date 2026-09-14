param(
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs', 'usage')]
    [string]$Action = 'status',
    [int]$Days = 30
)

# Gestiona el gateway local (Claude -> Anthropic, deepseek-* -> Fireworks).
#   usage [-Days N]  resumen del gasto en Fireworks (coder + claude-mem)
$Port = 4141
$Script = Join-Path $PSScriptRoot 'gateway.mjs'
$LogFile = Join-Path $HOME '.claude-gateway\gateway.log'
$HealthUrl = "http://127.0.0.1:$Port/health"

function Get-GatewayHealth {
    try { return Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2 } catch { return $null }
}

function Start-Gateway {
    $health = Get-GatewayHealth
    if ($health) { return $health }
    # La key de Fireworks la lee el gateway de ~/.claude-mem/.env; FIREWORKS_API_KEY de usuario tiene prioridad si existe.
    $key = [Environment]::GetEnvironmentVariable('FIREWORKS_API_KEY', 'User')
    if ($key) { $env:FIREWORKS_API_KEY = $key }
    Start-Process -FilePath node -ArgumentList "`"$Script`"" -WindowStyle Hidden
    foreach ($i in 1..20) {
        Start-Sleep -Milliseconds 250
        $health = Get-GatewayHealth
        if ($health) { return $health }
    }
    return $null
}

function Stop-Gateway {
    $health = Get-GatewayHealth
    if ($health) { Stop-Process -Id $health.pid -Force -ErrorAction SilentlyContinue }
}

function Format-Health($h) { "gateway OK  http://127.0.0.1:$Port  pid=$($h.pid)  coder=$($h.coder)  fireworksKey=$($h.fireworksKey)" }

switch ($Action) {
    'start' {
        $h = Start-Gateway
        if ($h) { Format-Health $h } else { Write-Error "no arranco; revisa $LogFile"; exit 1 }
    }
    'stop' { Stop-Gateway; 'gateway detenido' }
    'restart' {
        Stop-Gateway
        Start-Sleep -Milliseconds 500
        $h = Start-Gateway
        if ($h) { Format-Health $h } else { Write-Error "no arranco; revisa $LogFile"; exit 1 }
    }
    'status' {
        $h = Get-GatewayHealth
        if ($h) { Format-Health $h } else { 'gateway apagado' }
    }
    'logs' { Get-Content $LogFile -Tail 30 }
    'usage' { & (Join-Path $PSScriptRoot 'usage.ps1') -Days $Days }
}
