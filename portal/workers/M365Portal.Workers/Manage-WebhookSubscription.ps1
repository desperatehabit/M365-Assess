# Manage-WebhookSubscription.ps1 — EPIC-032 Graph webhook subscription lifecycle worker
# (SPEC §3.5, §4.3, §5, §6, §7, §8; T-0625).
#
# Manages the Graph change-notification subscriptions that feed portal alerts and
# caches: list, create, renew, recreate, delete, and test per tenant. Subscription
# management writes to Graph (SPEC §8) and needs Subscription.ReadWrite.All app-only;
# the tenant session comes from Connect-WorkerTenant in the entrypoint. Every mutation
# returns an auditEvent; a failed renewal raises an alert through the RaiseAlert seam
# (EPIC-029) and returns the alertEvent so the caller can record it. Content-bundle
# processing is deferred (SPEC §11.2): this worker never handles notification content.

function Read-ManageWebhooksJob {
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

    $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $tenantId = [string]$json.tenantId
    if (-not $tenantId) {
        throw "job envelope '$Path' is missing mandatory 'tenantId'"
    }

    $action = [string]$json.action
    if (-not $action) {
        throw "job envelope '$Path' is missing mandatory 'action'"
    }

    return @{
        TenantId         = $tenantId
        Action          = $action
        SubscriptionId  = [string]$json.subscriptionId
        Resource        = [string]$json.resource
        NotificationUrl = [string]$json.notificationUrl
        ClientState     = [string]$json.clientState
        ExpirationMinutes = if ($null -ne $json.expirationMinutes -and "$($json.expirationMinutes)" -ne '') { [int]$json.expirationMinutes } else { 0 }
    }
}

function Get-WebhookSubscriptionState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ExpirationDateTime,

        [Parameter(Mandatory)]
        [datetime]$Now,

        [int]$ExpiringWithinMinutes = 1440
    )

    $expires = [DateTimeOffset]::Parse($ExpirationDateTime)
    if ($expires.UtcDateTime -le $Now) {
        return 'expired'
    }
    if ($expires.UtcDateTime -le $Now.AddMinutes($ExpiringWithinMinutes)) {
        return 'expiring'
    }
    return 'active'
}

function New-WebhookAuditEvent {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('create', 'renew', 'recreate', 'delete')]
        [string]$Action,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SubscriptionId,

        [string]$Resource = '',

        [string]$Note = '',

        [hashtable]$Before = @{},

        [hashtable]$After = @{}
    )

    return @{
        id         = [guid]::NewGuid().ToString()
        tenantId   = $TenantId
        action     = "webhook.subscription.$Action"
        targetId   = $SubscriptionId
        targetName = $Resource
        timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        before     = $Before
        after      = $After
        note       = $Note
    }
}

function Invoke-ManageWebhookSubscription {
    <#
    .SYNOPSIS
        Manages one tenant's Graph webhook subscriptions: list, create, renew,
        recreate, delete, or test.
    .DESCRIPTION
        List reads /v1.0/subscriptions and computes each subscription's state
        (active/expiring/expired). Create posts a new subscription for a required
        resource (users, groups, policies) with a generated clientState the
        notification receiver validates. Renew patches expirationDateTime before
        expiry; a failed renewal raises an alert (EPIC-029) and returns the
        alertEvent instead of throwing. Recreate deletes the existing subscription
        and posts a fresh one with the same resource, notificationUrl, and
        clientState. Delete removes the subscription. Test reads one subscription
        and reports whether it is healthy. Every mutation returns an auditEvent.
    .PARAMETER TenantId
        Tenant the subscriptions belong to. Carried through to results and audit.
    .PARAMETER Action
        One of: list, create, renew, recreate, delete, test.
    .PARAMETER SubscriptionId
        Graph subscription id; required for renew, recreate, delete, and test.
    .PARAMETER Resource
        Required resource path segment: users, groups, or policies (SPEC §4.3).
    .PARAMETER NotificationUrl
        Public URL of the portal's notification receiver; required for create.
    .PARAMETER ClientState
        Opaque secret the receiver validates; generated on create when absent.
    .PARAMETER ExpirationMinutes
        Subscription lifetime in minutes; defaults to 4200 (70h), inside Graph's
        three-day maximum.
    .PARAMETER RaiseAlert
        Seam: scriptblock (alertEvent) -> void. Invoked on renewal failure.
    .EXAMPLE
        Invoke-ManageWebhookSubscription -TenantId 'tenant-a' -Action 'create' -Resource 'users' -NotificationUrl 'https://portal.example/v1/webhooks/notify'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('list', 'create', 'renew', 'recreate', 'delete', 'test')]
        [string]$Action,

        [string]$SubscriptionId = '',

        [string]$Resource = '',

        [string]$NotificationUrl = '',

        [string]$ClientState = '',

        [int]$ExpirationMinutes = 4200,

        [scriptblock]$RaiseAlert
    )

    if (-not $RaiseAlert) {
        $RaiseAlert = { param($alertEvent) $null = $alertEvent }
    }

    $now = (Get-Date).ToUniversalTime()
    $timestamp = $now.ToString('yyyy-MM-ddTHH:mm:ssZ')

    switch ($Action) {
        'list' {
            $response = Invoke-MgGraphRequest -Method GET -Uri '/v1.0/subscriptions' -ErrorAction Stop
            $items = @()
            if ($response -and $response['value']) {
                $items = @($response['value'])
            }
            elseif ($response -and $response.value) {
                $items = @($response.value)
            }
            $subscriptions = @()
            foreach ($s in $items) {
                $id = if ($s['id']) { [string]$s['id'] } else { [string]$s.id }
                $resource = if ($s['resource']) { [string]$s['resource'] } else { [string]$s.resource }
                $expiration = if ($s['expirationDateTime']) { [string]$s['expirationDateTime'] } else { [string]$s.expirationDateTime }
                $notificationUrl = if ($s['notificationUrl']) { [string]$s['notificationUrl'] } else { [string]$s.notificationUrl }
                $subscriptions += [pscustomobject]@{
                    id                 = $id
                    tenantId           = $TenantId
                    resource           = $resource
                    notificationUrl    = $notificationUrl
                    expirationDateTime = $expiration
                    state              = Get-WebhookSubscriptionState -ExpirationDateTime $expiration -Now $now
                }
            }
            return [pscustomobject]@{
                success        = $true
                tenantId      = $TenantId
                subscriptions = $subscriptions
            }
        }

        'create' {
            if (-not $Resource) {
                throw "ValidationFailed: -Resource is required for action 'create'"
            }
            if ($Resource -notin @('users', 'groups', 'policies')) {
                throw "ValidationFailed: -Resource must be one of: users, groups, policies"
            }
            if (-not $NotificationUrl) {
                throw "ValidationFailed: -NotificationUrl is required for action 'create'"
            }
            if (-not $ClientState) {
                $ClientState = [guid]::NewGuid().ToString()
            }
            $expiration = $now.AddMinutes($ExpirationMinutes).ToString('yyyy-MM-ddTHH:mm:ss.0000000Z')
            $body = @{
                changeType          = 'created,updated,deleted'
                notificationUrl     = $NotificationUrl
                resource            = $Resource
                expirationDateTime  = $expiration
                clientState         = $ClientState
            }
            $created = Invoke-MgGraphRequest -Method POST -Uri '/v1.0/subscriptions' -Body $body -ErrorAction Stop
            $newId = if ($created['id']) { [string]$created['id'] } else { [string]$created.id }
            $newExpiration = if ($created['expirationDateTime']) { [string]$created['expirationDateTime'] } else { $expiration }
            $subscription = [pscustomobject]@{
                id                 = $newId
                tenantId           = $TenantId
                resource           = $Resource
                notificationUrl    = $NotificationUrl
                clientState        = $ClientState
                expirationDateTime = $newExpiration
                state              = 'active'
            }
            return [pscustomobject]@{
                success      = $true
                subscription = $subscription
                auditEvent   = New-WebhookAuditEvent -Action 'create' -TenantId $TenantId -SubscriptionId $newId -Resource $Resource -After @{ resource = $Resource; expirationDateTime = $newExpiration }
            }
        }

        'renew' {
            if (-not $SubscriptionId) {
                throw "ValidationFailed: -SubscriptionId is required for action 'renew'"
            }
            try {
                $expiration = $now.AddMinutes($ExpirationMinutes).ToString('yyyy-MM-ddTHH:mm:ss.0000000Z')
                $body = @{ expirationDateTime = $expiration }
                $updated = Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/subscriptions/$SubscriptionId" -Body $body -ErrorAction Stop
                $newExpiration = if ($updated['expirationDateTime']) { [string]$updated['expirationDateTime'] } else { $expiration }
                $resource = if ($updated['resource']) { [string]$updated['resource'] } else { '' }
                $subscription = [pscustomobject]@{
                    id                 = $SubscriptionId
                    tenantId           = $TenantId
                    resource           = $resource
                    expirationDateTime = $newExpiration
                    state              = 'active'
                }
                return [pscustomobject]@{
                    success      = $true
                    subscription = $subscription
                    auditEvent   = New-WebhookAuditEvent -Action 'renew' -TenantId $TenantId -SubscriptionId $SubscriptionId -Resource $resource -After @{ expirationDateTime = $newExpiration }
                }
            }
            catch {
                $reason = $_.Exception.Message
                $alertEvent = @{
                    kind           = 'webhook.renewal_failed'
                    severity       = 'High'
                    tenantId       = $TenantId
                    subscriptionId = $SubscriptionId
                    resource       = $Resource
                    reason         = $reason
                    timestamp      = $timestamp
                }
                & $RaiseAlert $alertEvent
                return [pscustomobject]@{
                    success          = $false
                    error            = $reason
                    alertEvent       = $alertEvent
                    alerted          = $true
                    auditEvent       = New-WebhookAuditEvent -Action 'renew' -TenantId $TenantId -SubscriptionId $SubscriptionId -Resource $Resource -Note "renew failed: $reason"
                }
            }
        }

        'recreate' {
            if (-not $SubscriptionId) {
                throw "ValidationFailed: -SubscriptionId is required for action 'recreate'"
            }
            $existing = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/subscriptions/$SubscriptionId" -ErrorAction Stop
            $resource = if ($existing['resource']) { [string]$existing['resource'] } else { [string]$existing.resource }
            $notificationUrl = if ($existing['notificationUrl']) { [string]$existing['notificationUrl'] } else { [string]$existing.notificationUrl }
            $clientState = if ($existing['clientState']) { [string]$existing['clientState'] } else { [string]$existing.clientState }
            if (-not $resource) {
                throw "ValidationFailed: existing subscription '$SubscriptionId' has no resource to recreate"
            }
            if (-not $notificationUrl) {
                throw "ValidationFailed: existing subscription '$SubscriptionId' has no notificationUrl to recreate"
            }
            if (-not $clientState) {
                $clientState = [guid]::NewGuid().ToString()
            }
            $null = Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/subscriptions/$SubscriptionId" -ErrorAction Stop
            $expiration = $now.AddMinutes($ExpirationMinutes).ToString('yyyy-MM-ddTHH:mm:ss.0000000Z')
            $body = @{
                changeType         = 'created,updated,deleted'
                notificationUrl    = $notificationUrl
                resource           = $resource
                expirationDateTime = $expiration
                clientState        = $clientState
            }
            $created = Invoke-MgGraphRequest -Method POST -Uri '/v1.0/subscriptions' -Body $body -ErrorAction Stop
            $newId = if ($created['id']) { [string]$created['id'] } else { [string]$created.id }
            $newExpiration = if ($created['expirationDateTime']) { [string]$created['expirationDateTime'] } else { $expiration }
            $subscription = [pscustomobject]@{
                id                 = $newId
                tenantId           = $TenantId
                resource           = $resource
                notificationUrl    = $notificationUrl
                clientState        = $clientState
                expirationDateTime = $newExpiration
                state              = 'active'
            }
            return [pscustomobject]@{
                success      = $true
                subscription = $subscription
                auditEvent   = New-WebhookAuditEvent -Action 'recreate' -TenantId $TenantId -SubscriptionId $newId -Resource $Resource -Before @{ previousSubscriptionId = $SubscriptionId } -After @{ resource = $resource; expirationDateTime = $newExpiration }
            }
        }

        'delete' {
            if (-not $SubscriptionId) {
                throw "ValidationFailed: -SubscriptionId is required for action 'delete'"
            }
            $existing = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/subscriptions/$SubscriptionId" -ErrorAction Stop
            $resource = if ($existing['resource']) { [string]$existing['resource'] } else { [string]$existing.resource }
            $null = Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/subscriptions/$SubscriptionId" -ErrorAction Stop
            return [pscustomobject]@{
                success      = $true
                deleted      = $SubscriptionId
                auditEvent   = New-WebhookAuditEvent -Action 'delete' -TenantId $TenantId -SubscriptionId $SubscriptionId -Resource $resource
            }
        }

        'test' {
            if (-not $SubscriptionId) {
                throw "ValidationFailed: -SubscriptionId is required for action 'test'"
            }
            $existing = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/subscriptions/$SubscriptionId" -ErrorAction Stop
            $resource = if ($existing['resource']) { [string]$existing['resource'] } else { [string]$existing.resource }
            $expiration = if ($existing['expirationDateTime']) { [string]$existing['expirationDateTime'] } else { [string]$existing.expirationDateTime }
            $state = Get-WebhookSubscriptionState -ExpirationDateTime $expiration -Now $now
            return [pscustomobject]@{
                success      = $true
                subscription = [pscustomobject]@{
                    id                 = $SubscriptionId
                    tenantId           = $TenantId
                    resource           = $resource
                    expirationDateTime = $expiration
                    state              = $state
                }
                healthy      = ($state -eq 'active')
            }
        }
    }
}
