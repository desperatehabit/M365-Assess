<#
.SYNOPSIS
    Worker entrypoint for EPIC-020 mailbox/calendar permission add/edit/remove.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    previews or applies one mailbox or calendar permission change via
    Invoke-SetMailboxPermission, and emits the JSON envelope on stdout. Grants
    are security-sensitive: every grant or removal captures before/after and
    emits one audit record. The supervisor connects EXO in this child process
    after materializing the tenant credential (T-0011) before invoking this
    script, so no secret handling lives here. -DryRun plans with no tenant
    write; apply requires -Confirmed.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    'add' grants, 'edit' replaces the current grant, 'remove' withdraws it.
.PARAMETER MailboxId
    Direct mailbox identity for runs without a job envelope.
.PARAMETER Scope
    'mailbox' or 'calendar'.
.PARAMETER PermissionType
    FullAccess, SendAs, or SendOnBehalf for mailbox scope.
.PARAMETER Principal
    Direct grantee identity for runs without a job envelope.
.PARAMETER AccessRights
    Calendar folder rights for calendar scope.
.PARAMETER Automapping
    FullAccess automapping flag.
.PARAMETER Folder
    Calendar folder path suffix for calendar scope.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-mailbox-permission.ps1 -JobFile './run/mailbox-permission-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-mailbox-permission.ps1 -TenantId 'tenant-a' -Action 'add' -MailboxId 'mbx-1' -PermissionType 'FullAccess' -Principal 'delegate' -Confirmed -DryRun
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateSet('add', 'edit', 'remove')]
    [string]$Action,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$MailboxId,

    [Parameter(ParameterSetName = 'ByTenant')]
    [ValidateSet('mailbox', 'calendar')]
    [string]$Scope = 'mailbox',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$PermissionType = 'FullAccess',

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$Principal,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string[]]$AccessRights = @(),

    [Parameter(ParameterSetName = 'ByTenant')]
    [bool]$Automapping = $true,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Folder = 'Calendar',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-MailboxPermission.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SetMailboxPermissionJob -Path $JobFile
        $TenantId       = $job['TenantId']
        $Action         = $job['Action']
        $MailboxId      = $job['MailboxId']
        $Scope          = $job['Scope']
        $PermissionType = $job['PermissionType']
        $Principal      = $job['Principal']
        $AccessRights   = $job['AccessRights']
        $Automapping    = $job['Automapping']
        $Folder         = $job['Folder']
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }

    $invokeParams = @{
        TenantId       = $TenantId
        Action         = $Action
        MailboxId      = $MailboxId
        Scope          = $Scope
        PermissionType = $PermissionType
        Principal      = $Principal
        AccessRights   = $AccessRights
        Automapping    = [bool]$Automapping
        Folder         = $Folder
        DryRun         = [bool]$DryRun
        Confirmed      = [bool]$Confirmed
    }

    $result = Invoke-SetMailboxPermission @invokeParams
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
