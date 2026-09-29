# Invoke-DeviceAction.ps1 — EPIC-018 sync/retire device actions (SPEC §3.3, §4.1, §6; T-0344).
#
# Applies a non-destructive device action (sync or retire) via Graph. Sync
# requires no reason; retire requires a short reason. The worker returns the
# action result; the BFF appends a DeviceAction record and audit event.

function Invoke-DeviceAction {
    <#
    .SYNOPSIS
        Applies a sync or retire action to a managed device.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$DeviceId,

        [Parameter(Mandatory = $true)]
        [ValidateSet('sync', 'retire')]
        [string]$Action,

        [Parameter()]
        [string]$Reason = ''
    )

    $actionUri = switch ($Action) {
        'sync'   { "/v1.0/deviceManagement/managedDevices/$DeviceId/syncDevice" }
        'retire' { "/v1.0/deviceManagement/managedDevices/$DeviceId/retire" }
    }

    $params = @{
        Method = 'POST'
        Uri    = $actionUri
    }

    try {
        $response = Invoke-MgGraphRequest @params
        $result = 'success'
        $errorMessage = ''
    }
    catch {
        $result = 'failed'
        $errorMessage = $_.Exception.Message
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        deviceId    = $DeviceId
        action      = $Action
        reason      = if ($Reason) { $Reason } else { $null }
        result      = $result
        error       = $errorMessage
        appliedAt   = (Get-Date -Format 'o')
    }
}
