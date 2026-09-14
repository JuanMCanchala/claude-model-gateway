# Guarda la API key de Fireworks sin imprimirla y deja todo conectado:
#   - claude-mem: ~/.claude-mem*/.env como OPENROUTER_API_KEY + provider openrouter apuntando a Fireworks
#   - gateway: lee esa misma key en cada request para el subagente deepseek-coder (DeepSeek V4.1 Flash en Fireworks)
# Enter vacio = no tocar nada.

$ErrorActionPreference = 'Stop'
$FireworksBaseUrl = 'https://api.fireworks.ai/inference/v1'
$FireworksModel = 'accounts/fireworks/models/deepseek-v4p1-flash'
$MemTargets = @(
    @{ Dir = "$HOME\.claude-mem"; Port = 37777 },
    @{ Dir = "$HOME\.claude-mem-funnelchat"; Port = 37778 }
)
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Secret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Set-EnvFileValue([string]$File, [string]$Name, [string]$Value) {
    $lines = @()
    if (Test-Path $File) { $lines = @(Get-Content $File | Where-Object { $_ -notmatch "^\s*$Name\s*=" }) }
    $lines += "$Name=$Value"
    [IO.File]::WriteAllLines($File, [string[]]$lines, $Utf8NoBom)
}

function Set-JsonProps([string]$File, [hashtable]$Props) {
    $json = Get-Content $File -Raw | ConvertFrom-Json
    foreach ($k in $Props.Keys) { $json | Add-Member -NotePropertyName $k -NotePropertyValue $Props[$k] -Force }
    [IO.File]::WriteAllText($File, ($json | ConvertTo-Json -Depth 10), $Utf8NoBom)
}

$fireworks = Read-Secret 'Fireworks API key (Enter para omitir)'
if (-not $fireworks) { 'Sin cambios.'; return }

$headers = @{ Authorization = "Bearer $fireworks" }
$body = @{ model = $FireworksModel; max_tokens = 16; messages = @(@{ role = 'user'; content = 'Responde solo: ok' }) } | ConvertTo-Json -Depth 5
try {
    $r = Invoke-RestMethod -Method Post -Uri "$FireworksBaseUrl/chat/completions" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 60
    "Fireworks OK -> $($r.model)"
} catch {
    Write-Warning "Fireworks fallo ($($_.Exception.Message)). No cambio nada; revisa la key."
    return
}

foreach ($t in $MemTargets) {
    $settings = Join-Path $t.Dir 'settings.json'
    if (-not (Test-Path $settings)) { continue }
    Set-EnvFileValue (Join-Path $t.Dir '.env') 'OPENROUTER_API_KEY' $fireworks
    Set-JsonProps $settings @{
        CLAUDE_MEM_PROVIDER            = 'openrouter'
        CLAUDE_MEM_OPENROUTER_BASE_URL = $FireworksBaseUrl
        CLAUDE_MEM_OPENROUTER_MODEL    = $FireworksModel
        CLAUDE_MEM_OPENROUTER_API_KEY  = ''
    }
    # Reinicia el worker para que lea el provider nuevo (vuelve a levantarse con la siguiente sesion/hook).
    # Siempre con /T: matar solo el worker deja el arbol chroma vivo reteniendo el puerto (socket zombie).
    try {
        $h = Invoke-RestMethod "http://127.0.0.1:$($t.Port)/api/health" -TimeoutSec 3
        taskkill /PID $h.pid /T /F | Out-Null
        "claude-mem ($($t.Dir)) -> Fireworks; worker :$($t.Port) reiniciado"
    } catch { "claude-mem ($($t.Dir)) -> Fireworks; worker :$($t.Port) no estaba corriendo" }
}

# El gateway lee la key del .env en cada request: basta con comprobar el coder.
& "$PSScriptRoot\claude-gateway.ps1" start | Out-Null
$probe = @{ model = 'deepseek-v4p1-flash'; max_tokens = 64; messages = @(@{ role = 'user'; content = 'Responde solo: ok' }) } | ConvertTo-Json -Depth 5
try {
    $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4141/v1/messages' -ContentType 'application/json' -Body $probe -TimeoutSec 90
    "deepseek-coder via gateway OK -> $($r.model)"
} catch { Write-Warning "deepseek-coder via gateway fallo: $($_.Exception.Message)" }
'Listo.'
