# Invoke-TenantOnboarding.ps1 — EPIC-002 direct onboarding worker wrapping Grant-M365AssessConsent (SPEC §4.1, §8, §10).
#
# Wraps the existing Grant-M365AssessConsent setup cmdlet rather than reimplementing it.
# This is a tenant-mutating setup write (ConfirmImpact: High): explicit confirmation is
# mandatory. An unconfirmed call is refused and never passed -Force.
# Captures before/after provisioning status and reports full or half-provisioned failure details.

[CmdletBinding()]
param(
    [Parameter()]
    [string]$TenantId,

    [Parameter()]
    [string]$AdminUpn,

    [Parameter()]
    [string]$AppDisplayName = 'M365-Assess-Reader',

    [Parameter()]
    [string]$ClientId,

    [Parameter()]
    [string]$CertificateThumbprint,

    [Parameter()]
    [switch]$CreateNew,

    [Parameter()]
    [bool]$Confirmed = $false,

    [Parameter()]
    [string]$CmdletScript = '',

    [Parameter()]
    [scriptblock]$CmdletHandler
)

$script:WorkerDirectory = $PSScriptRoot
if (-not $script:WorkerDirectory) {
    $script:WorkerDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
}

function Invoke-TenantOnboarding {
    <#
    .SYNOPSIS
        Wraps Grant-M365AssessConsent to provision the M365-Assess app registration and permissions.
    .DESCRIPTION
        Refuses execution unless Confirmed is $true. Invokes Grant-M365AssessConsent with -Force
        only after confirmation is verified. Returns a structured onboarding envelope detailing
        the provisioned client ID, certificate thumbprint, and per-step permission status.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$AdminUpn,

        [Parameter()]
        [string]$AppDisplayName = 'M365-Assess-Reader',

        [Parameter()]
        [string]$ClientId,

        [Parameter()]
        [string]$CertificateThumbprint,

        [Parameter()]
        [switch]$CreateNew,

        [Parameter(Mandatory)]
        [bool]$Confirmed,

        [Parameter()]
        [string]$CmdletScript = '',

        [Parameter()]
        [scriptblock]$CmdletHandler
    )

    if (-not $Confirmed) {
        throw "Tenant onboarding requires explicit confirmation. An unconfirmed execution is refused and -Force is never passed (code: onboard.confirmation_required)."
    }

    if (-not $CmdletScript -and -not $CmdletHandler) {
        $repoRoot = Split-Path -Path (Split-Path -Path (Split-Path -Path $script:WorkerDirectory -Parent) -Parent) -Parent
        $candidate = Join-Path -Path $repoRoot -ChildPath 'src/M365-Assess/Setup/Grant-M365AssessConsent.ps1'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $CmdletScript = $candidate
        }
    }

    $splat = @{
        TenantId = $TenantId
        Force    = $true
    }
    if ($AdminUpn) { $splat['AdminUpn'] = $AdminUpn }
    if ($AppDisplayName) { $splat['AppDisplayName'] = $AppDisplayName }
    if ($ClientId) { $splat['ClientId'] = $ClientId }
    if ($CertificateThumbprint) { $splat['CertificateThumbprint'] = $CertificateThumbprint }
    if ($CreateNew) { $splat['CreateNew'] = $true }

    try {
        $rawResult = $null
        if ($CmdletHandler) {
            $rawResult = & $CmdletHandler @splat
        }
        elseif ($CmdletScript -and (Test-Path -LiteralPath $CmdletScript -PathType Leaf)) {
            . $CmdletScript
            $rawResult = Grant-M365AssessConsent @splat
        }
        else {
            throw "Grant-M365AssessConsent cmdlet script not found at: $CmdletScript"
        }

        $totalFailed = 0
        if ($null -ne $rawResult.TotalFailed) {
            $totalFailed = [int]$rawResult.TotalFailed
        }

        $status = if ($totalFailed -gt 0) { 'partial' } else { 'succeeded' }
        $errorMessage = if ($totalFailed -gt 0) {
            "Tenant onboarding completed with $totalFailed failed permission assignments (code: onboard.partial_failure)."
        } else {
            $null
        }

        return [pscustomobject]@{
            tenantId              = $TenantId
            status                = $status
            clientId              = [string]$rawResult.ClientId
            certificateThumbprint = [string]$rawResult.CertificateThumbprint
            appDisplayName        = [string]$rawResult.AppDisplayName
            bootstrapCreated      = [bool]$rawResult.BootstrapCreated
            graphPermissions      = $rawResult.GraphPermissions
            complianceRoles       = $rawResult.ComplianceRoles
            exoRoleGroups         = $rawResult.ExoRoleGroups
            totalFailed           = $totalFailed
            error                 = $errorMessage
            completedAt           = (Get-Date).ToUniversalTime().ToString('o')
        }
    }
    catch {
        $err = $_.Exception.Message
        return [pscustomobject]@{
            tenantId              = $TenantId
            status                = 'failed'
            clientId              = [string]$splat['ClientId']
            certificateThumbprint = [string]$splat['CertificateThumbprint']
            appDisplayName        = [string]$splat['AppDisplayName']
            bootstrapCreated      = $false
            graphPermissions      = @()
            complianceRoles       = @()
            exoRoleGroups         = @()
            totalFailed           = 1
            error                 = "Tenant onboarding failed: $err (code: onboard.failed)"
            completedAt           = (Get-Date).ToUniversalTime().ToString('o')
        }
    }
}

if ($TenantId -and $Confirmed) {
    $result = Invoke-TenantOnboarding -TenantId $TenantId `
                                     -AdminUpn $AdminUpn `
                                     -AppDisplayName $AppDisplayName `
                                     -ClientId $ClientId `
                                     -CertificateThumbprint $CertificateThumbprint `
                                     -CreateNew:$CreateNew `
                                     -Confirmed:$Confirmed `
                                     -CmdletScript $CmdletScript `
                                     -CmdletHandler $CmdletHandler
    return $result
}
