$script:RemediationAllowlistDefaultPath = Join-Path -Path $PSScriptRoot -ChildPath '../controls/remediation-allowlist.json'

function Get-RemediationAllowlist {
    <#
    .SYNOPSIS
        Loads the admin-managed remediation allowlist (read-only).
    .DESCRIPTION
        Config-managed, admin-only, audited allowlist governance per EPIC-006
        SPEC.md section 11 item 3: this function only reads the allowlist file
        and never writes it. Every call returns an access/audit record that
        includes the allowlist membership result for the requested check, so
        gate decisions in Test-RemediationGate can persist it to the audit log.
    .PARAMETER CheckId
        The finding CheckId to test for membership. Sub-numbered ids
        (e.g. CA-REPORTONLY-001.1) are stripped to the registry key
        (CA-REPORTONLY-001) before comparison, matching Resolve-Remediation.
    .PARAMETER AllowlistPath
        Path to the admin-managed allowlist file. Defaults to
        controls/remediation-allowlist.json. A missing file yields an empty
        allowlist rather than throwing so plan generation can mark every
        automated action not-allowlisted.
    .PARAMETER Actor
        Optional caller identity recorded on the audit record.
    .OUTPUTS
        [PSCustomObject] with CheckIds, AllowlistPath, Exists, AccessedAt,
        IsAllowlisted (when CheckId given), and AuditRecord.
    .EXAMPLE
        Get-RemediationAllowlist -CheckId 'COMPLIANCE-AUDIT-001.1'
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [string]$CheckId,

        [Parameter()]
        [string]$AllowlistPath,

        [Parameter()]
        [string]$Actor
    )

    process {
        if (-not $AllowlistPath) { $AllowlistPath = $script:RemediationAllowlistDefaultPath }

        $checkIds = @()
        $exists = Test-Path -Path $AllowlistPath -PathType Leaf
        if ($exists) {
            try {
                $raw = Get-Content -Path $AllowlistPath -Raw | ConvertFrom-Json
                if ($raw -is [array]) {
                    $checkIds = @($raw | ForEach-Object { [string]$_ })
                }
                elseif ($null -ne $raw.checkIds) {
                    $checkIds = @($raw.checkIds | ForEach-Object { [string]$_ })
                }
                elseif ($null -ne $raw.allowlist) {
                    $checkIds = @($raw.allowlist | ForEach-Object { [string]$_ })
                }
                elseif ($null -ne $raw.checks) {
                    if ($raw.checks -is [array]) {
                        $checkIds = @($raw.checks | ForEach-Object { [string]$_ })
                    }
                    else {
                        $checkIds = @($raw.checks.PSObject.Properties.Name)
                    }
                }
            }
            catch {
                Write-Warning "Could not parse remediation allowlist: $AllowlistPath. Treating as empty. $($_.Exception.Message)"
                $checkIds = @()
            }
        }

        $registryKey = $null
        $isAllowlisted = $null
        if (-not [string]::IsNullOrWhiteSpace($CheckId)) {
            $registryKey = $CheckId -replace '\.\d+$', ''
            $isAllowlisted = $checkIds -contains $registryKey
        }

        $accessedAt = (Get-Date).ToUniversalTime().ToString('o')
        $auditRecord = [PSCustomObject]@{
            AccessedAt    = $accessedAt
            Actor         = $Actor
            AllowlistPath = $AllowlistPath
            AllowlistHit  = $isAllowlisted
            CheckId       = $CheckId
            RegistryKey   = $registryKey
            Exists        = $exists
            Count         = $checkIds.Count
        }

        $result = [PSCustomObject]@{
            CheckIds      = $checkIds
            Count         = $checkIds.Count
            AllowlistPath = $AllowlistPath
            Exists        = $exists
            AccessedAt    = $accessedAt
            AuditRecord   = $auditRecord
        }
        if ($null -ne $isAllowlisted) {
            $result | Add-Member -NotePropertyName 'CheckId' -NotePropertyValue $CheckId
            $result | Add-Member -NotePropertyName 'RegistryKey' -NotePropertyValue $registryKey
            $result | Add-Member -NotePropertyName 'IsAllowlisted' -NotePropertyValue ([bool]$isAllowlisted)
        }
        $result
    }
}
