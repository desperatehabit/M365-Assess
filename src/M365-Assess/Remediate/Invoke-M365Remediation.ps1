<#
.SYNOPSIS
    Plans and applies remediation for failed M365-Assess findings.
.DESCRIPTION
    Entry point for the EPIC-006 remediation engine. -Plan is the read-only path
    that turns failed findings into a RemediationPlan; -Apply is the gated write
    path. Both are scaffold stubs in T-0101 and raise NotImplementedException
    until the plan and apply tickets land.

    Remediation is the module's tenant-write surface and lives in Remediate/,
    deliberately outside the read-only collector scan
    (scripts/Test-CollectorReadOnly.ps1) -- see
    docs/portal-specs/00-guides/06-remediation.md section 2.1.
.PARAMETER Plan
    Generate a remediation plan. Read-only; performs no tenant writes.
.PARAMETER Apply
    Apply approved remediation actions. Gated; not implemented yet.
.EXAMPLE
    PS> Invoke-M365Remediation -Plan
    Scaffold stub -- raises NotImplementedException.
#>
function Invoke-M365Remediation {
    [CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'Plan')]
    [OutputType([void])]
    param(
        [Parameter(ParameterSetName = 'Plan')]
        [switch]$Plan,

        [Parameter(ParameterSetName = 'Apply')]
        [switch]$Apply
    )

    if ($PSCmdlet.ParameterSetName -eq 'Apply') {
        if (-not $PSCmdlet.ShouldProcess('remediation plan', 'Apply remediation actions')) {
            return
        }
        throw [System.NotImplementedException]::new(
            'Invoke-M365Remediation -Apply is not implemented yet (EPIC-006).')
    }

    throw [System.NotImplementedException]::new(
        'Invoke-M365Remediation -Plan is not implemented yet (EPIC-006).')
}
