# lamarck mechanism self-test. CI-able: exit 0 = all pass, exit 1 = failures.
# Runs the hook scripts in an isolated temp sandbox that mimics the real
# skills-directory layout; never touches the live data/ directory.
# Requires pwsh (PowerShell 7+) and git.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$pwsh = (Get-Command pwsh).Source

$script:passes = 0
$script:fails = [System.Collections.Generic.List[string]]::new()
function Check([string]$name, [bool]$cond) {
    if ($cond) { $script:passes++; Write-Host "PASS  $name" }
    else { $script:fails.Add($name); Write-Host "FAIL  $name" -ForegroundColor Red }
}

# --- sandbox: %TEMP%\<guid>\skills\lamarck mimics the real layout so the
# --- ver-stamp path resolution (sibling skill dirs) works.
$base = Join-Path ([System.IO.Path]::GetTempPath()) ("lamarck-selftest-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$sb = Join-Path $base 'skills\lamarck'
New-Item -ItemType Directory -Path (Join-Path $sb 'scripts') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $base 'skills\fakeskill') -Force | Out-Null
Set-Content (Join-Path $base 'skills\fakeskill\SKILL.md') "fake skill body" -Encoding utf8NoBOM
Copy-Item (Join-Path $repo 'scripts\posttool-skill.ps1') (Join-Path $sb 'scripts\')
Copy-Item (Join-Path $repo 'scripts\stop-evaluate.ps1') (Join-Path $sb 'scripts\')
Set-Content (Join-Path $sb 'config.json') '{"mode":"threshold","threshold":5}' -Encoding utf8NoBOM

$post = Join-Path $sb 'scripts\posttool-skill.ps1'
$stop = Join-Path $sb 'scripts\stop-evaluate.ps1'
$pending = Join-Path $sb 'data\pending.jsonl'
$cfg = Join-Path $sb 'config.json'
function PostCall([string]$json) { $json | & $pwsh -NoProfile -File $post | Out-Null; return $LASTEXITCODE }
function StopCall([string]$json) { return (($json | & $pwsh -NoProfile -File $stop) -join "`n") }
function PendingCount { if (Test-Path $pending) { return @(Get-Content $pending | Where-Object { $_ }).Count } else { return 0 } }
function LastRec { return ((Get-Content $pending | Where-Object { $_ } | Select-Object -Last 1) | ConvertFrom-Json) }

try {
    # ---------- posttool ----------
    $rc = PostCall '{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"fakeskill","args":"hello"}}'
    Check 'post: valid call logged, exit 0' (($rc -eq 0) -and (PendingCount) -eq 1)
    $rec = LastRec
    Check 'post: fields ts/session/skill/args/ver present' (($rec.session -eq 's1') -and ($rec.skill -eq 'fakeskill') -and ($rec.args -eq 'hello') -and ($null -ne $rec.ver))
    Check 'post: ver is 8-hex for resolvable skill' ($rec.ver -cmatch '^[0-9a-f]{8}$')
    PostCall '{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"fakeskill","args":"again"}}' | Out-Null
    Check 'post: ver deterministic across calls' ((LastRec).ver -eq $rec.ver)
    PostCall '{"session_id":"s1","tool_name":"Bash","tool_input":{"command":"ls"}}' | Out-Null
    Check 'post: non-Skill tool ignored' ((PendingCount) -eq 2)
    PostCall '{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"lamarck","args":""}}' | Out-Null
    Check 'post: self-invocation excluded' ((PendingCount) -eq 2)
    $rc = PostCall 'not json {{'
    Check 'post: malformed stdin exit 0, no append' (($rc -eq 0) -and (PendingCount) -eq 2)
    $rc = PostCall ''
    Check 'post: empty stdin exit 0, no append' (($rc -eq 0) -and (PendingCount) -eq 2)
    $big = 'A' * 500
    PostCall ('{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"bigargs","args":"' + $big + '"}}') | Out-Null
    Check 'post: args truncated to 200' ((LastRec).args.Length -eq 200)
    Check 'post: ver empty for unresolvable skill' ((LastRec).ver -eq '')
    PostCall '{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"plug:in","args":""}}' | Out-Null
    Check 'post: ver empty for plugin-style name' ((LastRec).ver -eq '')
    PostCall '{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"uni","args":"把这篇做成网页文章"}}' | Out-Null
    Check 'post: unicode args roundtrip' ((LastRec).args -eq '把这篇做成网页文章')
    $bytes = [System.IO.File]::ReadAllBytes($pending)
    Check 'post: pending.jsonl UTF-8 without BOM' (-not ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB))
    New-Item -ItemType File -Path (Join-Path $sb 'off') -Force | Out-Null
    PostCall '{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"nolog","args":""}}' | Out-Null
    Check 'post: off switch disables logging' (-not ((Get-Content $pending -Raw) -match 'nolog'))
    [System.IO.File]::Delete((Join-Path $sb 'off'))

    # ---------- stop: threshold mode ----------
    Set-Content $pending '' -Encoding utf8NoBOM
    1..4 | ForEach-Object { PostCall ('{"session_id":"s2","tool_name":"Skill","tool_input":{"skill":"sk' + $_ + '","args":""}}') | Out-Null }
    $o = StopCall '{"session_id":"s2","stop_hook_active":false}'
    Check 'stop: below threshold silent (4/5)' ([string]::IsNullOrEmpty($o))
    PostCall '{"session_id":"s2","tool_name":"Skill","tool_input":{"skill":"sk5","args":""}}' | Out-Null
    $o = StopCall '{"session_id":"s2","stop_hook_active":false}'
    Check 'stop: at threshold blocks (5/5)' ($o -match '"decision":"block"')
    Check 'stop: reason states mode and needed' ($o -match 'mode=threshold, needed=5')
    Check 'stop: reason lists session and skills' (($o -match 'session_id=s2') -and ($o -match 'sk1'))
    Check 'stop: reason embeds protocol (4 dims, escalate, user gate, replay, ver)' (($o -match 'trigger_fit') -and ($o -match 'ESCALATE ONLY IF') -and ($o -match 'AskUserQuestion') -and ($o -match 'replays') -and ($o -match 'carry ver over'))
    $o2 = StopCall '{"session_id":"s2","stop_hook_active":false}'
    Check 'stop: output byte-identical across runs' ($o -eq $o2)
    Check 'stop: other session silent' ([string]::IsNullOrEmpty((StopCall '{"session_id":"other","stop_hook_active":false}')))
    Check 'stop: missing session_id silent' ([string]::IsNullOrEmpty((StopCall '{"stop_hook_active":false}')))
    Check 'stop: stop_hook_active silent (loop guard)' ([string]::IsNullOrEmpty((StopCall '{"session_id":"s2","stop_hook_active":true}')))
    Check 'stop: malformed stdin silent' ([string]::IsNullOrEmpty((StopCall 'garbage{{')))
    New-Item -ItemType File -Path (Join-Path $sb 'off') -Force | Out-Null
    Check 'stop: off switch silent' ([string]::IsNullOrEmpty((StopCall '{"session_id":"s2","stop_hook_active":false}')))
    [System.IO.File]::Delete((Join-Path $sb 'off'))
    Add-Content $pending 'CORRUPT-NOT-JSON'
    $o = StopCall '{"session_id":"s2","stop_hook_active":false}'
    Check 'stop: corrupt pending line tolerated' ($o -match '"decision":"block"')

    # ---------- stop: mode variants & config fallbacks ----------
    Set-Content $cfg '{"mode":"every"}' -Encoding utf8NoBOM
    Set-Content $pending '' -Encoding utf8NoBOM
    PostCall '{"session_id":"s3","tool_name":"Skill","tool_input":{"skill":"one","args":""}}' | Out-Null
    Check 'stop: every mode blocks at 1' ((StopCall '{"session_id":"s3","stop_hook_active":false}') -match 'mode=every, needed=1')
    Set-Content $cfg '{"mode":"manual"}' -Encoding utf8NoBOM
    Check 'stop: manual mode never blocks' ([string]::IsNullOrEmpty((StopCall '{"session_id":"s3","stop_hook_active":false}')))
    Set-Content $cfg '{"mode":"threshold","threshold":1}' -Encoding utf8NoBOM
    Check 'stop: custom threshold honored' ((StopCall '{"session_id":"s3","stop_hook_active":false}') -match 'needed=1')
    Set-Content $cfg 'broken{{' -Encoding utf8NoBOM
    Check 'stop: corrupt config falls back threshold/5' ([string]::IsNullOrEmpty((StopCall '{"session_id":"s3","stop_hook_active":false}')))
    Set-Content $cfg '{"mode":"chaos","threshold":-3}' -Encoding utf8NoBOM
    Check 'stop: illegal config values fall back threshold/5' ([string]::IsNullOrEmpty((StopCall '{"session_id":"s3","stop_hook_active":false}')))
    [System.IO.File]::Delete($cfg)
    Check 'stop: missing config falls back threshold/5' ([string]::IsNullOrEmpty((StopCall '{"session_id":"s3","stop_hook_active":false}')))

    # ---------- static checks against the real repo ----------
    $md = Get-Content (Join-Path $repo 'SKILL.md') -Raw
    $fm = ($md -split '---')[1]
    $name = ($fm | Select-String 'name: (\S+)').Matches[0].Groups[1].Value
    $desc = ($fm | Select-String 'description: (.+)').Matches[0].Groups[1].Value
    Check 'static: frontmatter name matches directory' ($name -eq (Split-Path -Leaf $repo))
    Check 'static: description within 1024 chars' ($desc.Length -le 1024)
    Check 'static: SKILL.md under 500 lines' (@(Get-Content (Join-Path $repo 'SKILL.md')).Count -lt 500)
    git -C $repo check-ignore -q data/ledger.jsonl; $i1 = $LASTEXITCODE -eq 0
    git -C $repo check-ignore -q data/pending.jsonl; $i2 = $LASTEXITCODE -eq 0
    git -C $repo check-ignore -q data/replays/x.jsonl; $i3 = $LASTEXITCODE -eq 0
    git -C $repo check-ignore -q data/rubrics/x.md; $i4 = $LASTEXITCODE -ne 0
    git -C $repo check-ignore -q README.md; $i5 = $LASTEXITCODE -ne 0
    Check 'static: telemetry ignored, rubrics+README tracked' ($i1 -and $i2 -and $i3 -and $i4 -and $i5)
    $cj = Get-Content (Join-Path $repo 'config.example.json') -Raw | ConvertFrom-Json
    Check 'static: config.example.json valid, mode legal, evolution block sane' (($cj.mode -in @('every', 'manual', 'threshold')) -and ($cj.evolution.default -in @('observe', 'suggest', 'evolve')))
    git -C $repo check-ignore -q config.json; $lc = $LASTEXITCODE -eq 0
    Check 'static: local config.json untracked (personal state)' $lc
    $localOk = $true
    if (Test-Path (Join-Path $repo 'config.json')) {
        try { $localOk = ((Get-Content (Join-Path $repo 'config.json') -Raw | ConvertFrom-Json).mode -in @('every', 'manual', 'threshold')) } catch { $localOk = $false }
    }
    Check 'static: local config.json absent or legal' $localOk
} finally {
    Remove-Item -Recurse -Force $base -ErrorAction SilentlyContinue
}

Write-Host ''
$total = $script:passes + $script:fails.Count
Write-Host "lamarck selftest: $script:passes/$total passed"
if ($script:fails.Count) { $script:fails | ForEach-Object { Write-Host "  FAILED: $_" -ForegroundColor Red }; exit 1 }
exit 0
