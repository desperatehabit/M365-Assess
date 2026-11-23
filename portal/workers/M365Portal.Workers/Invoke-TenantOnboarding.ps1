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
    [switch]$IncludeWritePermissions,

    [Parameter()]
    [ValidateSet('identity', 'security', 'intune', 'sharepoint', 'exchange')]
    [string[]]$WritePermissionGroups = @(),

    [Parameter()]
    [switch]$ConfirmDangerous,

    [Parameter()]
    [bool]$Confirmed = $false,

    [Parameter()]
    [switch]$Headless,

    [Parameter()]
    [scriptblock]$ProgressChannel,

    [Parameter()]
    [scriptblock]$DeviceCodeTokenAcquirer,

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

function Test-InteractiveDesktop {
    <#
    .SYNOPSIS
        Returns $true when a person can see a sign-in prompt on this machine's desktop.
    .DESCRIPTION
        The interactive WAM/browser sign-in needs a desktop to draw on. A deployed BFF
        (a server, a container, a service account, or a non-Windows host) has none, so
        onboarding uses the device-code flow and relays each code to the wizard instead.
        A worker spawned hidden still gets the visible sign-in window on a local Windows
        desktop (T-0914), because that window is what carries the prompt.
    .PARAMETER Headless
        Force headless mode, regardless of the machine.
    .PARAMETER IsWindowsHost
        Test seam: overrides $IsWindows.
    .PARAMETER UserInteractive
        Test seam: overrides [Environment]::UserInteractive.
    .PARAMETER SessionId
        Test seam: overrides the current process session id (0 is the services session).
    .EXAMPLE
        if (-not (Test-InteractiveDesktop)) { 'use device code' }
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [switch]$Headless,

        [Parameter()]
        [Nullable[bool]]$IsWindowsHost,

        [Parameter()]
        [Nullable[bool]]$UserInteractive,

        [Parameter()]
        [Nullable[int]]$SessionId
    )

    if ($Headless) { return $false }
    if ($env:M365_PORTAL_HEADLESS -match '^(?i:1|true|yes)$') { return $false }

    $windows = if ($null -ne $IsWindowsHost) {
        [bool]$IsWindowsHost
    }
    elseif ($null -ne $IsWindows) {
        [bool]$IsWindows
    }
    else {
        # Windows PowerShell 5.1 has no $IsWindows and only runs on Windows.
        $true
    }
    if (-not $windows) { return $false }

    $interactive = if ($null -ne $UserInteractive) { [bool]$UserInteractive } else { [Environment]::UserInteractive }
    if (-not $interactive) { return $false }

    $session = if ($null -ne $SessionId) { [int]$SessionId } else { (Get-Process -Id $PID).SessionId }
    if ($session -eq 0) { return $false }

    return $true
}

function Get-OnboardingSignInRelay {
    <#
    .SYNOPSIS
        Builds the relay that forwards consent sign-in events to the BFF progress line.
    .PARAMETER Channel
        Optional test channel that receives the event object instead of a stdout JSON line.
    .EXAMPLE
        $relay = Get-OnboardingSignInRelay
    #>
    [CmdletBinding()]
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', 'Channel',
        Justification = 'Read inside the returned relay closure')]
    [OutputType([scriptblock])]
    param(
        [Parameter()]
        [scriptblock]$Channel
    )

    $state = @{ Sequence = 0 }
    return {
        param($SignInEvent)

        $state.Sequence++
        $expiresAt = $null
        if ($SignInEvent.ExpiresOn) {
            $expiresAt = ([datetimeoffset]$SignInEvent.ExpiresOn).ToUniversalTime().ToString('o')
        }
        $payload = [ordered]@{
            schemaVersion   = 'v1'
            sequence        = $state.Sequence
            at              = (Get-Date).ToUniversalTime().ToString('o')
            kind            = [string]$SignInEvent.Kind
            signIn          = [string]$SignInEvent.Stage
            provider        = [string]$SignInEvent.Provider
            code            = if ($SignInEvent.Code) { [string]$SignInEvent.Code } else { $null }
            verificationUrl = if ($SignInEvent.VerificationUrl) { [string]$SignInEvent.VerificationUrl } else { $null }
            expiresAt       = $expiresAt
            message         = if ($SignInEvent.Message) { [string]$SignInEvent.Message } else { $null }
            account         = if ($SignInEvent.Account) { [string]$SignInEvent.Account } else { $null }
            error           = if ($SignInEvent.Error) { [string]$SignInEvent.Error } else { $null }
        }

        if ($Channel) {
            & $Channel $payload
            return
        }
        # The BFF reads the worker's stdout line by line and relays device-code events.
        [System.Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 4))
    }.GetNewClosure()
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

        When there is no interactive desktop (see Test-InteractiveDesktop), the consent runs
        in-process with the device-code flow and each pending code and verification URL is
        written to the progress channel as a JSON line. Otherwise the existing in-console or
        visible sign-in window path is used.
    .PARAMETER Headless
        Force the device-code flow even when a desktop is available.
    .PARAMETER ProgressChannel
        Test seam: receives progress event objects instead of writing them to stdout.
    .PARAMETER DeviceCodeTokenAcquirer
        Test seam forwarded to Grant-M365AssessConsent for the Exchange Online device-code token.
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

        [Parameter()]
        [switch]$IncludeWritePermissions,

        [Parameter()]
        [ValidateSet('identity', 'security', 'intune', 'sharepoint', 'exchange')]
        [string[]]$WritePermissionGroups = @(),

        [Parameter()]
        [switch]$ConfirmDangerous,

        [Parameter(Mandatory)]
        [bool]$Confirmed,

        [Parameter()]
        [switch]$Headless,

        [Parameter()]
        [scriptblock]$ProgressChannel,

        [Parameter()]
        [scriptblock]$DeviceCodeTokenAcquirer,

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
    if ($IncludeWritePermissions) {
        $splat['IncludeWritePermissions'] = $true
        $splat['WritePermissionGroups'] = @($WritePermissionGroups)
        if ($ConfirmDangerous) { $splat['ConfirmDangerous'] = $true }
    }

    try {
        $rawResult = $null
        if ($CmdletHandler) {
            $rawResult = & $CmdletHandler @splat
        }
        elseif ($CmdletScript -and (Test-Path -LiteralPath $CmdletScript -PathType Leaf)) {
            if (-not (Test-InteractiveDesktop -Headless:$Headless)) {
                # No desktop to show a prompt on: use the device-code flow and relay each
                # code through the job progress line the BFF forwards to the wizard.
                Write-Verbose 'No interactive desktop; using device-code sign-in.'
                . $CmdletScript
                $splat['UseDeviceCode'] = $true
                $splat['SignInProgressCallback'] = Get-OnboardingSignInRelay -Channel $ProgressChannel
                if ($DeviceCodeTokenAcquirer) {
                    $splat['DeviceCodeTokenAcquirer'] = $DeviceCodeTokenAcquirer
                }
                $rawResult = Grant-M365AssessConsent @splat
            }
            elseif (Test-WorkerHasConsoleWindow) {
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
            $failedItems = foreach ($step in @(
                $rawResult.GraphPermissions
                $rawResult.ComplianceRoles
                $rawResult.ExoRoleGroups
                $rawResult.OperatorGraphPermissions
                $rawResult.OperatorDirectoryRoles
                $rawResult.OperatorExoRoleGroups
            )) {
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
            operatorAppDisplayName        = [string]$rawResult.OperatorAppDisplayName
            operatorClientId              = [string]$rawResult.OperatorClientId
            operatorCertificateThumbprint = [string]$rawResult.OperatorCertificateThumbprint
            operatorCertificatePath       = [string]$rawResult.OperatorCertificatePath
            operatorCreated               = [bool]$rawResult.OperatorCreated
            writePermissionGroups         = @($rawResult.WritePermissionGroups)
            operatorGraphPermissions      = $rawResult.OperatorGraphPermissions
            operatorDirectoryRoles        = $rawResult.OperatorDirectoryRoles
            operatorExoRoleGroups         = $rawResult.OperatorExoRoleGroups
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
            operatorAppDisplayName        = ''
            operatorClientId              = ''
            operatorCertificateThumbprint = ''
            operatorCertificatePath       = ''
            operatorCreated               = $false
            writePermissionGroups         = @()
            operatorGraphPermissions      = @()
            operatorDirectoryRoles        = @()
            operatorExoRoleGroups         = @()
            totalFailed           = 1
            error                 = "Tenant onboarding failed: $err (code: onboard.failed)"
            completedAt           = (Get-Date).ToUniversalTime().ToString('o')
        }
    }
}

function Test-OnboardingPrerequisite {
    <#
    .SYNOPSIS
        Reports the PowerShell modules tenant onboarding needs, before onboarding starts.
    .DESCRIPTION
        Onboarding runs Grant-M365AssessConsent, which needs the Microsoft Graph and
        Exchange Online modules on the machine that runs the portal workers. This check is
        read-only: it reports the installed versions, the missing modules, and the exact
        Install-Module commands. Graph modules are pinned to the installed
        Microsoft.Graph.Authentication version because mixing Graph SDK versions causes
        assembly load errors.
    .PARAMETER RequiredModules
        Modules onboarding needs. Defaults to Graph authentication, applications, and
        identity governance plus ExchangeOnlineManagement.
    .PARAMETER InstalledModules
        Test seam: a module name to installed version table used instead of probing this
        machine.
    .EXAMPLE
        $preflight = Test-OnboardingPrerequisite
        if (-not $preflight.ready) { $preflight.installCommands }
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [string[]]$RequiredModules = @(
            'Microsoft.Graph.Authentication'
            'Microsoft.Graph.Applications'
            'Microsoft.Graph.Identity.Governance'
            'ExchangeOnlineManagement'
        ),

        [Parameter()]
        [hashtable]$InstalledModules
    )

    $graphModules = @(
        'Microsoft.Graph.Authentication'
        'Microsoft.Graph.Applications'
        'Microsoft.Graph.Identity.Governance'
    )

    $inventory = @{}
    if ($InstalledModules) {
        foreach ($name in $InstalledModules.Keys) {
            if ($InstalledModules[$name]) {
                $inventory[[string]$name] = [string]$InstalledModules[$name]
            }
        }
    }
    else {
        foreach ($name in $RequiredModules) {
            $installed = Get-Module -ListAvailable -Name $name -ErrorAction SilentlyContinue |
                Sort-Object -Property Version -Descending |
                Select-Object -First 1
            if ($installed) {
                $inventory[$name] = [string]$installed.Version
            }
        }
    }

    $graphVersion = $inventory['Microsoft.Graph.Authentication']
    $modules = @(
        foreach ($name in $RequiredModules) {
            $isInstalled = $inventory.ContainsKey($name)
            [pscustomobject]@{
                name      = $name
                installed = $isInstalled
                version   = if ($isInstalled) { $inventory[$name] } else { $null }
            }
        }
    )

    $missing = @($modules | Where-Object { -not $_.installed } | Select-Object -ExpandProperty name)
    $installCommands = @(
        foreach ($name in $missing) {
            if ($graphVersion -and $graphModules -contains $name) {
                "Install-Module $name -RequiredVersion $graphVersion -Scope CurrentUser -Force"
            }
            else {
                "Install-Module $name -Scope CurrentUser -Force"
            }
        }
    )

    if ($missing.Count -eq 0) {
        return [pscustomobject]@{
            ready           = $true
            graphVersion    = $graphVersion
            modules         = $modules
            missingModules  = @()
            installCommands = @()
            message         = 'All onboarding PowerShell modules are installed.'
        }
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("Missing required onboarding PowerShell modules: $($missing -join ', ').")
    $missingGraph = @($missing | Where-Object { $graphModules -contains $_ })
    if ($missingGraph.Count -gt 0) {
        if ($graphVersion) {
            $lines.Add("Install the Microsoft Graph modules at the installed Microsoft.Graph.Authentication version ($graphVersion): mixing Graph SDK versions causes assembly load errors.")
        }
        else {
            $lines.Add('Microsoft.Graph.Authentication is not installed. Install it first, then run this check again so the other Graph modules can be pinned to its version (mixing Graph SDK versions causes assembly load errors).')
        }
    }
    $lines.Add('Run these commands in the account that runs the portal workers, then run the check again:')
    foreach ($command in $installCommands) {
        $lines.Add($command)
    }

    return [pscustomobject]@{
        ready           = $false
        graphVersion    = $graphVersion
        modules         = $modules
        missingModules  = $missing
        installCommands = $installCommands
        message         = ($lines -join [Environment]::NewLine)
    }
}

if ($TenantId -and $Confirmed) {
    $result = Invoke-TenantOnboarding -TenantId $TenantId `
                                     -AdminUpn $AdminUpn `
                                     -AppDisplayName $AppDisplayName `
                                     -ClientId $ClientId `
                                     -CertificateThumbprint $CertificateThumbprint `
                                     -CreateNew:$CreateNew `
                                     -IncludeWritePermissions:$IncludeWritePermissions `
                                     -WritePermissionGroups $WritePermissionGroups `
                                     -ConfirmDangerous:$ConfirmDangerous `
                                     -Confirmed:$Confirmed `
                                     -Headless:$Headless `
                                     -ProgressChannel $ProgressChannel `
                                     -DeviceCodeTokenAcquirer $DeviceCodeTokenAcquirer `
                                     -CmdletScript $CmdletScript `
                                     -CmdletHandler $CmdletHandler
    return $result
}
