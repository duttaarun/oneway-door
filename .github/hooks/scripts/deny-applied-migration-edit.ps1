# one-way-door preToolUse hook (PowerShell twin of deny-applied-migration-edit.sh).
# Blocks agent edits to database migrations that already exist on the default branch.
# Accepts the Copilot (toolName/toolArgs) and VS Code (tool_name/tool_input) payload shapes.
# Prints {} to allow, or a deny decision in both shapes. Always exits 0: when in doubt, it allows.

function Allow { Write-Output '{}'; exit 0 }

function Get-Strings($node, $key, $acc) {
    if ($null -eq $node) { return }
    if ($node -is [string]) { $acc.Add([pscustomobject]@{ Key = $key; Value = $node }) | Out-Null; return }
    if ($node -is [System.Collections.IEnumerable] -and -not ($node -is [System.Collections.IDictionary])) {
        foreach ($item in $node) { Get-Strings $item $key $acc }
        return
    }
    if ($node -is [pscustomobject]) {
        foreach ($prop in $node.PSObject.Properties) { Get-Strings $prop.Value $prop.Name $acc }
    }
}

function Test-ImmutableMigration([string]$path) {
    $p = $path -replace '\\', '/'
    $name = ($p -split '/')[-1]
    if ($name -match '\.Designer\.cs$' -or $name -match 'ModelSnapshot\.cs$') { return $false }
    if ($p -match '(^|/)Migrations/[^/]+\.cs$') { return $true }
    if ($name -match '^[RrUu]\d*__.*\.sql$') { return $false }
    if ($name -match '^[Vv]\d.*__.*\.sql$') { return $true }
    return ($p -match '(^|/)(db/migration|migrations)/.*\.sql$')
}

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { Allow }
    $payload = $raw | ConvertFrom-Json

    $tool = if ($payload.toolName) { [string]$payload.toolName } elseif ($payload.tool_name) { [string]$payload.tool_name } else { '' }
    $toolArgs = if ($null -ne $payload.toolArgs) { $payload.toolArgs } else { $payload.tool_input }
    if ($toolArgs -is [string]) { try { $toolArgs = $toolArgs | ConvertFrom-Json } catch { } }

    $t = $tool.ToLowerInvariant()
    if ($t -match 'bash|shell|powershell|terminal|run_in|exec') { $kind = 'shell' }
    elseif ($t -match 'edit|write|create|replace|patch|insert|delete|remove|rename|move|multi') { $kind = 'edit' }
    else { Allow }
    if ($kind -eq 'edit' -and $toolArgs.command -eq 'view') { Allow }

    if ($payload.cwd -and (Test-Path -LiteralPath $payload.cwd)) { Set-Location -LiteralPath $payload.cwd }
    $root = (& git rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $root) { Allow }
    Set-Location -LiteralPath $root

    $base = $env:ONE_WAY_DOOR_BASE
    if (-not $base) {
        $base = (& git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null)
        if ($LASTEXITCODE -ne 0) { $base = $null }
        foreach ($b in 'origin/main', 'main', 'origin/master', 'master') {
            if ($base) { break }
            & git rev-parse --verify --quiet "$b^{commit}" *> $null
            if ($LASTEXITCODE -eq 0) { $base = $b }
        }
    }
    if (-not $base) { Allow }
    & git rev-parse --verify --quiet "$base^{commit}" *> $null
    if ($LASTEXITCODE -ne 0) { Allow }

    function Deny([string]$path) {
        $dir = Split-Path -Parent $path
        $advice = 'Add a new migration instead.'
        if ((Split-Path -Leaf $path) -match '^[Vv]\d') {
            $versions = & git ls-tree --name-only $base "$dir/" 2>$null |
                ForEach-Object { if ($_ -match '/[Vv](\d+)__') { [int]$Matches[1] } }
            $next = (($versions | Measure-Object -Maximum).Maximum) + 1
            $advice = "Add a new migration instead, e.g. $($dir -replace '\\', '/')/V${next}__<what_changes>.sql."
        } elseif ($path -match '\.cs$') {
            $advice = 'Add a new migration instead (dotnet ef migrations add <Name>); EF Core never re-runs an applied one.'
        }
        $reason = "one-way-door: $path is already on $base, so it has probably run somewhere. Editing an applied migration is a one-way door: environments that ran it never see the edit, and Flyway refuses to start on the checksum mismatch. $advice"
        $out = [ordered]@{
            permissionDecision       = 'deny'
            permissionDecisionReason = $reason
            hookSpecificOutput       = [ordered]@{
                hookEventName            = 'PreToolUse'
                permissionDecision       = 'deny'
                permissionDecisionReason = $reason
            }
        }
        Write-Output ($out | ConvertTo-Json -Compress -Depth 4)
        exit 0
    }

    function Get-Relative([string]$p) {
        $p = $p -replace '^file://', ''
        $r = $root -replace '\\', '/'
        $q = $p -replace '\\', '/'
        foreach ($prefix in @("$r/", "/private$r/", (($r -replace '^/private', '') + '/'))) {
            if ($q.StartsWith($prefix)) { return $q.Substring($prefix.Length) }
        }
        return ($q -replace '^\./', '')
    }

    $strings = [System.Collections.ArrayList]::new()
    Get-Strings $toolArgs '' $strings

    if ($kind -eq 'edit') {
        $pathKeys = 'path', 'file_path', 'filePath', 'filepath', 'file', 'filename', 'fileName', 'target_file', 'targetFile',
                    'uri', 'old_path', 'new_path', 'oldPath', 'newPath', 'source', 'destination', 'files', 'paths', 'filePaths', 'file_paths'
        $candidates = @()
        foreach ($s in $strings) {
            if ($pathKeys -contains $s.Key) { $candidates += $s.Value }
            foreach ($m in [regex]::Matches($s.Value, '\*\*\* (?:Update|Delete|Move) File: ([^\r\n]+)')) { $candidates += $m.Groups[1].Value.Trim() }
            foreach ($m in [regex]::Matches($s.Value, '(?m)^(?:\+\+\+|---) a/(\S+)')) { $candidates += $m.Groups[1].Value }
        }
        foreach ($c in $candidates) {
            $rel = Get-Relative $c
            if (Test-ImmutableMigration $rel) {
                & git cat-file -e "${base}:$rel" *> $null
                if ($LASTEXITCODE -eq 0) { Deny $rel }
            }
        }
        Allow
    }

    $command = ($strings | Where-Object { $_.Key -in 'command', 'cmd', 'script', 'commandLine' } | Select-Object -First 1).Value
    if (-not $command) { Allow }
    $writes = '(sed\s+(-[a-zA-Z]*i|--in-place)|perl\s+-[a-zA-Z]*i|[^0-9&]>>?\s*[^&\s]|(^|[;&|\s])(tee|rm|mv|cp|truncate|unlink|Remove-Item|Set-Content|Add-Content|Out-File|Move-Item|Copy-Item)\s|git\s+(mv|rm|checkout)\s)'
    if ($command -notmatch $writes) { Allow }
    foreach ($file in (& git ls-tree -r --name-only $base 2>$null)) {
        if ((Test-ImmutableMigration $file) -and $command.Contains((Split-Path -Leaf $file))) { Deny $file }
    }
    Allow
}
catch {
    Allow
}
