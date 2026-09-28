# Invoke-DeviceWipe.ps1 — EPIC-018 wipe/fresh-start device actions (SPEC §3.3, §4.1, §6; T-0345).
#
# Applies a destructive device action (wipe or fresh-start) via Graph. Wipe
# requires typed confirmation (device name) and a reason; fresh-start requires
# a destructive confirmation. The worker returns the action result; the BFF
# appends a DeviceAction record and audit event.

function Invoke-DeviceWipe {
    <#
    .SYNOPSIS
        Applies a wipe or fresh-start action to a managed device.
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
        [ValidateSet('wipe', 'fresh-start')]
        [string]$Action,

        [Parameter()]
        [string]$Reason = ''
    )

    $actionUri = switch ($Action) {
        'wipe'       { "/v1.0/deviceManagement/managedDevices/$DeviceId/wipe" }
        'fresh-start' { "/v1.0/deviceManagement/managedDevices/$DeviceId/freshStart" }
    }

    $body = $null
    if (-not [string]::IsNullOrWhiteSpace($Reason)) {
        $body = @{ reason = $Reason } | ConvertTo-Json -Compress
    }

    $params = @{
        Method = 'POST'
        Uri    = $actionUri
    }
    if ($body) {
        $params['Body'] = $body
        $params['ContentType'] = 'application/json'
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
