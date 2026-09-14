# Guarda la API key de Fireworks sin imprimirla y deja el coder listo:
#   - variable de usuario FIREWORKS_API_KEY (la usa el gateway para /fireworks)
# claude-mem NO se toca: sigue con su provider de Claude.
# Enter vacio = no tocar nada.

$ErrorActionPreference = 'Stop'
$FireworksBaseUrl = 'https://api.fireworks.ai/inference/v1'
$CoderModel = 'deepseek-v4p1-flash'

function Read-Secret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$fireworks = Read-Secret 'Fireworks API key (Enter para omitir)'
if (-not $fireworks) { 'Sin cambios.'; return }

$headers = @{ Authorization = "Bearer $fireworks" }
$body = @{ model = "accounts/fireworks/models/$CoderModel"; max_tokens = 16; messages = @(@{ role = 'user'; content = 'Responde solo: ok' }) } | ConvertTo-Json -Depth 5
try {
    $r = Invoke-RestMethod -Method Post -Uri "$FireworksBaseUrl/chat/completions" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 60
    "Fireworks OK -> $($r.model)"
} catch {
    Write-Warning "Fireworks fallo ($($_.Exception.Message)). No cambio nada; revisa la key."
    return
}

[Environment]::SetEnvironmentVariable('FIREWORKS_API_KEY', $fireworks, 'User')
& "$PSScriptRoot\claude-gateway.ps1" restart

$probe = @{ model = $CoderModel; max_tokens = 64; messages = @(@{ role = 'user'; content = 'Responde solo: ok' }) } | ConvertTo-Json -Depth 5
try {
    $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4141/v1/messages' -ContentType 'application/json' -Body $probe -TimeoutSec 90
    "coder via gateway OK -> $($r.model)"
} catch { Write-Warning "coder via gateway fallo: $($_.Exception.Message)" }
'Listo.'
