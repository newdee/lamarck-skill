# Stop hook. If this session has pending skill-invocation records, block the stop
# once and hand the model a self-contained LIGHT evaluation protocol, so the full
# lamarck SKILL.md is NOT reloaded every turn. Escalation to the full protocol
# (and any skill edit) happens only when accumulated evidence crosses the gate,
# and edits always require explicit user confirmation.
# stop_hook_active guards against infinite block loops (one block per turn max).
# Must never fail the harness: all errors are swallowed, always exits 0.
$ErrorActionPreference = 'Stop'
try {
    $raw = [Console]::In.ReadToEnd()
    $data = $null
    if (-not [string]::IsNullOrWhiteSpace($raw)) { $data = $raw | ConvertFrom-Json }

    # Already continuing because of a stop hook: never block twice.
    if ($data -and $data.stop_hook_active) { exit 0 }

    $root = Split-Path -Parent $PSScriptRoot
    if (Test-Path (Join-Path $root 'off')) { exit 0 }

    # Trigger mode from config.json: every | manual | threshold (default threshold/5).
    # Missing or corrupt config falls back to the defaults, never crashes.
    $mode = 'threshold'; $threshold = 5
    $cfgPath = Join-Path $root 'config.json'
    if (Test-Path $cfgPath) {
        try {
            $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
            if ($cfg.mode -in @('every', 'manual', 'threshold')) { $mode = [string]$cfg.mode }
            $t = 0
            if ($cfg.threshold -and [int]::TryParse([string]$cfg.threshold, [ref]$t) -and $t -ge 1) { $threshold = $t }
        } catch { }
    }
    if ($mode -eq 'manual') { exit 0 }

    $pendingPath = Join-Path $root 'data\pending.jsonl'
    if (-not (Test-Path $pendingPath)) { exit 0 }

    $lines = @(Get-Content $pendingPath -ErrorAction Stop | Where-Object { $_.Trim() })
    if ($lines.Count -eq 0) { exit 0 }

    # Only this session's entries force an evaluation here; other sessions'
    # entries lack in-context evidence and are handled by manual /lamarck runs.
    # No session_id (anomalous input) -> cannot attribute entries, never block.
    $sid = if ($data) { [string]$data.session_id } else { '' }
    if (-not $sid) { exit 0 }
    $mine = @($lines | ForEach-Object {
        try { $_ | ConvertFrom-Json } catch { $null }
    } | Where-Object { $_ -and ($_.session -eq $sid) })
    $needed = if ($mode -eq 'every') { 1 } else { $threshold }
    if ($mine.Count -lt $needed) { exit 0 }

    $names = @($mine | ForEach-Object { $_.skill } | Select-Object -Unique)
    $reason = "lamarck LIGHT loop (trigger: mode=$mode, needed=$needed): $($mine.Count) skill invocation(s) from this session (session_id=$sid) await evaluation: [$($names -join ', ')]. " +
        "Do this now WITHOUT reloading SKILL.md. For each pending entry in $root\data\pending.jsonl belonging to this session, using only real in-context evidence (<=5 lines each): " +
        "judge trigger_fit (ok|false-positive|wrong-skill), gaps[] (things the skill's instructions lacked, each 'missing X, caused Y'), outcome (clean|corrected|failed; quote user corrections in note), friction (wasted steps, may be empty). " +
        "Append one JSON line per entry to $root\data\ledger.jsonl with fields {ts,session,skill,trigger_fit,gaps,outcome,friction,note}; if a reusable lesson emerged, append it to $root\data\learnings\<skill>.md; then remove this session's lines from data\pending.jsonl. " +
        "ESCALATE ONLY IF, after logging, some skill has >=2 independent invocations with same-type gaps in the ledger: then read $root\SKILL.md and run its optimization gate. " +
        "NEVER apply an edit to any skill without first asking the user (AskUserQuestion: apply / keep as suggestion / reject); in a non-interactive session, write the proposal to suggestions/<skill>.md instead of editing."
    # [ordered] keeps JSON key order deterministic (plain @{} hashtable ordering
    # varies between runs, breaking byte-identical reproducibility).
    [ordered]@{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress
} catch { }
exit 0
