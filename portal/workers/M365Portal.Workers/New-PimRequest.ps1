# New-PimRequest.ps1 — EPIC-013 PIM role schedule requests (SPEC §3.3, §4.3, §5; T-0245).
#
# Submits an activation or assignment request for a window.
# Justification is strictly mandatory. When approval is configured, the request
# enters a pending state; otherwise it activates directly.

function Read-PimRequestJob {
    [CmdletBinding()]
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

    $operation = if ($json.operation) { [string]$json.operation } else { 'submit' }
    $requestId = if ($json.requestId) { [string]$json.requestId } else { '' }

    if ($operation -eq 'status') {
        if ([string]::IsNullOrWhiteSpace($requestId)) {
            throw "job envelope '$Path' is missing mandatory 'requestId' for a status read"
        }
        return @{
            TenantId         = [string]$json.tenantId
            Operation        = 'status'
            RequestId        = $requestId
            PrincipalId      = ''
            RoleId           = ''
            Action           = 'activate'
            Justification    = ''
            DurationHours    = 8
            ApprovalRequired = $false
            TicketNumber     = $null
            NewEndsAt        = ''
        }
    }

    if (-not $json.principalId) {
        throw "job envelope '$Path' is missing mandatory 'principalId'"
    }
    if (-not $json.roleId) {
        throw "job envelope '$Path' is missing mandatory 'roleId'"
    }

    return @{
        TenantId         = [string]$json.tenantId
        Operation        = 'submit'
        RequestId        = ''
        PrincipalId      = [string]$json.principalId
        RoleId           = [string]$json.roleId
        Action           = if ($json.action) { [string]$json.action } else { 'activate' }
        Justification    = [string]$json.justification
        DurationHours    = if ($json.durationHours) { [int]$json.durationHours } else { 8 }
        ApprovalRequired = [bool]($json.approvalRequired -eq $true)
        TicketNumber     = if ($json.ticketNumber) { [string]$json.ticketNumber } else { $null }
        NewEndsAt        = if ($json.newEndsAt) { [string]$json.newEndsAt } else { '' }
    }
}

function New-PimRequest {
    <#
    .SYNOPSIS
        Submits a PIM schedule/activation request to Graph with mandatory justification.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$PrincipalId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$RoleId,

        [Parameter()]
        [ValidateSet('activate', 'extend', 'assign', 'deactivate')]
        [string]$Action = 'activate',

        [Parameter()]
        [string]$Justification = '',

        [Parameter()]
        [ValidateRange(1, 24)]
        [int]$DurationHours = 8,

        [Parameter()]
        [switch]$ApprovalRequired,

        [Parameter()]
        [string]$TicketNumber = '',

        # Exact new end for an extend (ISO 8601). When set, the request extends to this
        # instant; without it the window is counted from now, which is wrong for extend.
        [Parameter()]
        [string]$NewEndsAt = ''
    )

    if ([string]::IsNullOrWhiteSpace($Justification)) {
        throw "justification is required for PIM schedule request"
    }

    # App-only workers cannot act as the signed-in principal, so SelfActivate/SelfDeactivate
    # fail; an admin assign/remove on an active schedule is the correct app-only operation.
    $actionMap = @{
        'activate'   = 'AdminAssign'
        'extend'     = 'AdminExtend'
        'assign'     = 'AdminAssign'
        'deactivate' = 'AdminRemove'
    }
    $graphAction = $actionMap[$Action]

    $startTime = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $endTime = (Get-Date).AddHours($DurationHours).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

    $expiration = if (-not [string]::IsNullOrWhiteSpace($NewEndsAt)) {
        @{
            type        = 'AfterDateTime'
            endDateTime = $NewEndsAt
        }
    }
    else {
        @{
            type     = 'AfterDuration'
            duration = "PT${DurationHours}H"
        }
    }

    $body = @{
        action           = $graphAction
        principalId      = $PrincipalId
        roleDefinitionId = $RoleId
        directoryScopeId = '/'
        justification    = $Justification
        scheduleInfo     = @{
            startDateTime = $startTime
            expiration    = $expiration
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($TicketNumber)) {
        $body['ticketInfo'] = @{
            ticketNumber = $TicketNumber
            ticketSystem = 'ServiceDesk'
        }
    }

    $uri = "/v1.0/roleManagement/directory/roleAssignmentScheduleRequests"
    $resp = Invoke-MgGraphRequest -Method POST -Uri $uri -Body ($body | ConvertTo-Json -Depth 5)

    $state = if ($ApprovalRequired -or ($resp -and $resp.status -eq 'PendingApproval')) {
        'pending'
    } else {
        'active'
    }

    $requestId = if ($resp -and $resp.id) { [string]$resp.id } else { [System.Guid]::NewGuid().ToString() }

    return [pscustomobject]@{
        id            = $requestId
        tenantId      = $TenantId
        principalId   = $PrincipalId
        roleId        = $RoleId
        action        = $Action
        state         = $state
        justification = $Justification
        durationHours = $DurationHours
        ticketNumber  = $TicketNumber
        startsAt      = if ($state -eq 'active') { $startTime } else { $null }
        endsAt        = if ($state -eq 'active') {
            if (-not [string]::IsNullOrWhiteSpace($NewEndsAt)) { $NewEndsAt } else { $endTime }
        }
        else { $null }
    }
}

function Get-PimRequestStatus {
    <#
    .SYNOPSIS
        Reads a role assignment schedule request and maps its Entra status to a portal state.
    .DESCRIPTION
        Approval authority is Entra (T-0831). The portal reads the live request so it can
        mirror the decision instead of recording one Entra did not make. The status-to-state
        mapping awaits live-tenant verification.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$RequestId
    )

    $uri = "/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/$RequestId"
    $resp = Invoke-MgGraphRequest -Method GET -Uri $uri

    $status = if ($resp -and $resp.status) { [string]$resp.status } else { '' }
    $state = switch ($status) {
        'Granted' { 'active' }
        'Provisioned' { 'active' }
        'Succeeded' { 'active' }
        'Denied' { 'rejected' }
        'Failed' { 'rejected' }
        'Canceled' { 'cancelled' }
        'Revoked' { 'cancelled' }
        default { 'pending' }
    }

    return [pscustomobject]@{
        id       = [string]$RequestId
        tenantId = $TenantId
        state    = $state
        status   = $status
    }
}
