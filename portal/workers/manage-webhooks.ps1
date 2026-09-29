<#
.SYNOPSIS
    Worker entrypoint for EPIC-032 Graph webhook subscription lifecycle management.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    manages the tenant's Graph change-notification subscriptions (list, create,
    renew, recreate, delete, test), and emits JSON on stdout.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Tenant whose subscriptions are managed (direct-parameter runs only).
.PARAMETER Action
    One of: list, create, renew, recreate, delete, test.
.PARAMETER SubscriptionId
    Graph subscription id; required for renew, recreate, delete, and test.
.PARAMETER Resource
    Required resource path segment: users, groups, or policies (create only).
.PARAMETER NotificationUrl
    Public URL of the portal's notification receiver (create only).
.PARAMETER ClientState
    Opaque secret the receiver validates; generated on create when absent.
.PARAMETER ExpirationMinutes
    Subscription lifetime in minutes; defaults to 4200 (70h).
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(ParameterSetName = 'ByParams')]
    [ValidateSet('list', 'create', 'renew', 'recreate', 'delete', 'test')]
    [string]$Action = 'list',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$SubscriptionId = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$Resource = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$NotificationUrl = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$ClientState = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [int]$ExpirationMinutes = 4200
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Manage-WebhookSubscription.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-ManageWebhooksJob -Path $JobFile
        $TenantId = $job['TenantId']
        $Action = $job['Action']
        $SubscriptionId = $job['SubscriptionId']
        $Resource = $job['Resource']
        $NotificationUrl = $job['NotificationUrl']
        $ClientState = $job['ClientState']
        $ExpirationMinutes = if ($job['ExpirationMinutes'] -gt 0) { $job['ExpirationMinutes'] } else { $ExpirationMinutes }
    }

    $result = Invoke-ManageWebhookSubscription -TenantId $TenantId -Action $Action -SubscriptionId $SubscriptionId -Resource $Resource -NotificationUrl $NotificationUrl -ClientState $ClientState -ExpirationMinutes $ExpirationMinutes
    $result | ConvertTo-Json -Depth 10 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
