<#
.SYNOPSIS
    Worker entrypoint for EPIC-014 group CRUD and conversion.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    executes or previews group CRUD/convert operations via Invoke-SetGroup,
    and emits the JSON envelope on stdout.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id for parameter-based invocation.
.PARAMETER Action
    Group operation: create, edit, delete, or convert.
.PARAMETER GroupId
    Target group id for edit, delete, or convert.
.PARAMETER DisplayName
    Group display name.
.PARAMETER GroupType
    Group type for create or convert.
.PARAMETER TargetType
    Target group type for convert.
.PARAMETER MailNickname
    Mail nickname for mail-enabled groups.
.PARAMETER Description
    Group description (pass empty string to clear on edit).
.PARAMETER DynamicRule
    Dynamic membership rule expression.
.PARAMETER ConfirmName
    Confirmation group name for delete.
.PARAMETER HiddenFromAddressListsEnabled
    Hide created group from Global Address List (GAL).
.PARAMETER RequireSenderAuthenticationEnabled
    Require sender authentication on created group.
.PARAMETER GrantSendOnBehalfTo
    Send-on-behalf delegates for created group.
.PARAMETER DryRun
    Preview plan without mutating tenant state.
.EXAMPLE
    PS> .\portal\workers\set-group.ps1 -JobFile './job.json'
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
    [ValidateSet('create', 'edit', 'delete', 'convert')]
    [string]$Action,

    [Parameter()]
    [string]$GroupId = '',

    [Parameter()]
    [string]$DisplayName = '',

    [Parameter()]
    [ValidateSet('', 'm365', 'security', 'mailEnabledSecurity', 'distribution', 'dynamic')]
    [string]$GroupType = 'security',

    [Parameter()]
    [ValidateSet('', 'm365', 'security', 'mailEnabledSecurity', 'distribution', 'dynamic')]
    [string]$TargetType = '',

    [Parameter()]
    [string]$MailNickname = '',

    [Parameter()]
    [string]$Description = '',

    [Parameter()]
    [string]$DynamicRule = '',

    [Parameter()]
    [string]$ConfirmName = '',

    [Parameter()]
    [bool]$HiddenFromAddressListsEnabled = $false,

    [Parameter()]
    [bool]$RequireSenderAuthenticationEnabled = $false,

    [Parameter()]
    [string[]]$GrantSendOnBehalfTo = @(),

    [Parameter()]
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-Group.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
# When a live create requests GAL or delivery settings, attempt ExchangeOnline as well and
# fall back to Graph-only if ExchangeOnline auth or module is unavailable.
$tenantSession = $null
if ($JobFile) {
    $needsExo = $false
    if (Test-Path -LiteralPath $JobFile -PathType Leaf) {
        try {
            $rawJob = Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json
            $isLiveCreate = ($rawJob.action -eq 'create') -and (-not ($rawJob.dryRun -eq $true))
            $hasGalOrDelivery = ($rawJob.hiddenFromAddressListsEnabled -eq $true) -or
                ($rawJob.requireSenderAuthenticationEnabled -eq $true) -or
                ($rawJob.grantSendOnBehalfTo -and @($rawJob.grantSendOnBehalfTo).Count -gt 0)
            $needsExo = $isLiveCreate -and $hasGalOrDelivery
        }
        catch {
            $needsExo = $false
        }
    }

    if ($needsExo) {
        try {
            $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
        }
        catch {
            Write-Verbose "Exchange Online connection unavailable for Set-Group; falling back to Graph only: $($_.Exception.Message)"
            $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
        }
    }
    else {
        $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
    }
}
try {
    $hasDescription = $PSBoundParameters.ContainsKey('Description')
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SetGroupJob -Path $JobFile
        $TenantId                           = $job['TenantId']
        $Action                             = $job['Action']
        $GroupId                            = $job['GroupId']
        $DisplayName                        = $job['DisplayName']
        $GroupType                          = $job['GroupType']
        $TargetType                         = $job['TargetType']
        $MailNickname                       = $job['MailNickname']
        $Description                        = $job['Description']
        $hasDescription                     = [bool]$job['HasDescription']
        $DynamicRule                        = $job['DynamicRule']
        $ConfirmName                        = $job['ConfirmName']
        $HiddenFromAddressListsEnabled      = [bool]$job['HiddenFromAddressListsEnabled']
        $RequireSenderAuthenticationEnabled = [bool]$job['RequireSenderAuthenticationEnabled']
        $GrantSendOnBehalfTo                = @($job['GrantSendOnBehalfTo'])
        $DryRun                             = [bool]$job['DryRun']
    }

    $invokeParams = @{
        TenantId                           = $TenantId
        Action                             = $Action
        GroupId                            = $GroupId
        DisplayName                        = $DisplayName
        GroupType                          = $GroupType
        TargetType                         = $TargetType
        MailNickname                       = $MailNickname
        DynamicRule                        = $DynamicRule
        ConfirmName                        = $ConfirmName
        HiddenFromAddressListsEnabled      = $HiddenFromAddressListsEnabled
        RequireSenderAuthenticationEnabled = $RequireSenderAuthenticationEnabled
        GrantSendOnBehalfTo                = $GrantSendOnBehalfTo
        DryRun                             = [bool]$DryRun
    }
    if ($hasDescription) {
        $invokeParams['Description'] = $Description
        $invokeParams['HasDescription'] = $true
    }

    $result = Invoke-SetGroup @invokeParams
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
