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

    # Genome version stamp: content hash of the target skill's SKILL.md at
    # invocation time. Enables per-version performance windows (regression
    # detection after edits). Plugin skills (name contains ':') have no
    # resolvable path here -> empty stamp.
    $ver = ''
    try {
        if ($skill -notmatch ':') {
            $sf = Join-Path (Split-Path -Parent $root) "$skill\SKILL.md"
            if (Test-Path $sf) {
                $md5 = [System.Security.Cryptography.MD5]::Create()
                $ver = [System.BitConverter]::ToString($md5.ComputeHash([System.IO.File]::ReadAllBytes($sf))).Replace('-', '').Substring(0, 8).ToLower()
            }
        }
    } catch { }

    $rec = [ordered]@{
        ts      = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        session = [string]$data.session_id
        skill   = $skill
        args    = $skillArgs
        ver     = $ver
        # Pointer to Claude Code's own session transcript - the full execution
        # log already exists there; we store the pointer, never a copy.
        # Decays with the transcript cleanup period; consumers must fall back.
        transcript = [string]$data.transcript_path
    } | ConvertTo-Json -Compress

    [System.IO.File]::AppendAllText(
        (Join-Path $dataDir 'pending.jsonl'),
        $rec + "`n",
        [System.Text.UTF8Encoding]::new($false))
} catch { }
exit 0
