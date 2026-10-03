# Get-DefenderStatus.ps1 — EPIC-019 Defender status worker (SPEC §2 US-1, §3.1, §6; T-0361).
#
# Live reads only: each v1 area (AV/EDR/ASR) combines one Graph GET against the
# registry resource with the same EXO Get-* cmdlets the module's Defender
# assessment uses (Get-DefenderPolicyReport.ps1 and Defender*Checks.ps1), so
# current vs recommended stays consistent with the assessment without
# duplicating its logic. Deferred areas return a not-yet-supported marker
# without issuing any query. The worker is read-only: only GET requests and
# EXO Get-* cmdlets are issued.

$script:DefenderStatusRegistry = @(
    @{ Area = 'av'; DisplayName = 'Antivirus (AV)'; Source = 'device-management'; GraphResource = 'beta/deviceManagement/configurationPolicies'; Recommended = 'Real-time protection enabled with up-to-date signatures'; Supported = $true; ModuleChecks = @('DEFENDER-ANTIMALWARE-001', 'DEFENDER-ANTIMALWARE-002', 'DEFENDER-MALWARE-001', 'DEFENDER-MALWARE-002') }
    @{ Area = 'edr'; DisplayName = 'Endpoint Detection and Response (EDR)'; Source = 'graph-security'; GraphResource = 'v1.0/security/alerts_v2'; Recommended = 'Devices onboarded to Defender for Endpoint in block mode'; Supported = $true; ModuleChecks = @('DEFENDER-ZAP-001', 'DEFENDER-PRIORITY-001') }
    @{ Area = 'asr'; DisplayName = 'Attack Surface Reduction (ASR)'; Source = 'device-management'; GraphResource = 'beta/deviceManagement/intents'; Recommended = 'ASR rules in block or warn mode per baseline'; Supported = $true; ModuleChecks = @('DEFENDER-ANTIPHISH-001', 'DEFENDER-SAFELINKS-001', 'DEFENDER-SAFEATTACH-001') }
    @{ Area = 'compliance'; DisplayName = 'Device Compliance'; Source = 'device-management'; GraphResource = 'v1.0/deviceManagement/deviceCompliancePolicies'; Recommended = 'Compliance policies assigned with conditional access'; Supported = $false; ModuleChecks = @() }
    @{ Area = 'exclusions'; DisplayName = 'Exclusions'; Source = 'exo'; GraphResource = 'exo:Get-TenantAllowBlockList'; Recommended = 'No standing allow-list entries without expiry'; Supported = $false; ModuleChecks = @() }
    @{ Area = 'firewall'; DisplayName = 'Firewall'; Source = 'device-management'; GraphResource = 'beta/deviceManagement/intents'; Recommended = 'Host firewall enabled on all profiles'; Supported = $false; ModuleChecks = @() }
)

function Read-DefenderStatusJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-DefenderStatus.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "job envelope not found at '$Path'"
    }

    $raw = Get-Content -LiteralPath $Path -Raw
    $json = $raw | ConvertFrom-Json
    if (-not $json.tenantId) {
        throw "job envelope '$Path' is missing mandatory 'tenantId'"
    }

    return @{
        TenantId = [string]$json.tenantId
        Area     = if ($json.area) { [string]$json.area } else { '' }
    }
}

function Get-DefenderGraphCount {
    param(
        [Parameter(Mandatory)]
        [string]$GraphResource
    )

    $uri = '/{0}?$top=1' -f $GraphResource
    $response = Invoke-MgGraphRequest -Method GET -Uri $uri
    if ($null -eq $response) { return 0 }
    $values = $null
    if ($response -is [System.Collections.IDictionary] -and $response.Contains('value')) {
        $values = $response['value']
    }
    elseif ($null -ne $response.value) {
        $values = $response.value
    }
    if ($null -eq $values) { return 1 }
    return @($values).Count
}

function ConvertTo-DefenderUnsupportedArea {
    param(
        [Parameter(Mandatory)]
        [hashtable]$Entry
    )

    return [pscustomobject]@{
        area        = $Entry.Area
        displayName = $Entry.DisplayName
        source      = $Entry.Source
        supported   = $false
        current     = 'Not yet supported in v1'
        recommended = $Entry.Recommended
        status      = 'Unsupported'
        findings    = @()
    }
}

function Get-DefenderAvArea {
    param([hashtable]$Entry)

    $findings = [System.Collections.Generic.List[object]]::new()
    $status = 'Pass'
    try {
        $count = Get-DefenderGraphCount -GraphResource $Entry.GraphResource
        if ($count -le 0) { $status = 'Warning' }
    }
    catch {
        $count = -1
        $status = 'Warning'
    }

    # Same EXO cmdlet the module's anti-malware checks assess (DefenderAntiMalwareChecks.ps1).
    $exoAvailable = Get-Command -Name Get-MalwareFilterPolicy -ErrorAction SilentlyContinue
    if ($exoAvailable) {
        try {
            $policies = @(Get-MalwareFilterPolicy -ErrorAction Stop)
            $disabled = @($policies | Where-Object { -not $_.EnableFileFilter })
            foreach ($policy in $policies) {
                $ok = [bool]$policy.EnableFileFilter
                $findings.Add([pscustomobject]@{
                    setting          = "Common Attachment Filter ($($policy.Name))"
                    currentValue     = "$($policy.EnableFileFilter)"
                    recommendedValue = 'True'
                    status           = if ($ok) { 'Pass' } else { 'Fail' }
                    checkId          = 'DEFENDER-ANTIMALWARE-001'
                })
            }
            if ($disabled.Count -gt 0) { $status = 'Fail' }
        }
        catch {
            $status = 'Warning'
        }
    }

    if ($count -lt 0) {
        $current = 'AV policy state unknown (Graph query failed)'
    }
    elseif ($count -eq 0 -and $findings.Count -eq 0) {
        $current = 'No AV policies found'
    }
    elseif ($findings.Count -gt 0) {
        $current = "$($findings.Count) anti-malware findings from Get-MalwareFilterPolicy"
    }
    else {
        $current = "$count AV policies in device management"
    }

    return [pscustomobject]@{
        area        = $Entry.Area
        displayName = $Entry.DisplayName
        source      = $Entry.Source
        supported   = $true
        current     = $current
        recommended = $Entry.Recommended
        status      = $status
        findings    = @($findings)
    }
}

function Get-DefenderEdrArea {
    param([hashtable]$Entry)

    $findings = [System.Collections.Generic.List[object]]::new()
    try {
        $null = Get-DefenderGraphCount -GraphResource $Entry.GraphResource
        $current = 'EDR telemetry available via Graph security'
        $status = 'Pass'
    }
    catch {
        $current = 'EDR telemetry unavailable (Graph query failed)'
        $status = 'Warning'
    }

    # Same EXO cmdlet the module's ZAP check assesses (DefenderPresetZapChecks.ps1).
    $atpAvailable = Get-Command -Name Get-AtpPolicyForO365 -ErrorAction SilentlyContinue
    if ($atpAvailable) {
        try {
            $atp = Get-AtpPolicyForO365 -ErrorAction Stop
            $zapOn = [bool]$atp.ZapEnabled
            $findings.Add([pscustomobject]@{
                setting          = 'ZAP for Teams'
                currentValue     = "$($atp.ZapEnabled)"
                recommendedValue = 'True'
                status           = if ($zapOn) { 'Pass' } else { 'Fail' }
                checkId          = 'DEFENDER-ZAP-001'
            })
            if (-not $zapOn -and $status -eq 'Pass') { $status = 'Warning' }
        }
        catch {
            if ($status -eq 'Pass') { $status = 'Warning' }
        }
    }

    return [pscustomobject]@{
        area        = $Entry.Area
        displayName = $Entry.DisplayName
        source      = $Entry.Source
        supported   = $true
        current     = $current
        recommended = $Entry.Recommended
        status      = $status
        findings    = @($findings)
    }
}

function Get-DefenderAsrArea {
    param([hashtable]$Entry)

    $findings = [System.Collections.Generic.List[object]]::new()
    $status = 'Pass'
    try {
        $count = Get-DefenderGraphCount -GraphResource $Entry.GraphResource
        if ($count -le 0) { $status = 'Warning' }
    }
    catch {
        $count = -1
        $status = 'Warning'
    }

    # Same EXO cmdlets the module's anti-phishing and Safe Links checks assess.
    $phishAvailable = Get-Command -Name Get-AntiPhishPolicy -ErrorAction SilentlyContinue
    if ($phishAvailable) {
        try {
            $policies = @(Get-AntiPhishPolicy -ErrorAction Stop)
            foreach ($policy in $policies) {
                $ok = $false
                try { $ok = ([int]$policy.PhishThresholdLevel -ge 2) } catch { $ok = $false }
                $findings.Add([pscustomobject]@{
                    setting          = "Phishing Threshold ($($policy.Name))"
                    currentValue     = "$($policy.PhishThresholdLevel)"
                    recommendedValue = '2+ (Aggressive)'
                    status           = if ($ok) { 'Pass' } else { 'Fail' }
                    checkId          = 'DEFENDER-ANTIPHISH-001'
                })
                if (-not $ok) { $status = 'Fail' }
            }
        }
        catch {
            if ($status -eq 'Pass') { $status = 'Warning' }
        }
    }

    $linksAvailable = Get-Command -Name Get-SafeLinksPolicy -ErrorAction SilentlyContinue
    if ($linksAvailable) {
        try {
            $links = @(Get-SafeLinksPolicy -ErrorAction Stop)
            if ($links.Count -eq 0) {
                $findings.Add([pscustomobject]@{
                    setting          = 'Safe Links Policies'
                    currentValue     = 'None configured'
                    recommendedValue = 'At least 1 policy'
                    status           = 'Warning'
                    checkId          = 'DEFENDER-SAFELINKS-001'
                })
                if ($status -eq 'Pass') { $status = 'Warning' }
            }
        }
        catch {
            if ($status -eq 'Pass') { $status = 'Warning' }
        }
    }

    if ($count -lt 0) {
        $current = 'ASR policy state unknown (Graph query failed)'
    }
    elseif ($findings.Count -gt 0) {
        $current = "$($findings.Count) mail-hygiene findings from module Defender checks"
    }
    elseif ($count -eq 0) {
        $current = 'No ASR intents in device management'
    }
    else {
        $current = "$count ASR intents in device management"
    }

    return [pscustomobject]@{
        area        = $Entry.Area
        displayName = $Entry.DisplayName
        source      = $Entry.Source
        supported   = $true
        current     = $current
        recommended = $Entry.Recommended
        status      = $status
        findings    = @($findings)
    }
}

function Get-DefenderStatus {
    <#
    .SYNOPSIS
        Reads Defender configuration state per policy area (current vs recommended).
    .DESCRIPTION
        Read-only. v1 areas (AV/EDR/ASR) query Graph plus the module's EXO
        Defender cmdlets; deferred areas return a not-yet-supported marker.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [ValidateSet('', 'av', 'edr', 'asr', 'compliance', 'firewall', 'exclusions')]
        [string]$Area = ''
    )

    $entries = @($script:DefenderStatusRegistry)
    if (-not [string]::IsNullOrWhiteSpace($Area)) {
        $entries = @($entries | Where-Object { $_.Area -eq $Area })
    }

    $areas = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $entries) {
        if (-not $entry.Supported) {
            $areas.Add((ConvertTo-DefenderUnsupportedArea -Entry $entry))
            continue
        }
        switch ($entry.Area) {
            'av' { $areas.Add((Get-DefenderAvArea -Entry $entry)) }
            'edr' { $areas.Add((Get-DefenderEdrArea -Entry $entry)) }
            'asr' { $areas.Add((Get-DefenderAsrArea -Entry $entry)) }
            default { $areas.Add((ConvertTo-DefenderUnsupportedArea -Entry $entry)) }
        }
    }

    return [pscustomobject]@{
        tenantId = $TenantId
        areas    = @($areas)
    }
}
