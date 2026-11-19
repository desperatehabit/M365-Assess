# Invoke-TenantOnboarding.ps1 — EPIC-002 direct onboarding worker wrapping Grant-M365AssessConsent (SPEC §4.1, §8, §10).
#
# Wraps the existing Grant-M365AssessConsent setup cmdlet rather than reimplementing it.
# This is a tenant-mutating setup write (ConfirmImpact: High): explicit confirmation is
# mandatory. An unconfirmed call is refused and never passed -Force.
# Captures before/after provisioning status and reports full or half-provisioned failure details.

[CmdletBinding()]
param(
    [Parameter()]
    [string]$TenantId,

    [Parameter()]
    [string]$AdminUpn,

    [Parameter()]
    [string]$AppDisplayName = 'M365-Assess-Reader',

    [Parameter()]
    [string]$ClientId,

    [Parameter()]
    [string]$CertificateThumbprint,

    [Parameter()]
    [switch]$CreateNew,

    [Parameter()]
    [bool]$Confirmed = $false,

    [Parameter()]
    [string]$CmdletScript = '',

    [Parameter()]
    [scriptblock]$CmdletHandler
)

$script:WorkerDirectory = $PSScriptRoot
if (-not $script:WorkerDirectory) {
    $script:WorkerDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
}

function Test-WorkerHasConsoleWindow {
    <#
    .SYNOPSIS
        Returns $true unless this is a Windows process with no console window.
    .DESCRIPTION
        The BFF spawns workers hidden (windowsHide), so on Windows a worker has no console
        window. Microsoft.Graph.Authentication 2.34.0 and later always sign in through WAM on
        Windows (MSAL_ALLOW_WAM and Set-MgGraphOption -DisableLoginByWAM are ignored), and WAM
        needs the console window as the parent of its prompt; without one the sign-in fails
        with "A window handle must be configured".
    .EXAMPLE
        if (-not (Test-WorkerHasConsoleWindow)) { 'needs a sign-in window' }
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param()

    if (-not $IsWindows) { return $true }
    if (-not ('M365Portal.OnboardingConsole' -as [type])) {
        Add-Type -Namespace 'M365Portal' -Name 'OnboardingConsole' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern System.IntPtr GetConsoleWindow();
'@
    }
    return [M365Portal.OnboardingConsole]::GetConsoleWindow() -ne [System.IntPtr]::Zero
}

function Invoke-ConsentInSignInWindow {
    <#
    .SYNOPSIS
        Runs Grant-M365AssessConsent in a new, visible PowerShell window and returns its result.
    .DESCRIPTION
        Used when the worker has no console window (see Test-WorkerHasConsoleWindow). The new
        window has its own console from the start, as a terminal session does, so the WAM
        sign-in prompts for Graph and Exchange Online have a parent window. Parameters go in,
        and the result comes back, through JSON files in a private temp folder; the files are
        removed afterwards. Throws with the child's error when the consent run fails.
    .PARAMETER CmdletScript
        Path to Grant-M365AssessConsent.ps1.
    .PARAMETER ConsentParameters
        The parameters for Grant-M365AssessConsent.
    .PARAMETER StartProcess
        Test seam: replaces Start-Process. Receives the Start-Process parameters.
    .EXAMPLE
        $result = Invoke-ConsentInSignInWindow -CmdletScript $path -ConsentParameters $splat
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$CmdletScript,

        [Parameter(Mandatory)]
        [hashtable]$ConsentParameters,

        [Parameter()]
        [scriptblock]$StartProcess
    )

    $workDir = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("m365-onboard-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $workDir -Force | Out-Null
    try {
        $paramsFile = Join-Path -Path $workDir -ChildPath 'params.json'
        $resultFile = Join-Path -Path $workDir -ChildPath 'result.json'
        $runnerFile = Join-Path -Path $workDir -ChildPath 'run-consent.ps1'

        $ConsentParameters | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $paramsFile -Encoding utf8
        Set-Content -LiteralPath $runnerFile -Encoding utf8 -Value @'
param([string]$CmdletScript, [string]$ParamsFile, [string]$ResultFile)
$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'M365-Assess tenant onboarding - sign in when prompted (do not close)'
try {
    $params = @{}
    (Get-Content -LiteralPath $ParamsFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $params[$_.Name] = $_.Value }
    . $CmdletScript
    $result = Grant-M365AssessConsent @params
    @{ ok = $true; result = $result } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ResultFile -Encoding utf8
}
catch {
    @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ResultFile -Encoding utf8
    Write-Host "Onboarding failed: $($_.Exception.Message)" -ForegroundColor Red
    Start-Sleep -Seconds 10
}
'@

        $pwshPath = (Get-Process -Id $PID).Path
        $startParams = @{
            FilePath     = $pwshPath
            ArgumentList = @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$runnerFile`"",
                '-CmdletScript', "`"$CmdletScript`"", '-ParamsFile', "`"$paramsFile`"", '-ResultFile', "`"$resultFile`""
            )
            WindowStyle  = 'Normal'
            Wait         = $true
        }
        if ($StartProcess) { & $StartProcess $startParams } else { Start-Process @startParams }

        if (-not (Test-Path -LiteralPath $resultFile -PathType Leaf)) {
            throw 'The onboarding sign-in window closed before onboarding finished'
        }
        $outcome = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
        if (-not $outcome.ok) { throw [string]$outcome.error }
        return $outcome.result
    }
    finally {
        Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-TenantOnboarding {
    <#
    .SYNOPSIS
        Wraps Grant-M365AssessConsent to provision the M365-Assess app registration and permissions.
    .DESCRIPTION
        Refuses execution unless Confirmed is $true. Invokes Grant-M365AssessConsent with -Force
        only after confirmation is verified. Returns a structured onboarding envelope detailing
        the provisioned client ID, certificate thumbprint, and per-step permission status.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$AdminUpn,

        [Parameter()]
        [string]$AppDisplayName = 'M365-Assess-Reader',

        [Parameter()]
        [string]$ClientId,

        [Parameter()]
        [string]$CertificateThumbprint,

        [Parameter()]
        [switch]$CreateNew,

        [Parameter(Mandatory)]
        [bool]$Confirmed,

        [Parameter()]
        [string]$CmdletScript = '',

        [Parameter()]
        [scriptblock]$CmdletHandler
    )

    if (-not $Confirmed) {
        throw "Tenant onboarding requires explicit confirmation. An unconfirmed execution is refused and -Force is never passed (code: onboard.confirmation_required)."
    }

    if (-not $CmdletScript -and -not $CmdletHandler) {
        $repoRoot = Split-Path -Path (Split-Path -Path (Split-Path -Path $script:WorkerDirectory -Parent) -Parent) -Parent
        $candidate = Join-Path -Path $repoRoot -ChildPath 'src/M365-Assess/Setup/Grant-M365AssessConsent.ps1'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $CmdletScript = $candidate
        }
    }

    $splat = @{
        TenantId = $TenantId
        Force    = $true
    }
    if ($AdminUpn) { $splat['AdminUpn'] = $AdminUpn }
    if ($AppDisplayName) { $splat['AppDisplayName'] = $AppDisplayName }
    if ($ClientId) { $splat['ClientId'] = $ClientId }
    if ($CertificateThumbprint) { $splat['CertificateThumbprint'] = $CertificateThumbprint }
    if ($CreateNew) { $splat['CreateNew'] = $true }

    try {
        $rawResult = $null
        if ($CmdletHandler) {
            $rawResult = & $CmdletHandler @splat
        }
        elseif ($CmdletScript -and (Test-Path -LiteralPath $CmdletScript -PathType Leaf)) {
            if (Test-WorkerHasConsoleWindow) {
                . $CmdletScript
                $rawResult = Grant-M365AssessConsent @splat
            }
            else {
                # Hidden worker on Windows: WAM sign-in needs a visible console window.
                $rawResult = Invoke-ConsentInSignInWindow -CmdletScript $CmdletScript -ConsentParameters $splat
            }
        }
        else {
            throw "Grant-M365AssessConsent cmdlet script not found at: $CmdletScript"
        }

        $totalFailed = 0
        if ($null -ne $rawResult.TotalFailed) {
            $totalFailed = [int]$rawResult.TotalFailed
        }

        $status = if ($totalFailed -gt 0) { 'partial' } else { 'succeeded' }
        $errorMessage = if ($totalFailed -gt 0) {
            # Name what failed and why; the run output is not shown to the operator otherwise.
            $failedItems = foreach ($step in @($rawResult.GraphPermissions, $rawResult.ComplianceRoles, $rawResult.ExoRoleGroups)) {
                foreach ($item in @($step)) {
                    if ($item.Status -in 'Failed', 'NotFound') {
                        $name = @($item.Permission, $item.Role, $item.RoleGroup) | Where-Object { $_ } | Select-Object -First 1
                        $detail = if ($item.Error) { ": $($item.Error)" } else { '' }
                        "$name ($($item.Status)$detail)"
                    }
                }
            }
            $detailText = if ($failedItems) { ' -- ' + (($failedItems -join '; ') -replace '\s+', ' ') } else { '' }
            "Tenant onboarding completed with $totalFailed failed permission assignments$detailText (code: onboard.partial_failure)."
        } else {
            $null
        }

        return [pscustomobject]@{
            tenantId              = $TenantId
            status                = $status
            clientId              = [string]$rawResult.ClientId
            certificateThumbprint = [string]$rawResult.CertificateThumbprint
            certificatePath       = [string]$rawResult.CertificatePath
            appDisplayName        = [string]$rawResult.AppDisplayName
            bootstrapCreated      = [bool]$rawResult.BootstrapCreated
            graphPermissions      = $rawResult.GraphPermissions
            complianceRoles       = $rawResult.ComplianceRoles
            exoRoleGroups         = $rawResult.ExoRoleGroups
            totalFailed           = $totalFailed
            error                 = $errorMessage
            completedAt           = (Get-Date).ToUniversalTime().ToString('o')
        }
    }
    catch {
        $err = $_.Exception.Message
        return [pscustomobject]@{
            tenantId              = $TenantId
            status                = 'failed'
            clientId              = [string]$splat['ClientId']
            certificateThumbprint = [string]$splat['CertificateThumbprint']
            certificatePath       = ''
            appDisplayName        = [string]$splat['AppDisplayName']
            bootstrapCreated      = $false
            graphPermissions      = @()
            complianceRoles       = @()
            exoRoleGroups         = @()
            totalFailed           = 1
            error                 = "Tenant onboarding failed: $err (code: onboard.failed)"
            completedAt           = (Get-Date).ToUniversalTime().ToString('o')
        }
    }
}

if ($TenantId -and $Confirmed) {
    $result = Invoke-TenantOnboarding -TenantId $TenantId `
                                     -AdminUpn $AdminUpn `
                                     -AppDisplayName $AppDisplayName `
                                     -ClientId $ClientId `
                                     -CertificateThumbprint $CertificateThumbprint `
                                     -CreateNew:$CreateNew `
                                     -Confirmed:$Confirmed `
                                     -CmdletScript $CmdletScript `
                                     -CmdletHandler $CmdletHandler
    return $result
}
