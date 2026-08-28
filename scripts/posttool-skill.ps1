# PostToolUse hook (matcher: Skill).
# Appends one pending-evaluation record per skill invocation to data/pending.jsonl.
# Must never fail or block the harness: all errors are swallowed, always exits 0.
$ErrorActionPreference = 'Stop'
try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
    $data = $raw | ConvertFrom-Json

    if ($data.tool_name -ne 'Skill') { exit 0 }
    $skill = [string]$data.tool_input.skill
    # Skip empty names and self-invocations (prevents evaluate-the-evaluator loops).
    if ([string]::IsNullOrWhiteSpace($skill) -or $skill -eq 'lamarck') { exit 0 }

    $root = Split-Path -Parent $PSScriptRoot
    # Kill switch: create a file named 'off' in the skill directory to disable.
    if (Test-Path (Join-Path $root 'off')) { exit 0 }

    $dataDir = Join-Path $root 'data'
    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }

    $skillArgs = [string]$data.tool_input.args
    if ($skillArgs.Length -gt 200) { $skillArgs = $skillArgs.Substring(0, 200) }

    $rec = [ordered]@{
        ts      = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        session = [string]$data.session_id
        skill   = $skill
        args    = $skillArgs
    } | ConvertTo-Json -Compress

    [System.IO.File]::AppendAllText(
        (Join-Path $dataDir 'pending.jsonl'),
        $rec + "`n",
        [System.Text.UTF8Encoding]::new($false))
} catch { }
exit 0
