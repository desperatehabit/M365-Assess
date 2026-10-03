# Deploy-DefenderPolicies.ps1 — EPIC-019 Defender setup deploy worker (SPEC §3.2, §4.2, §6, §9, §11.2; T-0364).
#
# Deploys recommended Defender policies (AV/EDR/ASR first per SPEC §11.2) to one target tenant:
# - Builds a plan per selected policy area by diffing recommended settings against live policies.
# - A live policy with the same name blocks the deploy unless overwrite is on (§9 mitigation).
# - Applies on confirm (DryRun $false); every created policy emits an AuditEvent (§4.2).
# - When SaveAsTemplate is requested, returns a templateDraft shaped as a T-0363
#   DefenderDeploymentTemplate so the BFF can persist it and hand off to the EPIC-016
#   Intune template path; otherwise no template artifact is produced.

$script:DefenderDeployAreas = @(
    @{ Area = 'av'; DisplayName = 'Antivirus (AV)'; GraphResource = '/beta/deviceManagement/configurationPolicies'; NameProperty = 'name'; PolicyName = 'Defender AV Baseline'; Recommended = 'Real-time protection enabled with up-to-date signatures'; Supported = $true; Settings = @{ realTimeProtection = 'enable'; cloudDeliveredProtection = 'enable'; signatureUpdateSchedule = 'daily' } }
    @{ Area = 'edr'; DisplayName = 'Endpoint Detection and Response (EDR)'; GraphResource = '/beta/deviceManagement/intents'; NameProperty = 'displayName'; PolicyName = 'Defender EDR Onboarding'; Recommended = 'Devices onboarded to Defender for Endpoint in block mode'; Supported = $true; Settings = @{ onboardingMode = 'block'; telemetryReportingFrequency = 'continuous' } }
    @{ Area = 'asr'; DisplayName = 'Attack Surface Reduction (ASR)'; GraphResource = '/beta/deviceManagement/intents'; NameProperty = 'displayName'; PolicyName = 'Defender ASR Baseline'; Recommended = 'ASR rules in block or warn mode per baseline'; Supported = $true; Settings = @{ blockOfficeChildProcessCreation = 'block'; blockCredentialStealing = 'block'; blockUntrustedUnsignedProcesses = 'warn' } }
    @{ Area = 'compliance'; DisplayName = 'Device Compliance'; GraphResource = '/v1.0/deviceManagement/deviceCompliancePolicies'; NameProperty = 'displayName'; PolicyName = 'Defender Compliance Baseline'; Recommended = 'Compliance policies assigned with conditional access'; Supported = $false; Settings = @{} }
    @{ Area = 'firewall'; DisplayName = 'Host Firewall'; GraphResource = '/beta/deviceManagement/intents'; NameProperty = 'displayName'; PolicyName = 'Defender Firewall Baseline'; Recommended = 'Host firewall enabled on all profiles'; Supported = $false; Settings = @{} }
    @{ Area = 'exclusions'; DisplayName = 'Exclusions'; GraphResource = '/beta/deviceManagement/configurationPolicies'; NameProperty = 'name'; PolicyName = 'Defender Exclusions Baseline'; Recommended = 'No standing allow-list entries without expiry'; Supported = $false; Settings = @{} }
)

function Read-DefenderDeployJob {
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
        TenantId       = [string]$json.tenantId
        PolicyAreas    = if ($json.policyAreas) { @($json.policyAreas | ForEach-Object { [string]$_ }) } else { @() }
        TargetScope    = if ($json.targetScope) { [string]$json.targetScope } else { 'allDevices' }
        Overwrite      = [bool]($json.overwrite -eq $true)
        DryRun         = [bool]($json.dryRun -eq $true)
        SaveAsTemplate = [bool]($json.saveAsTemplate -eq $true)
        TemplateName   = if ($json.templateName) { [string]$json.templateName } else { '' }
        Actor          = if ($json.actor) { [string]$json.actor } else { 'system' }
    }
}

function Get-DefenderDeployValue {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function Get-DefenderDeployPayload {
    param(
        [Parameter(Mandatory)]
        [hashtable]$Entry
    )

    $payload = @{ $Entry.NameProperty = $Entry.PolicyName }
    foreach ($key in $Entry.Settings.Keys) {
        $payload[$key] = $Entry.Settings[$key]
    }
    return $payload
}

function Build-DefenderDeployDiff {
    param(
        $Before,
        [Parameter(Mandatory)][hashtable]$After,
        [Parameter(Mandatory)][hashtable]$Entry
    )

    $diff = [System.Collections.Generic.List[string]]::new()
    $name = $After[$Entry.NameProperty]
    if ($null -eq $Before) {
        $diff.Add("+ Policy ($($Entry.Area)): $name")
        foreach ($key in ($After.Keys | Sort-Object)) {
            if ($key -eq $Entry.NameProperty) { continue }
            $diff.Add("+ ${key}: $($After[$key])")
        }
    }
    else {
        $diff.Add("~ Overwriting existing policy '$name' (ID: $($Before['id']))")
        $changed = 0
        foreach ($key in ($After.Keys | Sort-Object)) {
            $old = [string](Get-DefenderDeployValue -Object $Before['live'] -Name $key)
            $new = [string]$After[$key]
            if ($old -ne $new) {
                $diff.Add("~ ${key}: '$old' -> '$new'")
                $changed++
            }
        }
        if ($changed -eq 0) { $diff.Add('= Settings match the live policy') }
    }
    return @($diff)
}

function Invoke-DeployDefenderPolicies {
    <#
    .SYNOPSIS
        Plans (DryRun) or applies a Defender policy deploy for one tenant.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string[]]$PolicyAreas = @(),

        [string]$TargetScope = 'allDevices',

        [bool]$Overwrite = $false,

        [bool]$DryRun = $false,

        [bool]$SaveAsTemplate = $false,

        [string]$TemplateName = '',

        [string]$CreatedBy = 'system'
    )

    $selected = @($PolicyAreas | ForEach-Object { "$_".Trim().ToLowerInvariant() } | Where-Object { $_ })
    if ($selected.Count -eq 0) {
        throw "at least one Defender policy area is required in 'policyAreas'"
    }
    $known = @($script:DefenderDeployAreas | ForEach-Object { $_['Area'] })
    foreach ($area in $selected) {
        if ($known -notcontains $area) {
            throw "unknown Defender policy area '$area'; supported: $($known -join ', ')"
        }
    }
    if ($SaveAsTemplate -and [string]::IsNullOrWhiteSpace($TemplateName)) {
        throw "templateName is required when saveAsTemplate is requested"
    }

    $plans = [System.Collections.Generic.List[object]]::new()
    $liveByArea = @{}
    foreach ($area in $selected) {
        $entry = @($script:DefenderDeployAreas | Where-Object { $_['Area'] -eq $area })[0]
        if (-not $entry['Supported']) {
            $plans.Add([pscustomobject]@{
                area            = $area
                displayName     = $entry['DisplayName']
                supported       = $false
                action          = 'unsupported'
                policyName      = $entry['PolicyName']
                targetScope     = $TargetScope
                overwrite       = $Overwrite
                conflict        = $false
                conflictMessage = "Defender policy area '$area' is not yet supported in v1; supported areas: av, edr, asr"
                diff            = @()
                valid           = $false
                dryRun          = $DryRun
            })
            continue
        }

        $payload = Get-DefenderDeployPayload -Entry $entry
        $policyName = $entry['PolicyName']

        $existing = $null
        try {
            $listResp = Invoke-MgGraphRequest -Method GET -Uri $entry['GraphResource']
            $live = @(Get-DefenderDeployValue -Object $listResp -Name 'value')
            if ($live.Count -eq 1 -and $null -eq $live[0]) { $live = @() }
            foreach ($p in $live) {
                if ($p -and ([string](Get-DefenderDeployValue -Object $p -Name $entry['NameProperty'])).Trim() -eq $policyName) {
                    $existing = $p
                    break
                }
            }
        }
        catch {
            # An unreadable baseline must not silently deploy; surface it as invalid.
            $plans.Add([pscustomobject]@{
                area            = $area
                displayName     = $entry['DisplayName']
                supported       = $true
                action          = 'create'
                policyName      = $policyName
                targetScope     = $TargetScope
                overwrite       = $Overwrite
                conflict        = $false
                conflictMessage = $null
                diff            = @()
                valid           = $false
                dryRun          = $DryRun
            })
            continue
        }

        $liveByArea[$area] = $existing
        $conflict = $false
        $conflictMessage = $null
        $before = $null
        if ($existing) {
            $before = @{
                id   = [string](Get-DefenderDeployValue -Object $existing -Name 'id')
                live = $existing
            }
            if (-not $Overwrite) {
                $conflict = $true
                $conflictMessage = "A $($entry['DisplayName']) policy named '$policyName' already exists in the tenant. Enable overwrite to update it."
            }
        }

        $diff = Build-DefenderDeployDiff -Before $before -After $payload -Entry $entry
        $plans.Add([pscustomobject]@{
            area            = $area
            displayName     = $entry['DisplayName']
            supported       = $true
            action          = if ($existing -and $Overwrite) { 'update' } else { 'create' }
            policyName      = $policyName
            targetScope     = $TargetScope
            overwrite       = $Overwrite
            conflict        = $conflict
            conflictMessage = $conflictMessage
            diff            = $diff
            valid           = (-not $conflict)
            dryRun          = $DryRun
        })
    }

    $planArray = @($plans)
    $allValid = ($planArray | Where-Object { -not $_.valid }).Count -eq 0

    $templateDraft = $null
    if ($SaveAsTemplate) {
        $supportedPlans = @($planArray | Where-Object { $_.supported })
        $policyJson = @{}
        foreach ($area in $supportedPlans) {
            $entry = @($script:DefenderDeployAreas | Where-Object { $_['Area'] -eq $area.area })[0]
            $policyJson[$area.area] = (Get-DefenderDeployPayload -Entry $entry)
        }
        $templateDraft = [pscustomobject]@{
            name        = $TemplateName.Trim()
            policyAreas = @($supportedPlans | ForEach-Object { $_.area })
            policyJson  = $policyJson
        }
    }

    if ($DryRun) {
        return [pscustomobject]@{
            success       = $allValid
            plans         = $planArray
            allValid      = $allValid
            dryRun        = $true
            templateDraft = $templateDraft
        }
    }

    $blockers = @($planArray | Where-Object { -not $_.valid })
    if ($blockers.Count -gt 0) {
        $reasons = @($blockers | ForEach-Object {
            if ($_.conflict) { $_.conflictMessage } else { "area '$($_.area)' is not deployable: $($_.conflictMessage)" }
        })
        throw "Deploy blocked for tenant '$TenantId': $($reasons -join '; ')"
    }

    $results = [System.Collections.Generic.List[object]]::new()
    $auditEvents = [System.Collections.Generic.List[object]]::new()
    $failed = 0
    foreach ($plan in $planArray) {
        $entry = @($script:DefenderDeployAreas | Where-Object { $_['Area'] -eq $plan.area })[0]
        $payload = Get-DefenderDeployPayload -Entry $entry
        $existing = $liveByArea[$plan.area]
        $policyId = $null
        try {
            $body = $payload | ConvertTo-Json -Depth 10 -Compress
            if ($existing -and $Overwrite) {
                $policyId = [string](Get-DefenderDeployValue -Object $existing -Name 'id')
                $null = Invoke-MgGraphRequest -Method PATCH -Uri "$($entry['GraphResource'])/$policyId" -Body $body
            }
            else {
                $created = Invoke-MgGraphRequest -Method POST -Uri $entry['GraphResource'] -Body $body
                $policyId = [string](Get-DefenderDeployValue -Object $created -Name 'id')
                if ([string]::IsNullOrWhiteSpace($policyId)) { $policyId = [guid]::NewGuid().ToString() }
            }
            $auditEvents.Add([pscustomobject]@{
                id         = [guid]::NewGuid().ToString()
                tenantId   = $TenantId
                action     = if ($existing) { 'defender.deploy.update' } else { 'defender.deploy.create' }
                targetId   = $policyId
                targetName = $plan.policyName
                area       = $plan.area
                actor      = $CreatedBy
                timestamp  = (Get-Date).ToUniversalTime().ToString('o')
                before     = if ($existing) { @{ id = [string](Get-DefenderDeployValue -Object $existing -Name 'id') } } else { $null }
                after      = $payload
            })
            $results.Add([pscustomobject]@{
                area     = $plan.area
                policyId = $policyId
                action   = $plan.action
                state    = 'succeeded'
                error    = $null
            })
        }
        catch {
            $failed++
            $results.Add([pscustomobject]@{
                area     = $plan.area
                policyId = $null
                action   = $plan.action
                state    = 'failed'
                error    = $_.ToString()
            })
        }
    }

    $resultArray = @($results)
    return [pscustomobject]@{
        success       = ($failed -eq 0)
        state         = if ($failed -eq 0) { 'succeeded' } else { 'partial' }
        tenantId      = $TenantId
        plans         = $planArray
        results       = $resultArray
        auditEvents   = @($auditEvents)
        templateDraft = $templateDraft
        error         = $null
    }
}
