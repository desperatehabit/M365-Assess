# Registry index is built once per process; registry.json is immutable at
# runtime and re-parsing it for every finding would dominate plan generation.
$script:RemediationRegistryPath = Join-Path -Path $PSScriptRoot -ChildPath '../controls/registry.json'
$script:RemediationRegistryCache = @{}

function Resolve-Remediation {
    <#
    .SYNOPSIS
        Classifies how a finding can be remediated from the control registry.
    .DESCRIPTION
        Looks up the registry entry for a finding CheckId and returns its
        remediation mode per EPIC-006 SPEC.md section 4.1 step 4:

          - remediation.powershell.command present -> 'automated'
          - else remediation.portal present          -> 'manual'
          - else                                      -> 'undetermined'

        The stored finding CheckId is sub-numbered by SecurityConfigHelper
        (e.g. CA-REPORTONLY-001.1). The resolver strips the trailing \.\d+
        suffix to key the registry (CA-REPORTONLY-001). Unknown or unmatched
        ids resolve to 'undetermined' rather than throwing so plan generation
        can flag them for triage.
    .PARAMETER CheckId
        The finding CheckId, with or without a sub-number suffix.
    .PARAMETER RegistryPath
        Path to controls/registry.json. Defaults to the module registry.
    .OUTPUTS
        [PSCustomObject] with Mode, RegistryKey, CheckId, Command, PortalPath,
        PortalSteps, LicenseMinimum, and Notes.
    .EXAMPLE
        Resolve-Remediation -CheckId 'CA-REPORTONLY-001.1'
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [ValidateNotNullOrEmpty()]
        [string]$CheckId,

        [Parameter()]
        [string]$RegistryPath
    )

    process {
        $registryKey = $CheckId -replace '\.\d+$', ''

        if (-not $RegistryPath) { $RegistryPath = $script:RemediationRegistryPath }
        $RegistryPath = [System.IO.Path]::GetFullPath($RegistryPath)

        if (-not $script:RemediationRegistryCache.ContainsKey($RegistryPath)) {
            $index = @{}
            if (Test-Path -Path $RegistryPath -PathType Leaf) {
                $raw = Get-Content -Path $RegistryPath -Raw | ConvertFrom-Json
                foreach ($check in @($raw.checks)) {
                    if ($check.checkId) { $index[$check.checkId] = $check }
                }
            }
            $script:RemediationRegistryCache[$RegistryPath] = $index
        }

        $registry = $script:RemediationRegistryCache[$RegistryPath]
        $entry = if ($registry.ContainsKey($registryKey)) { $registry[$registryKey] } else { $null }

        $mode = 'undetermined'
        $command = $null
        $portalPath = $null
        $portalSteps = @()
        $licenseMinimum = $null
        $notes = $null

        if ($null -ne $entry) {
            $remediation = $entry.remediation
            if ($null -ne $remediation) {
                $candidate = [string]$remediation.powershell.command
                if (-not [string]::IsNullOrWhiteSpace($candidate)) {
                    $command = $candidate
                    $mode = 'automated'
                }
                elseif ($null -ne $remediation.portal) {
                    $mode = 'manual'
                }

                if ($null -ne $remediation.portal) {
                    $portalPath = [string]$remediation.portal.path
                    $portalSteps = if ($remediation.portal.steps) { @($remediation.portal.steps) } else { @() }
                }

                if (-not [string]::IsNullOrWhiteSpace($remediation.notes)) {
                    $notes = [string]$remediation.notes
                }
            }

            if ($entry.licensing -and -not [string]::IsNullOrWhiteSpace($entry.licensing.minimum)) {
                $licenseMinimum = [string]$entry.licensing.minimum
            }
        }

        [PSCustomObject]@{
            CheckId        = $CheckId
            RegistryKey    = $registryKey
            Mode           = $mode
            Command        = $command
            PortalPath     = $portalPath
            PortalSteps    = $portalSteps
            LicenseMinimum = $licenseMinimum
            Notes          = $notes
        }
    }
}
