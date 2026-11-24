<#
.SYNOPSIS
    Evaluates whether Microsoft 365 Backup is enabled and protecting Exchange,
    SharePoint, and OneDrive.
.DESCRIPTION
    Reads the Microsoft 365 Backup service status and its protection policies from
    Microsoft Graph (/v1.0/solutions/backupRestore) and emits BACKUP-ENABLED-001:

    - Pass when the service is enabled and at least one protection policy is active
    - Warning when the service is enabled but no protection policy is active
    - Fail when the service is disabled
    - Review when the API cannot be read (no Microsoft 365 Backup billing set up, or
      missing BackupRestore-Configuration.Read.All)

    Requires an active Microsoft Graph connection with
    BackupRestore-Configuration.Read.All permission.
.PARAMETER OutputPath
    Optional path to export results as CSV. If not specified, results are returned
    to the pipeline.
.EXAMPLE
    PS> .\Backup\Get-M365BackupConfig.ps1

    Displays the Microsoft 365 Backup evaluation for the connected tenant.
.EXAMPLE
    PS> .\Backup\Get-M365BackupConfig.ps1 -OutputPath '.\m365-backup.csv'

    Exports the evaluation to CSV.
.NOTES
    CMMC:    MP.L2-3.8.9 — Protect the confidentiality of backup CUI at storage locations
#>
[CmdletBinding()]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$_scriptDir = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $PSScriptRoot }
. (Join-Path -Path $_scriptDir -ChildPath '..\Common\SecurityConfigHelper.ps1')

$ctx = Initialize-SecurityConfig
$settings = $ctx.Settings

$backupParams = @{
    Category         = 'Backup'
    Setting          = 'Microsoft 365 Backup Enabled'
    RecommendedValue = 'Microsoft 365 Backup enabled with active protection policies for Exchange, SharePoint, and OneDrive'
    CheckId          = 'BACKUP-ENABLED-001'
}
$enableSteps = 'Microsoft 365 admin center > Settings > Microsoft 365 Backup: set up pay-as-you-go billing, turn on the service, then create backup policies for Exchange, SharePoint, and OneDrive.'

try {
    Write-Verbose 'Checking Microsoft 365 Backup service status...'
    $root = Invoke-MgGraphRequest -Method GET -Uri '/v1.0/solutions/backupRestore' -ErrorAction Stop
    $serviceStatus = if ($root) { $root['serviceStatus'] } else { $null }
    $status = if ($serviceStatus) { [string]$serviceStatus['status'] } else { '' }

    if ($status -ne 'enabled') {
        $reason = if ($serviceStatus -and $serviceStatus['disableReason']) { " (reason: $($serviceStatus['disableReason']))" } else { '' }
        $backupParams.CurrentValue = "Service status: $(if ($status) { $status } else { 'unknown' })$reason"
        $backupParams.Status = 'Fail'
        $backupParams.Remediation = $enableSteps
    }
    else {
        $workloads = [ordered]@{
            'Exchange'   = 'exchangeProtectionPolicies'
            'SharePoint' = 'sharePointProtectionPolicies'
            'OneDrive'   = 'oneDriveForBusinessProtectionPolicies'
        }
        $active = @()
        foreach ($workload in $workloads.Keys) {
            $response = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/solutions/backupRestore/$($workloads[$workload])" -ErrorAction Stop
            $policies = if ($response -and $response['value']) { @($response['value']) } else { @() }
            if (@($policies | Where-Object { [string]$_['status'] -like 'active*' }).Count -gt 0) { $active += $workload }
        }
        $missing = @($workloads.Keys | Where-Object { $active -notcontains $_ })
        if ($active.Count -eq 0) {
            $backupParams.CurrentValue = 'Service enabled, but no protection policy is active'
            $backupParams.Status = 'Warning'
            $backupParams.Remediation = 'Microsoft 365 admin center > Settings > Microsoft 365 Backup: create and activate backup policies for Exchange, SharePoint, and OneDrive.'
        }
        else {
            $backupParams.CurrentValue = "Service enabled; active policies for $($active -join ', ')$(if ($missing.Count -gt 0) { "; none for $($missing -join ', ')" })"
            $backupParams.Status = 'Pass'
            $backupParams.Remediation = if ($missing.Count -gt 0) { "Consider adding backup policies for $($missing -join ', ') if they hold CUI." } else { 'No action needed.' }
        }
    }
}
catch {
    $message = $_.Exception.Message
    $backupParams.CurrentValue = if ($message -match '403|Forbidden|Authorization') {
        'Insufficient permissions, or Microsoft 365 Backup billing is not set up'
    } elseif ($message -match '404|NotFound') {
        'Microsoft 365 Backup is not set up for this tenant'
    } else {
        "Error: $message"
    }
    $backupParams.Status = 'Review'
    $backupParams.Remediation = "Requires BackupRestore-Configuration.Read.All. If Microsoft 365 Backup is not in use, record the backup solution that protects CUI in the SSP. $enableSteps"
}
Add-Setting @backupParams

# ------------------------------------------------------------------
# Output results
# ------------------------------------------------------------------
Export-SecurityConfigReport -Settings $settings -OutputPath $OutputPath -ServiceLabel 'Microsoft 365 Backup'
