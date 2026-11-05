<#
.SYNOPSIS
    Evaluates Intune endpoint hardening for CMMC: device encryption, PowerShell
    script execution policy, and Windows Firewall default-deny.
.DESCRIPTION
    Reads Intune compliance policies and Settings catalog / Endpoint security
    policies (configurationPolicies) and emits:

    - INTUNE-ENCRYPTION-001 (MP.L2-3.8.6, SC.L2-3.13.16): an assigned Windows
      compliance policy requires BitLocker/encryption, or an assigned Endpoint
      security disk encryption policy exists. macOS compliance encryption is
      reported alongside.
    - INTUNE-MOBILECODE-001 (SC.L2-3.13.13): an assigned Settings catalog policy
      turns on PowerShell script execution restricted to AllSigned or
      RemoteSigned.
    - INTUNE-FIREWALL-001 (SC.L1-B.1.XI, SC.L2-3.13.1, 3.13.5, 3.13.6): an assigned
      Endpoint security firewall policy enables Windows Firewall with inbound
      traffic blocked by default on the domain, private, and public profiles.

    Settings catalog values are matched on their setting definition ids, for
    example vendor_msft_firewall_mdmstore_publicprofile_defaultinboundaction_1.
    Requires an active Microsoft Graph connection with
    DeviceManagementConfiguration.Read.All permission.
.PARAMETER OutputPath
    Optional path to export results as CSV. If not specified, results are returned
    to the pipeline.
.EXAMPLE
    PS> .\Intune\Get-IntuneEndpointHardeningConfig.ps1

    Displays the endpoint hardening evaluation for the connected tenant.
.EXAMPLE
    PS> .\Intune\Get-IntuneEndpointHardeningConfig.ps1 -OutputPath '.\intune-hardening.csv'

    Exports the evaluation to CSV.
.NOTES
    CMMC:    MP.L2-3.8.6, SC.L2-3.13.16, SC.L2-3.13.13, SC.L1-B.1.XI, SC.L2-3.13.1,
             SC.L2-3.13.5, SC.L2-3.13.6
    The settings-catalog definition ids and choice values follow the Intune
    Settings catalog naming; confirm them against a live tenant's
    /beta/deviceManagement/configurationPolicies/{id}/settings response.
#>
[CmdletBinding()]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$_scriptDir = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $PSScriptRoot }
. (Join-Path -Path $_scriptDir -ChildPath '..\Common\SecurityConfigHelper.ps1')

$ctx = Initialize-SecurityConfig
$settings = $ctx.Settings

function Get-GraphCollection {
    <#
    .SYNOPSIS
        Returns every item of a Graph collection, following @odata.nextLink.
    #>
    param([Parameter(Mandatory)][string]$Uri)
    $items = [System.Collections.Generic.List[object]]::new()
    $next = $Uri
    while ($next) {
        $page = Invoke-MgGraphRequest -Method GET -Uri $next -ErrorAction Stop
        if ($page -and $page['value']) { foreach ($item in @($page['value'])) { $items.Add($item) } }
        $next = if ($page) { $page['@odata.nextLink'] } else { $null }
    }
    return , $items.ToArray()
}

function Get-PolicySettingsText {
    <#
    .SYNOPSIS
        Returns a configuration policy's settings as one lower-case JSON string, so
        setting definition ids and choice values can be matched regardless of nesting.
    #>
    param([Parameter(Mandatory)][string]$PolicyId)
    $policySettings = Get-GraphCollection -Uri "/beta/deviceManagement/configurationPolicies/$PolicyId/settings"
    if (@($policySettings).Count -eq 0) { return '' }
    return ([string](ConvertTo-Json -InputObject @($policySettings) -Depth 30 -Compress)).ToLowerInvariant()
}

function Test-PolicyAssigned {
    param([Parameter(Mandatory)][string]$PolicyId)
    $assignments = Get-GraphCollection -Uri "/beta/deviceManagement/configurationPolicies/$PolicyId/assignments"
    return @($assignments).Count -gt 0
}

function Add-ReviewOnError {
    param($ErrorRecord, [hashtable]$Base)
    $message = $ErrorRecord.Exception.Message
    $Base.CurrentValue = if ($message -match '403|Forbidden|Authorization') { 'Insufficient permissions or license (Intune required)' } else { "Error: $message" }
    $Base.Status = 'Review'
    $Base.Remediation = 'Requires DeviceManagementConfiguration.Read.All permission and an Intune license.'
    Add-Setting @Base
}

# Settings catalog and Endpoint security policies, read once for all three checks.
$configurationPolicies = $null
$configurationPoliciesError = $null
try {
    $configurationPolicies = Get-GraphCollection -Uri '/beta/deviceManagement/configurationPolicies?$select=id,name,platforms,technologies,templateReference'
}
catch {
    $configurationPoliciesError = $_
}

# ------------------------------------------------------------------
# 1. INTUNE-ENCRYPTION-001: device encryption required
# ------------------------------------------------------------------
$encryptionBase = @{
    Category         = 'Device Encryption'
    Setting          = 'Device Encryption Required (Assigned)'
    RecommendedValue = 'An assigned Windows compliance policy requires BitLocker, or an assigned Endpoint security disk encryption policy'
    CheckId          = 'INTUNE-ENCRYPTION-001'
}
try {
    $compliance = Get-GraphCollection -Uri '/beta/deviceManagement/deviceCompliancePolicies?$expand=assignments'
    $assignedOf = { param($policy) @($policy['assignments']).Count -gt 0 }
    $windowsEncrypting = @($compliance | Where-Object {
        $_['@odata.type'] -match 'windows10CompliancePolicy' -and
        ($_['bitLockerEnabled'] -eq $true -or $_['storageRequireEncryption'] -eq $true) -and (& $assignedOf $_)
    })
    $macEncrypting = @($compliance | Where-Object {
        $_['@odata.type'] -match 'macOSCompliancePolicy' -and $_['storageRequireEncryption'] -eq $true -and (& $assignedOf $_)
    })
    $diskEncryption = @()
    if ($configurationPolicies) {
        foreach ($policy in @($configurationPolicies | Where-Object {
            $_['templateReference'] -and [string]$_['templateReference']['templateFamily'] -eq 'endpointSecurityDiskEncryption'
        })) {
            if (Test-PolicyAssigned -PolicyId $policy['id']) { $diskEncryption += $policy }
        }
    }

    $evidence = @()
    if ($windowsEncrypting.Count -gt 0) { $evidence += "Windows compliance: $(($windowsEncrypting | ForEach-Object { $_['displayName'] }) -join '; ')" }
    if ($diskEncryption.Count -gt 0) { $evidence += "Endpoint security disk encryption: $(($diskEncryption | ForEach-Object { $_['name'] }) -join '; ')" }
    if ($macEncrypting.Count -gt 0) { $evidence += "macOS compliance: $(($macEncrypting | ForEach-Object { $_['displayName'] }) -join '; ')" }

    $encryptionBase.CurrentValue = if ($evidence.Count -gt 0) { $evidence -join ' | ' } else { 'No assigned policy requires device encryption' }
    $encryptionBase.Status = if ($windowsEncrypting.Count -gt 0 -or $diskEncryption.Count -gt 0) { 'Pass' } else { 'Fail' }
    $encryptionBase.Remediation = if ($encryptionBase.Status -eq 'Pass') {
        'No action needed. Confirm BitLocker recovery keys are escrowed to Entra ID.'
    } else {
        'Intune admin center > Endpoint security > Disk encryption > Create policy (Windows, BitLocker): require device encryption and back up recovery keys to Entra ID; or require BitLocker in a Windows compliance policy. Assign it to all Windows devices.'
    }
    Add-Setting @encryptionBase
}
catch {
    Add-ReviewOnError -ErrorRecord $_ -Base $encryptionBase
}

# ------------------------------------------------------------------
# 2. INTUNE-MOBILECODE-001: PowerShell script execution restricted
# ------------------------------------------------------------------
$mobileCodeBase = @{
    Category         = 'Mobile Code'
    Setting          = 'PowerShell Script Execution Restricted (Assigned)'
    RecommendedValue = "An assigned policy turns on script execution limited to AllSigned or RemoteSigned"
    CheckId          = 'INTUNE-MOBILECODE-001'
}
if ($configurationPoliciesError) {
    Add-ReviewOnError -ErrorRecord $configurationPoliciesError -Base $mobileCodeBase
}
else {
    try {
        $restricted = @(); $permissive = @()
        foreach ($policy in @($configurationPolicies | Where-Object { [string]$_['platforms'] -match 'windows' })) {
            $text = Get-PolicySettingsText -PolicyId $policy['id']
            if ($text -notmatch 'scriptexecution|executionpolicy') { continue }
            if (-not (Test-PolicyAssigned -PolicyId $policy['id'])) { continue }
            if ($text -match 'allsigned|remotesigned') { $restricted += $policy['name'] }
            elseif ($text -match 'unrestricted|bypass') { $permissive += $policy['name'] }
        }
        if ($restricted.Count -gt 0) {
            $mobileCodeBase.CurrentValue = "Restricted by: $($restricted -join '; ')"
            $mobileCodeBase.Status = 'Pass'
            $mobileCodeBase.Remediation = 'No action needed.'
        }
        else {
            $mobileCodeBase.CurrentValue = if ($permissive.Count -gt 0) { "Only permissive execution policies assigned: $($permissive -join '; ')" } else { 'No assigned policy sets the PowerShell execution policy' }
            $mobileCodeBase.Status = 'Fail'
            $mobileCodeBase.Remediation = "Intune admin center > Devices > Configuration > Create > Settings catalog (Windows): add 'Turn on Script Execution' (Windows PowerShell), set it to Enabled with 'Allow only signed scripts' or 'Allow local scripts and remote signed scripts', and assign it to all Windows devices."
        }
        Add-Setting @mobileCodeBase
    }
    catch {
        Add-ReviewOnError -ErrorRecord $_ -Base $mobileCodeBase
    }
}

# ------------------------------------------------------------------
# 3. INTUNE-FIREWALL-001: Windows Firewall on, inbound blocked by default
# ------------------------------------------------------------------
$firewallBase = @{
    Category         = 'Host Firewall'
    Setting          = 'Windows Firewall Enabled with Default Inbound Block (Assigned)'
    RecommendedValue = 'An assigned Endpoint security firewall policy enables the firewall and blocks inbound traffic by default on the domain, private, and public profiles'
    CheckId          = 'INTUNE-FIREWALL-001'
}
if ($configurationPoliciesError) {
    Add-ReviewOnError -ErrorRecord $configurationPoliciesError -Base $firewallBase
}
else {
    try {
        $profiles = @('domain', 'private', 'public')
        $covered = @{}
        $policyNames = @()
        foreach ($policy in @($configurationPolicies | Where-Object {
            $_['templateReference'] -and [string]$_['templateReference']['templateFamily'] -eq 'endpointSecurityFirewall'
        })) {
            if (-not (Test-PolicyAssigned -PolicyId $policy['id'])) { continue }
            $text = Get-PolicySettingsText -PolicyId $policy['id']
            $policyNames += $policy['name']
            foreach ($fwProfile in $profiles) {
                $enabled = $text.Contains("mdmstore_$($fwProfile)profile_enablefirewall_true")
                $blocked = $text.Contains("mdmstore_$($fwProfile)profile_defaultinboundaction_1")
                if ($enabled -and $blocked) { $covered[$fwProfile] = $true }
            }
        }
        $missing = @($profiles | Where-Object { -not $covered[$_] })
        if ($policyNames.Count -eq 0) {
            $firewallBase.CurrentValue = 'No assigned Endpoint security firewall policy'
            $firewallBase.Status = 'Fail'
        }
        elseif ($missing.Count -eq 0) {
            $firewallBase.CurrentValue = "All profiles enabled with default inbound block ($($policyNames -join '; '))"
            $firewallBase.Status = 'Pass'
        }
        else {
            $firewallBase.CurrentValue = "Not enforced for the $($missing -join ', ') profile(s) ($($policyNames -join '; '))"
            $firewallBase.Status = 'Warning'
        }
        $firewallBase.Remediation = if ($firewallBase.Status -eq 'Pass') {
            'No action needed. Network-level segmentation (CMMC 3.13.5) also needs boundary devices documented in the SSP.'
        } else {
            'Intune admin center > Endpoint security > Firewall > Create policy (Windows, Windows Firewall): for the Domain, Private, and Public profiles set Enable Firewall = True and Default Inbound Action = Block, then assign it to all Windows devices.'
        }
        Add-Setting @firewallBase
    }
    catch {
        Add-ReviewOnError -ErrorRecord $_ -Base $firewallBase
    }
}

# ------------------------------------------------------------------
# Output results
# ------------------------------------------------------------------
Export-SecurityConfigReport -Settings $settings -OutputPath $OutputPath -ServiceLabel 'Intune Endpoint Hardening'
