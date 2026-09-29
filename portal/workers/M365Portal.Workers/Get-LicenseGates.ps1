# Get-LicenseGates.ps1 — EPIC-033 licence gate resolution worker (SPEC §3.5, §6, §9; T-0646).
#
# Reads the module's controls/licensing-overlay.json — the exact service plan ids each
# licence-gated CheckID requires — and resolves every entry against the tenant's active
# service plans, returning a per-feature available/gated map with the required plan so
# UI surfaces can render the shared license-missing state. Read-only: the overlay is
# read from the module path, never duplicated or mutated, and no tenant changes are made.

$script:LicenseGatesWorkerDirectory = $PSScriptRoot

function Get-LicenseGatesRepoRoot {
    # portal/workers/M365Portal.Workers -> repo root (same climb as Connect-WorkerTenant).
    return Split-Path -Path (Split-Path -Path (Split-Path -Path $script:LicenseGatesWorkerDirectory -Parent) -Parent) -Parent
}

function Read-LicenseGatesJob {
    <#
    .SYNOPSIS
        Reads the tenant id from a licence-gates job envelope.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
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
    }
}

function Get-LicenseGates {
    <#
    .SYNOPSIS
        Resolves the module's licensing overlay against the tenant's active service plans.
    .DESCRIPTION
        Reads src/M365-Assess/controls/licensing-overlay.json from the module path and, for
        each licence-gated CheckID, reports whether every required service plan is active
        in the tenant (available) or not (gated), together with the required plan ids.
        A feature whose required plan is absent reports gated, never an error.
    .PARAMETER TenantId
        The tenant the gate map is resolved for.
    .PARAMETER OverlayPath
        Optional override for the licensing-overlay.json path; defaults to the module copy.
    .EXAMPLE
        Get-LicenseGates -TenantId 'tenant-test'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [string]$OverlayPath = ''
    )

    $repoRoot = Get-LicenseGatesRepoRoot
    $overlayFilePath = if ($OverlayPath) {
        $OverlayPath
    }
    else {
        Join-Path -Path $repoRoot -ChildPath 'src/M365-Assess/controls/licensing-overlay.json'
    }
    if (-not (Test-Path -LiteralPath $overlayFilePath -PathType Leaf)) {
        throw "licensing overlay not found at '$overlayFilePath'"
    }

    $overlay = Get-Content -LiteralPath $overlayFilePath -Raw | ConvertFrom-Json
    $checks = $overlay.checks
    if (-not $checks) {
        $checks = [ordered]@{}
    }

    $resolverPath = Join-Path -Path $repoRoot -ChildPath 'src/M365-Assess/Common/Resolve-TenantLicenses.ps1'
    if (-not (Test-Path -LiteralPath $resolverPath -PathType Leaf)) {
        throw "Resolve-TenantLicenses.ps1 not found at '$resolverPath'"
    }
    . $resolverPath
    $tenantLicenses = Resolve-TenantLicenses
    $activePlans = $tenantLicenses.ActiveServicePlans

    $gates = [ordered]@{}
    foreach ($property in $checks.PSObject.Properties) {
        $checkId = $property.Name
        $requiredPlans = @($property.Value | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        $missingPlans = @($requiredPlans | Where-Object { -not $activePlans.Contains($_) })
        $status = if ($missingPlans.Count -eq 0) { 'available' } else { 'gated' }
        $gates[$checkId] = [pscustomobject]@{
            status        = $status
            requiredPlans = $requiredPlans
            missingPlans  = $missingPlans
        }
    }

    return [pscustomobject]@{
        tenantId = $TenantId
        gates    = $gates
    }
}
