param(
    [switch]$Sync,
    [int]$Days = 30
)

# Rastro de gasto en Fireworks. Ledger: ~/.claude-gateway/usage.jsonl (una linea por llamada).
#   source=coder                -> lo escribe gateway.mjs (delegaciones /fireworks)
#   source=claude-mem:<perfil>  -> se importa aqui desde los logs del worker de claude-mem
# -Sync solo importa; sin -Sync importa y muestra el resumen de los ultimos -Days dias.

$ErrorActionPreference = 'Stop'
$StateDir = Join-Path $HOME '.claude-gateway'
$Ledger = Join-Path $StateDir 'usage.jsonl'
$SyncState = Join-Path $StateDir 'usage-sync.json'
$Prices = Get-Content (Join-Path $PSScriptRoot 'prices.json') -Raw | ConvertFrom-Json
$MemSources = @(
    @{ Name = 'claude-mem:flash'; Logs = (Join-Path $HOME '.claude-mem\logs') },
    @{ Name = 'claude-mem:funnelchat'; Logs = (Join-Path $HOME '.claude-mem-funnelchat\logs') }
)
$LinePattern = '^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\].*OpenRouter API usage \{model=(accounts/fireworks/[^,]+), inputTokens=(\d+), outputTokens=(\d+)'
$TsFormat = 'yyyy-MM-dd HH:mm:ss.fff'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Sync-ClaudeMemUsage {
    New-Item -ItemType Directory -Force $StateDir | Out-Null
    $state = @{}
    if (Test-Path $SyncState) {
        (Get-Content $SyncState -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = $_.Value }
    }
    $new = New-Object System.Collections.Generic.List[string]
    foreach ($src in $MemSources) {
        if (-not (Test-Path $src.Logs)) { continue }
        $last = [datetime]::MinValue
        if ($state.ContainsKey($src.Name)) { $last = [datetime]::ParseExact($state[$src.Name], $TsFormat, $null) }
        $maxTs = $last
        $files = Get-ChildItem $src.Logs -Filter 'claude-mem-*.log' | Where-Object { $_.LastWriteTime -ge $last.Date }
        foreach ($file in $files) {
            foreach ($m in (Select-String -Path $file.FullName -Pattern $LinePattern)) {
                $g = $m.Matches[0].Groups
                $ts = [datetime]::ParseExact($g[1].Value, $TsFormat, $null)
                if ($ts -le $last) { continue }
                $entry = [ordered]@{
                    ts                  = ([DateTimeOffset]$ts).ToString('o')
                    source              = $src.Name
                    model               = $g[2].Value
                    input_tokens        = [int]$g[3].Value
                    cached_input_tokens = 0
                    output_tokens       = [int]$g[4].Value
                }
                $new.Add(($entry | ConvertTo-Json -Compress))
                if ($ts -gt $maxTs) { $maxTs = $ts }
            }
        }
        if ($maxTs -gt $last) { $state[$src.Name] = $maxTs.ToString($TsFormat) }
    }
    if ($new.Count -gt 0) { [IO.File]::AppendAllLines($Ledger, [string[]]$new, $Utf8NoBom) }
    [IO.File]::WriteAllText($SyncState, ($state | ConvertTo-Json), $Utf8NoBom)
    return $new.Count
}

function Show-Usage {
    if (-not (Test-Path $Ledger)) { 'Sin consumo registrado todavia.'; return }
    $since = (Get-Date).Date.AddDays(1 - $Days)
    $unpriced = @{}
    $rows = foreach ($line in [IO.File]::ReadLines($Ledger)) {
        if (-not $line.Trim()) { continue }
        $r = $line | ConvertFrom-Json
        $when = [datetime]$r.ts
        if ($when -lt $since) { continue }
        $price = $Prices.PSObject.Properties[$r.model]
        $usd = 0
        if ($price) {
            $usd = ($r.input_tokens * $price.Value.input + $r.cached_input_tokens * $price.Value.cached_input + $r.output_tokens * $price.Value.output) / 1e6
        } elseif ($r.source -notin 'codex', 'gemini') { $unpriced[$r.model] = $true }  # codex/gemini van contra el plan de la cuenta: USD 0
        [pscustomobject]@{
            Dia = $when.ToString('yyyy-MM-dd'); Fuente = $r.source; Modelo = ($r.model -replace '^accounts/fireworks/models/', '')
            In = $r.input_tokens; Cache = $r.cached_input_tokens; Out = $r.output_tokens; USD = $usd
        }
    }
    if (-not $rows) { "Sin consumo en los ultimos $Days dias."; return }

    $rows | Group-Object Dia, Fuente, Modelo | ForEach-Object {
        $first = $_.Group[0]
        [pscustomobject]@{
            Dia      = $first.Dia
            Fuente   = $first.Fuente
            Modelo   = $first.Modelo
            Llamadas = $_.Count
            TokIn    = ($_.Group | Measure-Object In -Sum).Sum
            TokCache = ($_.Group | Measure-Object Cache -Sum).Sum
            TokOut   = ($_.Group | Measure-Object Out -Sum).Sum
            USD      = [math]::Round(($_.Group | Measure-Object USD -Sum).Sum, 4)
        }
    } | Sort-Object Dia, Fuente, Modelo | Format-Table -AutoSize | Out-String

    $total = ($rows | Measure-Object USD -Sum).Sum
    'Total ultimos {0} dias: USD {1:N4} en {2} llamadas (precios de prices.json)' -f $Days, $total, @($rows).Count
    if ($unpriced.Count) { "Modelos sin precio en prices.json (contados a 0): $($unpriced.Keys -join ', ')" }
}

$added = Sync-ClaudeMemUsage
if ($Sync) { return }
"Importadas $added llamadas nuevas de claude-mem."
Show-Usage
