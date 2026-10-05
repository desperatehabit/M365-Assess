<#
.SYNOPSIS
    Worker entrypoint for EPIC-020 inbox-rule add/edit/remove.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    executes or previews inbox-rule create/edit/delete via Invoke-SetMailboxRule,
    and emits the JSON envelope on stdout. An edit that changes nothing returns
    a structured no-op with no EXO write. The supervisor connects EXO in this
    child process after materializing the tenant credential (T-0011) before
    invoking this script, so no secret handling lives here. -DryRun plans with
    no tenant write; apply requires -Confirmed.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    'create' adds a rule; 'edit' changes one; 'delete' removes one.
.PARAMETER MailboxId
    Direct mailbox identity for runs without a job envelope.
.PARAMETER RuleId
    Direct rule identity for edit/delete runs without a job envelope.
.PARAMETER Name
    Rule name for create, or the new name for edit.
.PARAMETER Enabled
    'true' or 'false' to set the rule state; empty leaves it unchanged.
.PARAMETER Priority
    Rule priority for create/edit; -1 leaves it unchanged.
.PARAMETER ForwardTo
    Forwarding targets for create/edit: one or more addresses (an array, or a ';' / ',' delimited string).
.PARAMETER ForwardAsAttachmentTo
    Forward-as-attachment targets for create/edit (same forms as -ForwardTo).
.PARAMETER RedirectTo
    Redirect targets for create/edit (same forms as -ForwardTo).
.PARAMETER DeleteMessage
    'true' or 'false' to set message deletion; empty leaves it unchanged.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-mailbox-rule.ps1 -JobFile './run/mailbox-rule-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-mailbox-rule.ps1 -TenantId 'tenant-a' -Action 'delete' -MailboxId 'mbx-1' -RuleId 'rule-1' -Confirmed -DryRun
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
    [ValidateSet('create', 'edit', 'delete')]
    [string]$Action,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$MailboxId,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$RuleId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Name = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [ValidateSet('', 'true', 'false')]
    [string]$Enabled = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [int]$Priority = -1,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string[]]$ForwardTo = @(),

    [Parameter(ParameterSetName = 'ByTenant')]
    [string[]]$ForwardAsAttachmentTo = @(),

    [Parameter(ParameterSetName = 'ByTenant')]
    [string[]]$RedirectTo = @(),

    [Parameter(ParameterSetName = 'ByTenant')]
    [ValidateSet('', 'true', 'false')]
    [string]$DeleteMessage = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-MailboxRule.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    $jobEnabled = $null
    $jobPriority = $null
    $jobDeleteMessage = $null
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SetMailboxRuleJob -Path $JobFile
        $TenantId             = $job['TenantId']
        $Action               = $job['Action']
        $MailboxId            = $job['MailboxId']
        $RuleId               = $job['RuleId']
        $Name                 = $job['Name']
        $ForwardTo            = $job['ForwardTo']
        $ForwardAsAttachmentTo = $job['ForwardAsAttachmentTo']
        $RedirectTo           = $job['RedirectTo']
        $jobEnabled = $job['Enabled']
        $jobPriority = $job['Priority']
        $jobDeleteMessage = $job['DeleteMessage']
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }

    $invokeParams = @{
        TenantId              = $TenantId
        Action                = $Action
        MailboxId             = $MailboxId
        RuleId                = $RuleId
        Name                  = $Name
        ForwardTo             = $ForwardTo
        ForwardAsAttachmentTo = $ForwardAsAttachmentTo
        RedirectTo            = $RedirectTo
        DryRun                = [bool]$DryRun
        Confirmed             = [bool]$Confirmed
    }
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        if ($null -ne $jobEnabled) {
            $invokeParams['Enabled'] = [bool]$jobEnabled
        }
        if ($null -ne $jobPriority) {
            $invokeParams['Priority'] = [int]$jobPriority
        }
        if ($null -ne $jobDeleteMessage) {
            $invokeParams['DeleteMessage'] = [bool]$jobDeleteMessage
        }
    }
    else {
        if ($Enabled -ne '') {
            $invokeParams['Enabled'] = ($Enabled -eq 'true')
        }
        if ($Priority -ge 0) {
            $invokeParams['Priority'] = $Priority
        }
        if ($DeleteMessage -ne '') {
            $invokeParams['DeleteMessage'] = ($DeleteMessage -eq 'true')
        }
    }

    $result = Invoke-SetMailboxRule @invokeParams
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
