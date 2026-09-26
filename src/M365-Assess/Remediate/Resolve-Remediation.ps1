# Registry index is built once per process; registry.json is immutable at
# runtime and re-parsing it for every finding would dominate plan generation.
$script:RemediationRegistryPath = Join-Path -Path $PSScriptRoot -ChildPath '../controls/registry.json'
$script:RemediationRegistryCache = @{}

function Get-RemediationOptionalProperty {
    <#
    .SYNOPSIS
        Reads an optional property without throwing under Set-StrictMode -Version Latest.
    .DESCRIPTION
        Registry entries legitimately omit optional fields (for example
        remediation.notes). Direct property access on a PSCustomObject throws
        PropertyNotFoundException under strict mode, so callers that harden with
        Set-StrictMode need a safe lookup. Supports PSCustomObject and hashtable.
    #>
    [CmdletBinding()]
    param(
        [Parameter()][object]$Object,
        [Parameter(Mandatory)][string]$Name
    )
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

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
            $remediation = Get-RemediationOptionalProperty -Object $entry -Name 'remediation'
            if ($null -ne $remediation) {
                $powershell = Get-RemediationOptionalProperty -Object $remediation -Name 'powershell'
                if ($null -ne $powershell) {
                    $candidate = [string](Get-RemediationOptionalProperty -Object $powershell -Name 'command')
                    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
                        $command = $candidate
                        $mode = 'automated'
                    }
                }

                $portal = Get-RemediationOptionalProperty -Object $remediation -Name 'portal'
                if ($null -ne $portal) {
                    if ($mode -ne 'automated') { $mode = 'manual' }
                    $portalPath = [string](Get-RemediationOptionalProperty -Object $portal -Name 'path')
                    $portalStepsRaw = Get-RemediationOptionalProperty -Object $portal -Name 'steps'
                    $portalSteps = if ($portalStepsRaw) { @($portalStepsRaw) } else { @() }
                }

                $notesValue = Get-RemediationOptionalProperty -Object $remediation -Name 'notes'
                if (-not [string]::IsNullOrWhiteSpace($notesValue)) {
                    $notes = [string]$notesValue
                }
            }

            $licensing = Get-RemediationOptionalProperty -Object $entry -Name 'licensing'
            if ($null -ne $licensing) {
                $minimum = Get-RemediationOptionalProperty -Object $licensing -Name 'minimum'
                if (-not [string]::IsNullOrWhiteSpace($minimum)) {
                    $licenseMinimum = [string]$minimum
                }
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
