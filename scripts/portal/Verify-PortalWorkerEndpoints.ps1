<#
.SYNOPSIS
    Live-tenant verification harness for portal feature workers (T-0814/T-0847/T-0848, EPIC-019/020).
.DESCRIPTION
    Drives the real worker entrypoints under portal/workers against a live tenant,
    exactly as the BFF does: it writes a job envelope (tenantId plus the reference-only
    credential block), runs the entrypoint with -JobFile, and records the JSON it prints
    or the error it throws. Dependent cases (a policy detail, a device detail, a
    BitLocker key) pull their id from an earlier case's result and are skipped when the
    tenant has no such object. A read-only Graph probe records which API version each
    assumed resource actually lives in. No secret material is read, printed, or stored.
.PARAMETER TenantId
    Tenant GUID to verify against.
.PARAMETER CredentialRef
    Full credential reference (the row secretRef).
.PARAMETER ClientId
    App registration (client) id.
.PARAMETER Thumbprint
    Certificate thumbprint (recorded only).
.PARAMETER Environment
    Cloud environment: commercial, gcchigh, dod, or germany.
.PARAMETER OutDirectory
    Where job files, raw output, and the report are written. Defaults to
    portal/.dev-data/live-verify (already gitignored).
.PARAMETER Case
    Optional case-name filter; only the named cases run.
.PARAMETER SkipProbes
    Skip the raw Graph endpoint probes.
.PARAMETER TimeoutSeconds
    Per-entrypoint timeout. Default 300.
.EXAMPLE
    PS> ./Verify-PortalWorkerEndpoints.ps1 -TenantId $t -CredentialRef $r -ClientId $c
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredentialRef',
    Justification = 'CredentialRef is a storage reference (ref://...), never secret material.')]
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$CredentialRef,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ClientId,

    [Parameter()]
    [string]$Thumbprint = '',

    [Parameter()]
    [string]$Environment = 'commercial',

    [Parameter()]
    [string]$RepoRoot = '',

    [Parameter()]
    [string]$OutDirectory = '',

    [Parameter()]
    [string[]]$Case = @(),

    [Parameter()]
    [switch]$SkipProbes,

    [Parameter()]
    [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
    $RepoRoot = (Split-Path -Path (Split-Path -Path $PSScriptRoot -Parent) -Parent)
}
$workersDir = Join-Path -Path $RepoRoot -ChildPath 'portal/workers'
if (-not $OutDirectory) {
    $OutDirectory = Join-Path -Path $RepoRoot -ChildPath 'portal/.dev-data/live-verify'
}
$jobDir = Join-Path -Path $OutDirectory -ChildPath 'jobs'
$rawDir = Join-Path -Path $OutDirectory -ChildPath 'raw'
New-Item -ItemType Directory -Path $jobDir, $rawDir -Force | Out-Null

$credentialRecord = [ordered]@{
    tenantId    = $TenantId
    secretRef   = $CredentialRef
    authMethod  = 'certificate-pfx'
    clientId    = $ClientId
    thumbprint  = $Thumbprint
    environment = $Environment
}

# Read-only endpoint assumptions to confirm against the live tenant.
$probeUris = @(
    'v1.0/deviceManagement/configurationPolicies'
    'beta/deviceManagement/configurationPolicies'
    'v1.0/deviceManagement/deviceCompliancePolicies'
    'beta/deviceManagement/deviceCompliancePolicies'
    'beta/deviceManagement/intents'
    'v1.0/deviceManagement/intents'
    'v1.0/deviceAppManagement/mobileApps'
    'beta/deviceAppManagement/mobileApps'
    'v1.0/deviceManagement/detectedApps'
    'beta/deviceManagement/windowsAutopilotDeploymentProfiles'
    'beta/deviceManagement/depOnboardingSettings'
    'beta/deviceManagement/androidDeviceOwnerEnrollmentProfiles'
    'v1.0/deviceManagement/managedDevices'
    'v1.0/informationProtection/bitlocker/recoveryKeys'
    'v1.0/security/vulnerabilities'
    'beta/security/vulnerabilities'
    'v1.0/security/mdeOnboardingState'
    'beta/security/mdeOnboardingState'
    'v1.0/security/alerts_v2'
    'beta/security/alerts_v2'
)

# Read-only worker cases. Provides maps a key to a dot path in the case's JSON result;
# dependent cases substitute %key% in their job fields and are skipped when it is absent.
$cases = @(
    @{ Name = 'intune-config-list'; Entry = 'get-intune-policies.ps1'; Job = @{ kind = 'configuration' }; Provides = @{ policyId = 'items.0.id'; policyName = 'items.0.name' } }
    @{ Name = 'intune-config-detail'; Entry = 'get-intune-policies.ps1'; Job = @{ kind = 'configuration'; policyId = '%policyId%' }; DependsOn = 'intune-config-list' }
    @{ Name = 'intune-compliance-list'; Entry = 'get-intune-policies.ps1'; Job = @{ kind = 'compliance' }; Provides = @{ complianceId = 'items.0.id' } }
    @{ Name = 'intune-compliance-detail'; Entry = 'get-intune-policies.ps1'; Job = @{ kind = 'compliance'; policyId = '%complianceId%' }; DependsOn = 'intune-compliance-list' }
    @{ Name = 'intune-apps'; Entry = 'get-intune-apps.ps1'; Job = @{}; Provides = @{ appId = 'items.0.id' } }
    @{ Name = 'intune-app-status'; Entry = 'get-intune-app-status.ps1'; Job = @{ action = 'apps' }; DependsOn = 'intune-apps' }
    @{ Name = 'managed-devices'; Entry = 'get-managed-devices.ps1'; Job = @{}; Provides = @{ deviceId = 'items.0.id' } }
    @{ Name = 'managed-device'; Entry = 'get-managed-device.ps1'; Job = @{ deviceId = '%deviceId%' }; DependsOn = 'managed-devices' }
    @{ Name = 'bitlocker-keys'; Entry = 'get-bitlocker-keys.ps1'; Job = @{ deviceId = '%deviceId%' }; DependsOn = 'managed-devices' }
    @{ Name = 'laps-credentials'; Entry = 'get-laps-credentials.ps1'; Job = @{ deviceId = '%deviceId%' }; DependsOn = 'managed-devices' }
    @{ Name = 'defender-status'; Entry = 'get-defender-status.ps1'; Job = @{} }
    @{ Name = 'tvm-vulnerabilities'; Entry = 'get-tvm-vulnerabilities.ps1'; Job = @{} }
    @{ Name = 'mde-onboarding'; Entry = 'get-mde-onboarding.ps1'; Job = @{} }
    @{ Name = 'mailboxes'; Entry = 'get-mailboxes.ps1'; Job = @{}; Payload = @{}; Provides = @{ mailboxId = 'items.0.id' } }
    @{ Name = 'mailbox-permissions'; Entry = 'get-mailbox-permissions.ps1'; Job = @{} }
)

function Get-ProbeBodyMessage {
    param([Parameter()][string]$Body)

    if (-not $Body) { return '' }
    $index = $Body.IndexOf('{"error"')
    if ($index -ge 0) {
        try { return [string](($Body.Substring($index) | ConvertFrom-Json).error.message) }
        catch { Write-Verbose "Graph error body was not JSON: $($_.Exception.Message)" }
    }
    $index = $Body.IndexOf('"Message"')
    if ($index -ge 0) {
        try {
            $json = $Body.Substring($Body.IndexOf('{'))
            return [string](($json | ConvertFrom-Json).Message -replace '\s+', ' ')
        }
        catch { Write-Verbose "Intune error body was not JSON: $($_.Exception.Message)" }
    }
    return ''
}

function Resolve-DotPath {
    param(
        [Parameter()][object]$InputObject,
        [Parameter(Mandatory)][string]$Path
    )

    $current = $InputObject
    foreach ($segment in $Path.Split('.')) {
        if ($null -eq $current) { return $null }
        if ($current -is [System.Collections.IDictionary]) {
            if (-not $current.Contains($segment)) { return $null }
            $current = $current[$segment]
            continue
        }
        if ($current -is [System.Array] -or $current -is [System.Collections.IList]) {
            $index = 0
            if (-not [int]::TryParse($segment, [ref]$index)) { return $null }
            if ($index -ge $current.Count) { return $null }
            $current = $current[$index]
            continue
        }
        $property = $current.PSObject.Properties[$segment]
        if (-not $property) { return $null }
        $current = $property.Value
    }
    return $current
}

function Expand-JobField {
    param(
        [Parameter()][object]$Value,
        [Parameter(Mandatory)][hashtable]$Provided
    )

    if ($Value -is [string] -and $Value.StartsWith('%') -and $Value.EndsWith('%')) {
        $key = $Value.Trim('%')
        if (-not $Provided.ContainsKey($key)) { return $null }
        return $Provided[$key]
    }
    return $Value
}

function Invoke-WorkerEntrypoint {
    param(
        [Parameter(Mandatory)][string]$Entrypoint,
        [Parameter(Mandatory)][string]$JobFile,
        [Parameter(Mandatory)][int]$TimeoutSeconds
    )

    $scriptPath = Join-Path -Path $workersDir -ChildPath $Entrypoint
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = (Get-Command -Name 'pwsh').Source
    foreach ($argument in @('-NoProfile', '-File', $scriptPath, '-JobFile', $JobFile)) {
        $psi.ArgumentList.Add($argument)
    }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false

    $process = [System.Diagnostics.Process]::Start($psi)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = -not $process.WaitForExit($TimeoutSeconds * 1000)
    if ($timedOut) {
        try { $process.Kill($true) } catch { Write-Verbose "Kill after timeout failed: $($_.Exception.Message)" }
    }
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result

    return [pscustomobject]@{
        ExitCode = if ($timedOut) { -1 } else { $process.ExitCode }
        Stdout   = $stdout
        Stderr   = $stderr
        TimedOut = $timedOut
    }
}

$provided = @{}
$results = @()
$started = Get-Date

foreach ($definition in $cases) {
    if ($Case.Count -gt 0 -and $Case -notcontains $definition.Name) { continue }

    $status = 'ok'
    $skipReason = ''
    $job = [ordered]@{
        schemaVersion = 'v1'
        tenantId      = $TenantId
        credential    = [ordered]@{
            credentialRef = $CredentialRef
            record        = $credentialRecord
        }
    }

    foreach ($key in $definition.Job.Keys) {
        $expanded = Expand-JobField -Value $definition.Job[$key] -Provided $provided
        if ($null -eq $expanded) {
            $status = 'skipped'
            $skipReason = "no '$key' available (dependency produced none)"
            break
        }
        $job[$key] = $expanded
    }

    if ($definition.ContainsKey('Payload')) {
        $job['payload'] = $definition.Payload
    }

    $jobFile = Join-Path -Path $jobDir -ChildPath "$($definition.Name).json"
    $rawFile = Join-Path -Path $rawDir -ChildPath "$($definition.Name).json"

    if ($status -eq 'skipped') {
        $results += [pscustomobject]@{
            Name = $definition.Name; Entry = $definition.Entry; Status = 'skipped'
            ExitCode = $null; DurationMs = 0; Summary = $skipReason; Error = ''; RawFile = ''
        }
        continue
    }

    $job | ConvertTo-Json -Depth 8 | Set-Content -Path $jobFile -Encoding UTF8

    $caseStart = Get-Date
    $run = Invoke-WorkerEntrypoint -Entrypoint $definition.Entry -JobFile $jobFile -TimeoutSeconds $TimeoutSeconds
    $duration = [int]((Get-Date) - $caseStart).TotalMilliseconds

    Set-Content -Path (Join-Path -Path $rawDir -ChildPath "$($definition.Name).stdout.txt") -Value $run.Stdout -Encoding UTF8
    Set-Content -Path (Join-Path -Path $rawDir -ChildPath "$($definition.Name).stderr.txt") -Value $run.Stderr -Encoding UTF8

    $summary = ''
    $errorText = ''
    if ($run.TimedOut) {
        $status = 'timeout'
        $errorText = "timed out after ${TimeoutSeconds}s"
    }
    elseif ($run.ExitCode -ne 0) {
        $status = 'failed'
        $errorText = if ($run.Stderr.Trim()) { $run.Stderr.Trim() } else { "exit code $($run.ExitCode)" }
    }
    else {
        Set-Content -Path $rawFile -Value $run.Stdout -Encoding UTF8
        try {
            $parsed = $run.Stdout | ConvertFrom-Json
            if ($parsed -is [System.Collections.IDictionary] -and $parsed.Contains('error')) {
                $status = 'failed'
                $errorText = [string]$parsed['message']
            }
            else {
                $keys = @($parsed.PSObject.Properties.Name)
                $counts = foreach ($key in $keys) {
                    $value = $parsed.$key
                    if ($value -is [System.Array]) { "$key=$($value.Count)" }
                    elseif ($value -is [System.Collections.IList]) { "$key=$($value.Count)" }
                }
                $summary = if ($counts) { $counts -join ' ' } else { "keys: $($keys -join ',')" }
                foreach ($provideKey in $definition.Provides.Keys) {
                    $resolved = Resolve-DotPath -InputObject $parsed -Path $definition.Provides[$provideKey]
                    if ($null -ne $resolved -and [string]$resolved -ne '') {
                        $provided[$provideKey] = $resolved
                    }
                }
            }
        }
        catch {
            $status = 'failed'
            $errorText = "stdout was not JSON: $($_.Exception.Message)"
        }
    }

    if ($errorText -and $errorText.Length -gt 400) { $errorText = $errorText.Substring(0, 400) + '...' }
    $results += [pscustomobject]@{
        Name = $definition.Name; Entry = $definition.Entry; Status = $status
        ExitCode = $run.ExitCode; DurationMs = $duration; Summary = $summary; Error = $errorText; RawFile = $rawFile
    }
}

$probeResults = @()
if (-not $SkipProbes) {
    $probeScript = Join-Path -Path $PSScriptRoot -ChildPath 'Get-GraphEndpointProbe.ps1'
    $probeOut = Join-Path -Path $OutDirectory -ChildPath 'probes.json'
    $probeParams = @{
        TenantId      = $TenantId
        CredentialRef = $CredentialRef
        ClientId      = $ClientId
        Thumbprint    = $Thumbprint
        Environment   = $Environment
        Uri           = $probeUris
        OutFile       = $probeOut
    }
    & $probeScript @probeParams | Out-Null
    if (Test-Path -LiteralPath $probeOut) {
        $probeResults = @(Get-Content -LiteralPath $probeOut -Raw | ConvertFrom-Json)
    }
}

$duration = [int]((Get-Date) - $started).TotalSeconds

$report = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    tenantId    = $TenantId
    durationSec = $duration
    workerCases = $results
    probes      = $probeResults
}
$report | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path -Path $OutDirectory -ChildPath 'report.json') -Encoding UTF8

$markdown = [System.Collections.Generic.List[string]]::new()
$markdown.Add('# Live worker verification')
$markdown.Add('')
$markdown.Add("Generated: $($report.generatedAt)  |  Tenant: ``$TenantId``  |  ${duration}s")
$markdown.Add('')
$markdown.Add('## Worker cases')
$markdown.Add('')
$markdown.Add('| Case | Entrypoint | Status | Exit | ms | Summary | Error |')
$markdown.Add('|---|---|---|---|---|---|---|')
foreach ($r in $results) {
    $errorCell = if ($r.Error) { ($r.Error -replace '\|', '\|' -replace '\r?\n', ' ') } else { '' }
    $summary = $r.Summary -replace '\|', '\|'
    $markdown.Add("| $($r.Name) | $($r.Entry) | $($r.Status) | $($r.ExitCode) | $($r.DurationMs) | $summary | $errorCell |")
}
$markdown.Add('')
$markdown.Add('## Graph endpoint probes (read-only)')
$markdown.Add('')
$markdown.Add('| URI | OK | Status | Count | Error |')
$markdown.Add('|---|---|---|---|---|')
foreach ($p in $probeResults) {
    $detail = if ($p.body) { Get-ProbeBodyMessage -Body $p.body } else { '' }
    $errorCell = if ($detail) { $detail } elseif ($p.error) { $p.error } else { '' }
    $errorCell = $errorCell -replace '\|', '\|' -replace '\r?\n', ' '
    if ($errorCell.Length -gt 300) { $errorCell = $errorCell.Substring(0, 300) + '...' }
    $markdown.Add("| ``$($p.uri)`` | $($p.ok) | $($p.status) | $($p.count) | $errorCell |")
}
$markdown.Add('')
Set-Content -Path (Join-Path -Path $OutDirectory -ChildPath 'report.md') -Value $markdown -Encoding UTF8

Write-Host "Report: $(Join-Path -Path $OutDirectory -ChildPath 'report.md')"
$results | Format-Table -AutoSize | Out-String | Write-Host
