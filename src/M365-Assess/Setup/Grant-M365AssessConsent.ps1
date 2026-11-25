# Dot-source permission definitions
. "$PSScriptRoot\PermissionDefinitions.ps1"
. "$PSScriptRoot\New-M365AssessCertificate.ps1"

# ======================================================================
# DEVICE-CODE SIGN-IN (T-0916)
#
# A BFF with no interactive desktop cannot show a sign-in window. In that
# case the portal worker asks for the device-code flow instead, relays each
# code and verification URL to the wizard, and the operator signs in from
# their own browser.
#
# Capture:
#   Microsoft Graph -- Connect-MgGraph -UseDeviceCode writes the prompt
#     ("open the page <url> and enter the code <code>") to its output
#     stream, so piping the cmdlet captures the code while it waits.
#     Microsoft.Graph.Authentication 2.41.2 has no device-code callback.
#   Exchange Online -- ExchangeOnlineManagement 3.7.2 -Device has no
#     callback and writes the prompt only to the process console, which a
#     PowerShell pipeline cannot read. The supported equivalent is the
#     device-code flow in the MSAL library the module already loads, whose
#     callback hands us the code and URL, followed by
#     Connect-ExchangeOnline -AccessToken (the documented non-interactive
#     parameter).
# ======================================================================

function Write-M365DeviceCodePrompt {
    <#
    .SYNOPSIS
        Relays one pending device code, or prints it when no relay is attached.
    .PARAMETER Prompt
        Device-code prompt with Kind, Stage, Provider, Code, VerificationUrl and ExpiresOn.
    .PARAMETER Callback
        Optional relay (the portal onboarding worker). Without it the prompt is printed.
    .EXAMPLE
        Write-M365DeviceCodePrompt -Prompt $prompt -Callback $SignInProgressCallback
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [psobject]$Prompt,

        [Parameter()]
        [scriptblock]$Callback
    )

    if ($Callback) {
        & $Callback $Prompt
        return
    }

    Write-Host ''
    Write-Host "  To sign in to $($Prompt.Provider), open $($Prompt.VerificationUrl) and enter the code:" -ForegroundColor Yellow
    Write-Host "      $($Prompt.Code)" -ForegroundColor Cyan
    if ($Prompt.ExpiresOn) {
        Write-Host "  The code expires at $(([datetimeoffset]$Prompt.ExpiresOn).ToLocalTime().ToString('HH:mm')) or when used." -ForegroundColor DarkGray
    }
    Write-Host ''
}

function Format-M365DeviceCodeFailure {
    <#
    .SYNOPSIS
        Turns an interactive sign-in failure into a message the operator can act on.
    .PARAMETER Provider
        Service being signed in to (Microsoft Graph, Exchange Online).
    .PARAMETER Stage
        Onboarding step that was signing in (graph-permissions, exchange-online).
    .PARAMETER Exception
        The failure raised by the sign-in library.
    .EXAMPLE
        throw (Format-M365DeviceCodeFailure -Provider 'Microsoft Graph' -Stage 'graph-permissions' -Exception $_.Exception)
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string]$Provider,

        [Parameter(Mandatory)]
        [string]$Stage,

        [Parameter(Mandatory)]
        [System.Exception]$Exception
    )

    $detail = $Exception.Message
    $errorCode = ''
    if ($Exception.PSObject.Properties['ErrorCode']) {
        $errorCode = [string]$Exception.ErrorCode
    }
    elseif ($Exception.InnerException -and $Exception.InnerException.PSObject.Properties['ErrorCode']) {
        $errorCode = [string]$Exception.InnerException.ErrorCode
    }

    if ($errorCode -in @('code_expired', 'expired_token', 'invalid_grant', 'authentication_canceled', 'user_canceled')) {
        return "The device code for $Provider ($Stage) expired before an operator signed in. Start onboarding again for a fresh code (code: onboard.device_code_expired). $detail"
    }
    return "Device-code sign-in to $Provider ($Stage) failed: $detail (code: onboard.device_code_failed)."
}

function Get-M365DeviceCodeToken {
    <#
    .SYNOPSIS
        Acquires an access token with the MSAL device-code flow, relaying the code first.
    .DESCRIPTION
        Used for Exchange Online, whose Connect-ExchangeOnline -Device switch writes the
        code only to the process console and offers no callback. The callback runs in a
        small C# helper so the MSAL thread never has to invoke PowerShell, and the main
        thread relays each prompt through -Callback. The token is then passed to
        Connect-ExchangeOnline -AccessToken.
    .PARAMETER Resource
        graph or exchange; selects the first-party client id and scope set.
    .PARAMETER TenantId
        Tenant the operator signs in to.
    .PARAMETER Scopes
        Delegated scopes for Graph. Exchange always asks for outlook.office365.com/.default.
    .PARAMETER Stage
        Onboarding step name carried on the relayed prompt.
    .PARAMETER Callback
        Optional relay for the pending code and verification URL.
    .PARAMETER TimeoutSeconds
        How long to wait for the operator before failing with a clear message.
    .PARAMETER Acquirer
        Test seam: returns a token for the request instead of running MSAL.
    .EXAMPLE
        $token = Get-M365DeviceCodeToken -Resource 'exchange' -TenantId 'contoso.onmicrosoft.com' -Stage 'exchange-online' -Callback $relay
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('graph', 'exchange')]
        [string]$Resource,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string[]]$Scopes = @(),

        [Parameter()]
        [string]$Stage = '',

        [Parameter()]
        [scriptblock]$Callback,

        [Parameter()]
        [int]$TimeoutSeconds = 600,

        [Parameter()]
        [scriptblock]$Acquirer
    )

    $profiles = @{
        graph = [pscustomobject]@{
            Provider = 'Microsoft Graph'
            ClientId = '14d82eec-204b-4c2f-b7e8-296a70dab67e'
        }
        exchange = [pscustomobject]@{
            Provider = 'Exchange Online'
            ClientId = 'fb78d390-0c51-40cd-8e17-fdbfab77341b'
        }
    }
    $resourceProfile = $profiles[$Resource]
    if ($Resource -eq 'exchange' -and @($Scopes).Count -eq 0) {
        $Scopes = @('https://outlook.office365.com/.default')
    }

    $request = [pscustomobject]@{
        Resource       = $Resource
        Provider       = $resourceProfile.Provider
        ClientId       = $resourceProfile.ClientId
        TenantId       = $TenantId
        Scopes         = @($Scopes)
        Stage          = $Stage
        TimeoutSeconds = $TimeoutSeconds
    }
    if ($Acquirer) {
        return [string](& $Acquirer $request)
    }

    # Locate the MSAL build to use. Importing the Graph module loads its MSAL and the
    # loader that binds its dependencies; the ExchangeOnlineManagement bundle is a
    # fallback with a self-consistent MSAL set.
    if (-not ('Microsoft.Identity.Client.PublicClientApplicationBuilder' -as [type])) {
        try {
            Import-Module -Name 'Microsoft.Graph.Authentication' -ErrorAction Stop
        }
        catch {
            Write-Verbose "Microsoft.Graph.Authentication was not importable: $($_.Exception.Message)"
        }
    }

    $msalPath = $null
    if ('Microsoft.Identity.Client.PublicClientApplicationBuilder' -as [type]) {
        $msalPath = [Microsoft.Identity.Client.PublicClientApplicationBuilder].Assembly.Location
    }
    else {
        $exoModule = Get-Module -ListAvailable -Name 'ExchangeOnlineManagement' |
            Sort-Object -Property Version -Descending |
            Select-Object -First 1
        if ($exoModule) {
            $bundle = if ($PSEdition -eq 'Desktop') { 'netFramework' } else { 'netCore' }
            $bundleDirectory = Join-Path -Path $exoModule.ModuleBase -ChildPath $bundle
            $candidate = Join-Path -Path $bundleDirectory -ChildPath 'Microsoft.Identity.Client.dll'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                Get-ChildItem -Path (Join-Path -Path $bundleDirectory -ChildPath 'Microsoft.Identity*.dll') -File -ErrorAction SilentlyContinue |
                    ForEach-Object {
                        try {
                            [System.Reflection.Assembly]::LoadFrom($_.FullName) | Out-Null
                        }
                        catch {
                            Write-Verbose "Skipped MSAL dependency $($_.Name): $($_.Exception.Message)"
                        }
                    }
                Add-Type -Path $candidate
                $msalPath = $candidate
            }
        }
    }
    if (-not $msalPath) {
        throw "Device-code sign-in to $($resourceProfile.Provider) needs Microsoft.Identity.Client, which ships with Microsoft.Graph.Authentication and ExchangeOnlineManagement. Install one of those modules (code: consent.device_code_msal_missing)."
    }
    if (-not ('M365Assess.DeviceCode.DeviceCodeCapture' -as [type])) {
        $captureSource = @'
using System;
using System.Collections.Concurrent;
using System.Threading.Tasks;
using Microsoft.Identity.Client;

namespace M365Assess.DeviceCode
{
    // Holds device codes for the PowerShell thread. MSAL raises the callback on a
    // worker thread that has no PowerShell runspace, so the callback only queues the
    // code; the caller relays it.
    public sealed class DeviceCodeCapture
    {
        private readonly BlockingCollection<DeviceCodeResult> _codes =
            new BlockingCollection<DeviceCodeResult>(new ConcurrentQueue<DeviceCodeResult>());

        public Task Capture(DeviceCodeResult result)
        {
            if (result != null) { _codes.Add(result); }
            return Task.CompletedTask;
        }

        public DeviceCodeResult WaitForCode(int millisecondsTimeout)
        {
            DeviceCodeResult result;
            return _codes.TryTake(out result, millisecondsTimeout) ? result : null;
        }
    }
}
'@
        Add-Type -TypeDefinition $captureSource -ReferencedAssemblies @(
            $msalPath
            'netstandard'
            'System.Collections.Concurrent'
            'System.Runtime'
            'System.Threading.Tasks'
        ) -CompilerOptions '/nowarn:1701,1702'
    }

    $authority = "https://login.microsoftonline.com/$TenantId"
    $app = [Microsoft.Identity.Client.PublicClientApplicationBuilder]::Create($resourceProfile.ClientId).
        WithAuthority($authority).
        WithDefaultRedirectUri().
        Build()

    $capture = [M365Assess.DeviceCode.DeviceCodeCapture]::new()
    $delegateType = [System.Func[Microsoft.Identity.Client.DeviceCodeResult, System.Threading.Tasks.Task]]
    $handler = [System.Delegate]::CreateDelegate($delegateType, $capture, 'Capture')

    $tokenTask = $app.AcquireTokenWithDeviceCode([string[]]$Scopes, $handler).ExecuteAsync()
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)

    while (-not $tokenTask.IsCompleted) {
        $deviceCode = $capture.WaitForCode(250)
        if ($deviceCode) {
            $prompt = [pscustomobject]@{
                Kind            = 'device-code'
                Stage           = $Stage
                Provider        = $resourceProfile.Provider
                Code            = $deviceCode.UserCode
                VerificationUrl = $deviceCode.VerificationUrl
                ExpiresOn       = $deviceCode.ExpiresOn
                Message         = $deviceCode.Message
            }
            Write-M365DeviceCodePrompt -Prompt $prompt -Callback $Callback
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            $waitText = if ($TimeoutSeconds -ge 60) {
                "$([int]($TimeoutSeconds / 60)) minutes"
            }
            else {
                "$TimeoutSeconds seconds"
            }
            throw "No operator signed in to $($resourceProfile.Provider) ($Stage) within $waitText. Start onboarding again for a fresh device code (code: onboard.device_code_timeout)."
        }
    }

    if ($tokenTask.IsFaulted) {
        $inner = $tokenTask.Exception.GetBaseException()
        throw (Format-M365DeviceCodeFailure -Provider $resourceProfile.Provider -Stage $Stage -Exception $inner)
    }
    if ($tokenTask.IsCanceled) {
        throw "Device-code sign-in to $($resourceProfile.Provider) ($Stage) was cancelled before an operator signed in (code: onboard.device_code_cancelled)."
    }

    return [string]$tokenTask.GetAwaiter().GetResult().AccessToken
}

function Connect-M365AssessGraphSession {
    <#
    .SYNOPSIS
        Connects a delegated Microsoft Graph session, using the device-code flow in headless mode.
    .DESCRIPTION
        Desktop mode keeps the existing Connect-MgGraph browser/WAM sign-in. Device-code
        mode passes -UseDeviceCode and reads the prompt from the cmdlet's output stream as
        it is written, relaying the code and verification URL before the cmdlet waits for
        the operator.
    .PARAMETER TenantId
        Tenant to sign in to.
    .PARAMETER Scopes
        Delegated Graph scopes.
    .PARAMETER UseDeviceCode
        Use the device-code flow instead of the interactive window.
    .PARAMETER SignInProgressCallback
        Optional relay for prompt and completion events.
    .PARAMETER Stage
        Onboarding step name carried on the relayed events.
    .PARAMETER DeviceCodeLifetimeMinutes
        Lifetime shown for the Graph prompt; the service expires the code itself.
    .EXAMPLE
        Connect-M365AssessGraphSession -TenantId 'contoso.onmicrosoft.com' -Scopes 'Application.ReadWrite.All' -UseDeviceCode -Stage 'graph-bootstrap' -SignInProgressCallback $relay
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string[]]$Scopes = @(),

        [Parameter()]
        [switch]$UseDeviceCode,

        [Parameter()]
        [scriptblock]$SignInProgressCallback,

        [Parameter()]
        [string]$Stage = 'graph',

        [Parameter()]
        [int]$DeviceCodeLifetimeMinutes = 15
    )

    if (-not $UseDeviceCode) {
        Connect-MgGraph -TenantId $TenantId -Scopes $Scopes -NoWelcome -ErrorAction Stop
        return
    }

    $promptState = @{ Seen = $false }
    Connect-MgGraph -TenantId $TenantId -Scopes $Scopes -UseDeviceCode -NoWelcome -ErrorAction Stop |
        ForEach-Object {
            $line = [string]$_
            if ($line -match '(?i)open the page\s+(?<url>https?://\S+)\s+and enter the code\s+(?<code>[A-Za-z0-9\-]+)') {
                $prompt = [pscustomobject]@{
                    Kind            = 'device-code'
                    Stage           = $Stage
                    Provider        = 'Microsoft Graph'
                    Code            = $Matches['code']
                    VerificationUrl = $Matches['url']
                    ExpiresOn       = (Get-Date).ToUniversalTime().AddMinutes($DeviceCodeLifetimeMinutes)
                    Message         = $line
                }
                Write-M365DeviceCodePrompt -Prompt $prompt -Callback $SignInProgressCallback
                $promptState.Seen = $true
            }
            elseif ($line.Trim()) {
                Write-Verbose $line
            }
        }

    if (-not $promptState.Seen) {
        Write-Warning 'Connect-MgGraph -UseDeviceCode did not print a device code. If the sign-in prompt appeared elsewhere, complete it there.'
    }
    if ($SignInProgressCallback) {
        & $SignInProgressCallback ([pscustomobject]@{
            Kind     = 'sign-in-complete'
            Stage    = $Stage
            Provider = 'Microsoft Graph'
            Account  = [string](Get-MgContext).Account
        })
    }
}

function Connect-M365AssessExchangeSession {
    <#
    .SYNOPSIS
        Connects a delegated Exchange Online session, using the device-code flow in headless mode.
    .DESCRIPTION
        Desktop mode keeps Connect-ExchangeOnline -UserPrincipalName. Headless mode acquires
        an Exchange Online token with the MSAL device-code flow (which gives us the code and
        URL) and connects with -AccessToken. ExchangeOnlineManagement -Device writes its code
        only to the process console and cannot be captured by a pipeline.
    .PARAMETER TenantId
        Tenant to sign in to; also passed as -Organization.
    .PARAMETER AdminUpn
        Admin account for the desktop sign-in.
    .PARAMETER UseDeviceCode
        Use the device-code flow instead of the interactive window.
    .PARAMETER SignInProgressCallback
        Optional relay for prompt and completion events.
    .PARAMETER TimeoutSeconds
        How long to wait for the operator before failing with a clear message.
    .PARAMETER DeviceCodeTokenAcquirer
        Test seam forwarded to Get-M365DeviceCodeToken.
    .EXAMPLE
        Connect-M365AssessExchangeSession -TenantId 'contoso.onmicrosoft.com' -AdminUpn 'admin@contoso.onmicrosoft.com' -UseDeviceCode -SignInProgressCallback $relay
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$AdminUpn,

        [Parameter()]
        [switch]$UseDeviceCode,

        [Parameter()]
        [scriptblock]$SignInProgressCallback,

        [Parameter()]
        [int]$TimeoutSeconds = 600,

        [Parameter()]
        [scriptblock]$DeviceCodeTokenAcquirer
    )

    if (-not $UseDeviceCode) {
        Connect-ExchangeOnline -UserPrincipalName $AdminUpn -ShowBanner:$false -ErrorAction Stop
        return
    }

    $token = Get-M365DeviceCodeToken -Resource 'exchange' `
        -TenantId $TenantId `
        -Stage 'exchange-online' `
        -Callback $SignInProgressCallback `
        -TimeoutSeconds $TimeoutSeconds `
        -Acquirer $DeviceCodeTokenAcquirer

    Connect-ExchangeOnline -AccessToken $token -Organization $TenantId -ShowBanner:$false -ErrorAction Stop

    if ($SignInProgressCallback) {
        & $SignInProgressCallback ([pscustomobject]@{
            Kind     = 'sign-in-complete'
            Stage    = 'exchange-online'
            Provider = 'Exchange Online'
            Account  = [string]$AdminUpn
        })
    }
}

function Test-ExoTransientObjectError {
    <#
    .SYNOPSIS
        Recognises the Exchange Online DC-propagation errors seen right after an
        app or service principal is created.
    .DESCRIPTION
        Exchange Online can reject a role-group membership with "object ... couldn't
        be found" while the role group, the member, or the directory object has not
        replicated to the DC the session reached. The wording varies by cmdlet and
        module version, so match the observed variants rather than one phrase.
    .PARAMETER Message
        The exception message to classify.
    .EXAMPLE
        Test-ExoTransientObjectError -Message $_.Exception.Message
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [string]$Message
    )

    return $Message -match "Couldn't find object|could not be found|couldn't be found|couldn't be performed because object|not found"
}

function Test-ExoPartnerManagedRoleGroupError {
    <#
    .SYNOPSIS
        Recognises an Exchange Online role group that is partner-managed and
        cannot have its membership changed.
    .DESCRIPTION
        Some tenants carry a partner-managed Exchange role group (for example
        ExchangeServiceAdmins_<id> with capability Partner_Managed), often from a
        CSP relationship even when GDAP is not used today. A delegated admin
        cannot add members to it, and retrying never helps. The app-only
        authorization surface is the Entra directory role, so this is only fatal
        when that role is missing.
    .PARAMETER Message
        The exception message to classify.
    .EXAMPLE
        Test-ExoPartnerManagedRoleGroupError -Message $_.Exception.Message
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [string]$Message
    )

    return $Message -match "Partner_Managed|partner managed role group|Membership of a partner managed role group|out of the current user's write scope"
}

function Grant-M365AssessConsent {
    <#
    .SYNOPSIS
        SETUP CMDLET (tenant-mutating). Creates and configures an Entra ID app
        registration with all permissions required by M365-Assess.
    .DESCRIPTION
        WARNING -- This is a SETUP cmdlet, not an assessment cmdlet. Unlike
        Invoke-M365Assessment (and the Get-M365* read-only collectors), this
        function MUTATES tenant configuration: it creates app registrations,
        assigns API permissions, grants admin consent, and adds directory-role
        / Exchange-RBAC group memberships. ConfirmImpact is High; the cmdlet
        prompts for confirmation by default. Use -Force to bypass the prompt
        in scripted scenarios where confirmation is provably consented out of
        band.

        Provisions a read-only service principal for Invoke-M365Assessment with:
        - 24 Microsoft Graph API application permissions (all .Read.All)
        - 3 Office 365 Exchange Online API permissions (ManageAsApp, Organization.Read.All, MailboxSettings.Read)
        - 1 Microsoft Purview API permission (Purview.ApplicationAccess)
        - 3 Entra ID directory roles (Security Reader, Compliance Admin, Global Reader)
        - 2 Exchange Online RBAC role groups (View-Only Org Management, Compliance Management)

        On Windows the certificate is created in Cert:\CurrentUser\My. On Linux and macOS, where
        there is no certificate store, it is written to an owner-only PFX under
        ~/.m365-assess/certs and the result carries CertificatePath.

        Supports creating a new app registration from scratch (-CreateNew) or configuring
        an existing one. Saves credentials to .m365assess.json for automatic detection
        by the assessment.

        OPT-IN WRITE ACCESS (T-0917): the assessment app stays read-only. Passing
        -IncludeWritePermissions additionally creates or updates a second app
        registration, 'M365-Assess-Operator', and grants only the write groups named
        in -WritePermissionGroups. The reader app's permissions are identical whether
        or not the switch is passed. Exchange Online role groups and the
        Exchange/Purview/Teams directory roles are assigned only when the 'exchange'
        group is selected. Dangerous grants (PIM role assignment, device wipe,
        Sites.FullControl.All) additionally require -ConfirmDangerous.

        Requires Global Administrator or Application Administrator rights.

        Authentication model:
          Graph step (permissions) -- fully app-only. Connects with ClientId + CertificateThumbprint.
          Compliance roles step   -- delegated Graph session using -AdminUpn.
            New-MgDirectoryRoleMemberByRef requires RoleManagement.ReadWrite.Directory.
            An app cannot grant itself that permission on first run (no bootstrap path),
            so a delegated admin account is used for this step.
          EXO RBAC                -- delegated Exchange Online session using -AdminUpn.
            Add-RoleGroupMember requires a delegated admin session.
            Microsoft does not expose this operation via app-only EXO sessions.

        Role group notes (lessons learned):
          Exchange Online (cloud-only tenants):
            "View-Only Recipients" and "View-Only Configuration" only exist in
            on-premises/hybrid Exchange. In Exchange Online the equivalent access
            is provided by "View-Only Organization Management".

            "Security Reader" is ambiguous -- it exists in both EXO and Entra ID.
            The function uses the unambiguous EXO group "Compliance Management" for
            read-only Defender/EOP policy access instead.

          Purview / Compliance roles:
            "View-Only DLP Compliance Management", "View-Only Manage Alerts", and
            "Compliance Administrator" are Entra ID directory roles, not Security &
            Compliance PowerShell role groups. They are assigned via Graph
            (New-MgDirectoryRoleMemberByRef) rather than Connect-IPPSSession.
    .PARAMETER TenantId
        Tenant ID or domain (e.g. 'contoso.onmicrosoft.com').
    .PARAMETER CreateNew
        Creates a new App Registration and self-signed certificate from scratch.
        Uses delegated auth (browser login) for the bootstrap, then switches to
        app-only for permission assignment. Requires -AdminUpn.
    .PARAMETER ClientId
        Application (Client) ID of the App Registration being configured.
    .PARAMETER AppDisplayName
        Display name of the App Registration. When used with -CreateNew, specifies
        the name for the new app (default: 'M365-Assess-Reader'). When used alone,
        looks up an existing app by name.
    .PARAMETER CertificateThumbprint
        Thumbprint of the certificate in Cert:\CurrentUser\My used for app-only
        Graph authentication. Must also be uploaded to the App Registration.
        Not required with -CreateNew (the function generates a certificate).
    .PARAMETER CertificateExpiryYears
        Number of years before the generated certificate expires. Default: 2.
        Only used with -CreateNew.
    .PARAMETER AdminUpn
        UPN of an Exchange Administrator or Global Administrator account, used for
        delegated sessions (app creation, compliance roles, Exchange RBAC).
        Required with -CreateNew and for EXO/compliance steps.
    .PARAMETER SkipGraph
        Skip the Microsoft Graph API permission assignment step.
    .PARAMETER SkipExchangeRbac
        Skip the Exchange Online role group assignment step.
    .PARAMETER SkipComplianceRoles
        Skip the Purview/Compliance Entra directory role assignment step.
    .PARAMETER IncludeWritePermissions
        Opt in to the operator app registration ('M365-Assess-Operator') and the
        write permission groups selected with -WritePermissionGroups. The reader
        app registration configured by the normal run is never granted a write
        permission.
    .PARAMETER WritePermissionGroups
        Write groups to grant to the operator app: identity, security, intune,
        sharepoint, exchange. Required with -IncludeWritePermissions. Definitions
        live in PermissionDefinitions.ps1 and mirror the T-0917 matrix.
    .PARAMETER OperatorAppDisplayName
        Display name of the opt-in operator app registration. Default:
        'M365-Assess-Operator'. Only used with -IncludeWritePermissions.
    .PARAMETER ConfirmDangerous
        Required when a selected group contains a dangerous grant (PIM role
        assignment, DeviceManagementManagedDevices.PrivilegedOperations.All, or
        Sites.FullControl.All). Without it the cmdlet refuses before changing the
        tenant and names the dangerous grants.
    .PARAMETER ReplaceWriteGroups
        Reconcile the operator app's managed grants to -WritePermissionGroups:
        add the selected grants and remove the managed operator grants that are
        no longer selected (Graph app roles, directory roles from the T-0917
        matrix, and EXO role groups). The reader app is never changed, and
        assignments outside the T-0917 matrix are never removed. Requires
        -IncludeWritePermissions.
    .PARAMETER Force
        Bypass the high-impact ShouldProcess confirmation prompt. Without -Force,
        the cmdlet prompts before any tenant-mutating action (ConfirmImpact='High').
        Use only in scripted scenarios where confirmation is consented out of band
        (CI/CD, deployment scripts that gate on operator approval upstream).
    .PARAMETER UseDeviceCode
        Sign in with the device-code flow instead of the interactive desktop window.
        Use when there is no interactive desktop to show a prompt on (a portal worker,
        a service, a container, a non-Windows host). Each pending code and verification
        URL is passed to -SignInProgressCallback so the operator can sign in from their
        own browser.
    .PARAMETER SignInProgressCallback
        Scriptblock invoked for each sign-in event. Device-code prompts carry Kind
        'device-code' plus Stage, Provider, Code, VerificationUrl and ExpiresOn; a
        completed sign-in carries Kind 'sign-in-complete' plus Stage, Provider and
        Account.
    .PARAMETER DeviceCodeTimeoutSeconds
        How long to wait for the operator to enter each device code. Default: 600 (ten
        minutes). On expiry the cmdlet throws onboard.device_code_expired or
        onboard.device_code_timeout so the caller can show a clear message.
    .PARAMETER DeviceCodeTokenAcquirer
        Test seam for the Exchange Online device-code token. Receives the request
        (Resource, Provider, ClientId, TenantId, Scopes, Stage, TimeoutSeconds) and
        returns an access token instead of running MSAL.
    .EXAMPLE
        Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' -AdminUpn 'admin@contoso.onmicrosoft.com' -CreateNew

        Creates a new app registration named 'M365-Assess-Reader' with a 2-year
        self-signed certificate, then assigns all required permissions. Prints
        the ClientId and thumbprint for use with Invoke-M365Assessment.
    .EXAMPLE
        Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' -ClientId '00000000-0000-0000-0000-000000000000' -CertificateThumbprint 'ABC123DEF456' -AdminUpn 'admin@contoso.onmicrosoft.com'

        Configures an existing app registration with all required permissions.
    .EXAMPLE
        Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' -ClientId '00000000-0000-0000-0000-000000000000' -CertificateThumbprint 'ABC123DEF456' -SkipExchangeRbac -SkipComplianceRoles

        Graph permissions only -- no AdminUpn required.
    .EXAMPLE
        Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' -AdminUpn 'admin@contoso.onmicrosoft.com' -CreateNew -IncludeWritePermissions -WritePermissionGroups 'identity','security','exchange' -ConfirmDangerous

        Also creates 'M365-Assess-Operator' with only the identity, security, and
        exchange write groups. Identity includes PIM role assignment, so
        -ConfirmDangerous is required. The reader app stays read-only.
    .NOTES
        Required modules:
            Install-Module Microsoft.Graph.Authentication    -Scope CurrentUser
            Install-Module Microsoft.Graph.Applications      -Scope CurrentUser
            Install-Module Microsoft.Graph.Identity.Governance -Scope CurrentUser
            Install-Module ExchangeOnlineManagement          -Scope CurrentUser
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High', DefaultParameterSetName = 'CreateNew')]
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', 'CreateNew',
        Justification = 'Used implicitly via ParameterSetName')]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [string]$TenantId,

        [Parameter(ParameterSetName = 'CreateNew')]
        [switch]$CreateNew,

        [Parameter(ParameterSetName = 'Existing', Mandatory)]
        [string]$ClientId,

        [Parameter()]
        [string]$AppDisplayName = 'M365-Assess-Reader',

        [Parameter(ParameterSetName = 'Existing')]
        [string]$CertificateThumbprint,

        [Parameter(ParameterSetName = 'CreateNew')]
        [ValidateRange(1, 10)]
        [int]$CertificateExpiryYears = 2,

        [Parameter()]
        [string]$AdminUpn,

        [Parameter()]
        [switch]$SkipGraph,

        [Parameter()]
        [switch]$SkipExchangeRbac,

        [Parameter()]
        [switch]$SkipComplianceRoles,

        [Parameter()]
        [switch]$IncludeWritePermissions,

        [Parameter()]
        [ValidateSet('identity', 'security', 'intune', 'sharepoint', 'exchange')]
        [string[]]$WritePermissionGroups,

        [Parameter()]
        [string]$OperatorAppDisplayName = 'M365-Assess-Operator',

        [Parameter()]
        [switch]$ConfirmDangerous,

        [Parameter()]
        [switch]$ReplaceWriteGroups,

        [Parameter()]
        [switch]$Force,

        [Parameter()]
        [switch]$UseDeviceCode,

        [Parameter()]
        [scriptblock]$SignInProgressCallback,

        [Parameter()]
        [ValidateRange(1, 60)]
        [int]$DeviceCodeTimeoutSeconds = 600,

        [Parameter()]
        [scriptblock]$DeviceCodeTokenAcquirer,

        [Parameter()]
        [string]$ProfileName
    )

    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest

    # E2 #791: high-impact ShouldProcess gate. The cmdlet mutates tenant config
    # (app registration, API permissions, admin consent, role memberships).
    # ConfirmImpact='High' triggers a confirmation prompt at default
    # $ConfirmPreference; -Force bypasses for scripted use.
    if (-not $Force) {
        $shouldProcessTarget = "tenant '$TenantId'"
        $shouldProcessAction = if ($PSCmdlet.ParameterSetName -eq 'CreateNew') {
            "Create app registration '$AppDisplayName' and grant M365-Assess permissions"
        } else {
            "Configure existing app registration (ClientId '$ClientId') with M365-Assess permissions"
        }
        if (-not $PSCmdlet.ShouldProcess($shouldProcessTarget, $shouldProcessAction)) {
            # -WhatIf falls through to the plan output below; a declined confirmation
            # stops here without changing the tenant.
            if (-not $WhatIfPreference) {
                Write-Host "  Cancelled by user. No tenant changes were made." -ForegroundColor Yellow
                return
            }
        }
    }
    else {
        # -Force means the caller already confirmed (the portal wizard, a script). Without this
        # every later ShouldProcess call in the function would prompt again at ConfirmImpact High,
        # which throws in non-interactive hosts such as portal workers.
        $ConfirmPreference = 'None'
    }

    # ------------------------------------------------------------------
    # Opt-in write access: resolve the operator selection before any
    # mutation, so an unknown group or an unconfirmed dangerous grant
    # cannot leave the reader app half-configured.
    # ------------------------------------------------------------------
    $operatorSelection = $null
    if ($IncludeWritePermissions) {
        if (-not $WritePermissionGroups -or @($WritePermissionGroups).Count -eq 0) {
            throw 'IncludeWritePermissions requires -WritePermissionGroups (identity, security, intune, sharepoint, exchange) (code: consent.write_groups_required).'
        }
        $operatorSelection = Get-M365AssessOperatorWriteSelection -Groups $WritePermissionGroups

        if (@($operatorSelection.DangerousPermissions).Count -gt 0 -and -not $ConfirmDangerous) {
            $dangerous = @($operatorSelection.DangerousPermissions) -join ', '
            throw "Refusing dangerous write permissions without -ConfirmDangerous: $dangerous (code: consent.dangerous_requires_confirmation)."
        }

        if (-not $WhatIfPreference -and -not $AdminUpn) {
            throw 'Provisioning the operator app registration requires -AdminUpn for the delegated Graph session (code: consent.admin_upn_required).'
        }
    }
    elseif ($ReplaceWriteGroups) {
        throw 'ReplaceWriteGroups requires -IncludeWritePermissions and at least one -WritePermissionGroups value (code: consent.replace_requires_write).'
    }

    # Everything -ReplaceWriteGroups may remove: only grants the T-0917 matrix owns.
    # Assignments outside this set are never touched, and the reader app is a
    # different service principal entirely.
    $operatorManagedGraphPermissions = @(
        @(
            foreach ($group in @($script:OperatorWriteGroups.Keys)) {
                @($script:OperatorWriteGroups[$group].GraphPermissions)
            }
        ) | Select-Object -Unique
    )
    $operatorManagedExchangeAppRoles = @(
        @(
            foreach ($group in @($script:OperatorWriteGroups.Keys)) {
                @($script:OperatorWriteGroups[$group].ExchangeAppRoles)
            }
        ) | Select-Object -Unique
    )
    $operatorManagedExoRoleGroups = @(
        @(
            foreach ($group in @($script:OperatorWriteGroups.Keys)) {
                @($script:OperatorWriteGroups[$group].ExoRoleGroups)
            }
        ) | Select-Object -Unique
    )
    $operatorManagedDirectoryRoles = @(
        @(
            foreach ($group in @($script:OperatorWriteGroups.Keys)) {
                @($script:OperatorWriteGroups[$group].DirectoryRoles)
            }
        ) | Select-Object -Unique
    )
    # The operator app may carry Purview app access from an earlier manual grant;
    # it is managed but never selected by the write matrix, so a replace run removes it.
    $operatorManagedPurviewAppRoles = @('Purview.ApplicationAccess')

    # ==================================================================
    # INTERNAL HELPERS (private to function scope)
    # ==================================================================

    function Write-Banner {
        param([string]$Title, [string]$Color = 'Cyan')
        $border = '=' * ($Title.Length + 4)
        Write-Host ''
        Write-Host "  $border"    -ForegroundColor $Color
        Write-Host "  = $Title =" -ForegroundColor $Color
        Write-Host "  $border"    -ForegroundColor $Color
        Write-Host ''
    }

    function Write-Step { param([string]$M) Write-Host "`n  > $M" -ForegroundColor Cyan }
    function Write-OK   { param([string]$M) Write-Host "    + $M" -ForegroundColor Green }
    function Write-Skip { param([string]$M) Write-Host "    o $M" -ForegroundColor DarkGray }
    function Write-Warn { param([string]$M) Write-Host "    ! $M" -ForegroundColor Yellow }
    function Write-Fail { param([string]$M) Write-Host "    x $M" -ForegroundColor Magenta }
    function Write-Info { param([string]$M) Write-Host "    . $M" -ForegroundColor White }

    function Write-StepSummary {
        param([string]$Label, [object[]]$Results, [string]$ItemField)
        $added    = @($Results | Where-Object { $_.Status -eq 'Added' }).Count
        $removed  = @($Results | Where-Object { $_.Status -eq 'Removed' }).Count
        $present  = @($Results | Where-Object { $_.Status -eq 'AlreadyPresent' }).Count
        $failed   = @($Results | Where-Object { $_.Status -eq 'Failed' }).Count
        $notfound = @($Results | Where-Object { $_.Status -eq 'NotFound' }).Count
        $whatif   = @($Results | Where-Object { $_.Status -eq 'WhatIf' }).Count
        $skipped  = @($Results | Where-Object { $_.Status -eq 'Skipped' }).Count
        $pad      = '-' * [Math]::Max(0, 52 - $Label.Length)

        Write-Host "  -- $Label $pad" -ForegroundColor Cyan
        Write-Host "     Added           : $added"   -ForegroundColor $(if ($added -gt 0) { 'Green' } else { 'DarkGray' })
        if ($removed -gt 0) {
            Write-Host "     Removed         : $removed" -ForegroundColor Green
            $Results | Where-Object { $_.Status -eq 'Removed' } | ForEach-Object { Write-Host "       - $($_.$ItemField)" -ForegroundColor Green }
        }
        Write-Host "     Already present : $present" -ForegroundColor DarkGray
        if ($skipped -gt 0) { Write-Host "     Skipped         : $skipped" -ForegroundColor DarkGray }
        if ($failed -gt 0) {
            Write-Host "     Failed          : $failed" -ForegroundColor Magenta
            $Results | Where-Object { $_.Status -eq 'Failed' } | ForEach-Object { Write-Host "       - $($_.$ItemField)" -ForegroundColor Magenta }
        }
        if ($notfound -gt 0) {
            Write-Host "     Not found       : $notfound" -ForegroundColor Yellow
            $Results | Where-Object { $_.Status -eq 'NotFound' } | ForEach-Object { Write-Host "       - $($_.$ItemField)" -ForegroundColor Yellow }
        }
        if ($whatif -gt 0) { Write-Host "     [WhatIf]        : $whatif" -ForegroundColor DarkYellow }
        Write-Host ''
    }

    # ==================================================================
    # BANNER + PRE-FLIGHT
    # ==================================================================

    Write-Banner -Title 'M365 Assessment - Full Permission Configurator'

    if ($WhatIfPreference) {
        Write-Host '  *** WHATIF MODE - no changes will be made ***' -ForegroundColor Yellow
        Write-Host ''

        $readerAction = if ($PSCmdlet.ParameterSetName -eq 'CreateNew') {
            "Create reader app '$AppDisplayName' and grant $($script:RequiredGraphPermissions.Count) read-only Graph permissions, $($script:RequiredComplianceRoles.Count) directory roles, and $($script:RequiredExoRoleGroups.Count) EXO role groups."
        }
        else {
            "Configure existing reader app '$ClientId' with the read-only permission set (unchanged)."
        }
        Write-Host "  Reader app : $readerAction" -ForegroundColor White

        if ($IncludeWritePermissions) {
            Write-Host "  Operator app: Create or update '$OperatorAppDisplayName' with groups: $(@($operatorSelection.Groups) -join ', ')" -ForegroundColor White
            foreach ($permission in @($operatorSelection.GraphPermissions)) {
                Write-Host "    - Graph permission: $permission" -ForegroundColor DarkYellow
            }
            foreach ($role in @($operatorSelection.ExchangeAppRoles)) {
                Write-Host "    - Exchange app role: $role" -ForegroundColor DarkYellow
            }
            foreach ($role in @($operatorSelection.DirectoryRoles)) {
                Write-Host "    - Directory role: $role" -ForegroundColor DarkYellow
            }
            foreach ($rg in @($operatorSelection.ExoRoleGroups)) {
                Write-Host "    - EXO role group: $rg" -ForegroundColor DarkYellow
            }
            if ($ReplaceWriteGroups) {
                $unselectedGraph = @($operatorManagedGraphPermissions | Where-Object { @($operatorSelection.GraphPermissions) -notcontains $_ })
                $unselectedExchange = @($operatorManagedExchangeAppRoles | Where-Object { @($operatorSelection.ExchangeAppRoles) -notcontains $_ })
                $unselectedExo = @($operatorManagedExoRoleGroups | Where-Object { @($operatorSelection.ExoRoleGroups) -notcontains $_ })
                $unselectedRoles = @($operatorManagedDirectoryRoles | Where-Object { @($operatorSelection.DirectoryRoles) -notcontains $_ })
                Write-Host '  -ReplaceWriteGroups would remove these unselected managed operator grants:' -ForegroundColor White
                foreach ($permission in $unselectedGraph) {
                    Write-Host "    - Graph app role: $permission" -ForegroundColor DarkYellow
                }
                foreach ($role in $unselectedExchange) {
                    Write-Host "    - Exchange app role: $role" -ForegroundColor DarkYellow
                }
                foreach ($role in $operatorManagedPurviewAppRoles) {
                    Write-Host "    - Purview app role (if present): $role" -ForegroundColor DarkYellow
                }
                foreach ($role in $unselectedRoles) {
                    Write-Host "    - Directory role: $role" -ForegroundColor DarkYellow
                }
                foreach ($rg in $unselectedExo) {
                    Write-Host "    - EXO role group: $rg" -ForegroundColor DarkYellow
                }
                if (@($unselectedGraph).Count + @($unselectedExchange).Count + @($operatorManagedPurviewAppRoles).Count + @($unselectedRoles).Count + @($unselectedExo).Count -eq 0) {
                    Write-Host '    - Nothing: every managed operator grant is still selected' -ForegroundColor DarkGray
                }
            }
            Write-Host '  The reader app is not granted any write permission.' -ForegroundColor DarkGray
        }

        Write-Host ''
        Write-Host '  Re-run without -WhatIf to apply the plan.' -ForegroundColor DarkGray
        Write-Host ''
        return
    }

    # Device-code sign-in runs unattended: there is no console to answer Read-Host
    # prompts, so require the delegated admin UPN up front and fail with a clear code.
    if ($UseDeviceCode -and -not $AdminUpn -and (-not $SkipExchangeRbac -or -not $SkipComplianceRoles)) {
        throw 'Device-code sign-in requires -AdminUpn for the delegated Exchange Online and directory-role steps (code: consent.admin_upn_required).'
    }

    if (-not $SkipExchangeRbac -and -not $AdminUpn) {
        Write-Host '  Exchange Online RBAC requires a delegated admin session.' -ForegroundColor Yellow
        Write-Host '  Enter the UPN of a Global or Exchange Administrator:' -ForegroundColor White
        Write-Host '  > ' -ForegroundColor Cyan -NoNewline
        $AdminUpn = (Read-Host) ?? ''
        if (-not $AdminUpn.Trim()) {
            Write-Host '  No UPN provided -- skipping Exchange RBAC step.' -ForegroundColor DarkGray
            $SkipExchangeRbac = [switch]$true
        }
        else {
            $AdminUpn = $AdminUpn.Trim()
        }
    }
    # Compliance roles also need AdminUpn for delegated Graph session
    if (-not $SkipComplianceRoles -and -not $AdminUpn) {
        Write-Host '  Compliance role assignment also requires an admin UPN.' -ForegroundColor Yellow
        Write-Host '  Enter the UPN of a Global Administrator (or press ENTER to skip):' -ForegroundColor White
        Write-Host '  > ' -ForegroundColor Cyan -NoNewline
        $AdminUpn = (Read-Host) ?? ''
        if (-not $AdminUpn.Trim()) {
            Write-Host '  No UPN provided -- skipping compliance roles step.' -ForegroundColor DarkGray
            $SkipComplianceRoles = [switch]$true
        }
        else {
            $AdminUpn = $AdminUpn.Trim()
        }
    }

    # ==================================================================
    # STEP 1 - MODULE VALIDATION
    # ==================================================================

    Write-Step 'Validating required PowerShell modules...'

    $moduleChecks = @(
        @{ Name = 'Microsoft.Graph.Authentication';       Required = $true }
        @{ Name = 'Microsoft.Graph.Applications';         Required = $true }
        @{ Name = 'Microsoft.Graph.Identity.Governance';  Required = (-not $SkipComplianceRoles) }
        @{ Name = 'ExchangeOnlineManagement';             Required = (-not $SkipExchangeRbac) }
    )

    $missingModules = @()
    foreach ($m in $moduleChecks) {
        if (-not $m.Required) { Write-Skip "$($m.Name) - step skipped, not checked"; continue }
        if (Get-Module -ListAvailable -Name $m.Name) {
            Write-OK $m.Name
        }
        else {
            Write-Fail "$($m.Name) - NOT INSTALLED"
            Write-Info "Fix: Install-Module $($m.Name) -Scope CurrentUser"
            $missingModules += $m.Name
        }
    }

    if ($missingModules.Count -gt 0) {
        throw "Missing required modules: $($missingModules -join ', '). Install them and re-run."
    }

    # ==================================================================
    # STEP 1b - BOOTSTRAP: CREATE APP REGISTRATION + CERTIFICATE
    #           (CreateNew parameter set only)
    #
    # When -CreateNew is specified, the function creates everything:
    #   1. Connect delegated (browser login) -- no app exists yet
    #   2. Generate a self-signed certificate in Cert:\CurrentUser\My
    #   3. Create the App Registration with the certificate uploaded
    #   4. Create the Service Principal
    #   5. Set $ClientId and $CertificateThumbprint for downstream steps
    #   6. Disconnect delegated session
    #
    # After this block, the function flows into the normal Steps 2-5
    # using the newly created app and certificate.
    # ==================================================================

    $bootstrapCreated = $false
    $cert = $null
    $cerPath = $null
    # Set only when the certificate lives in a PFX file (non-Windows) instead of Cert:\CurrentUser\My.
    $certificatePath = $null

    if ($PSCmdlet.ParameterSetName -eq 'CreateNew') {
        Write-Step "Bootstrapping new app registration '$AppDisplayName'..."
        if ($UseDeviceCode) {
            Write-Info 'This requires a one-time delegated device-code sign-in to create the app.'
        }
        else {
            Write-Info 'This requires a one-time delegated login (browser) to create the app.'
        }

        # --- Connect delegated for bootstrap ---
        # MSAL_ALLOW_WAM = '0' workaround is critical -- without it,
        # Connect-MgGraph fails on some Windows machines where the WAM
        # broker intercepts the auth flow and causes silent failures.
        $prevWam = $env:MSAL_ALLOW_WAM
        $env:MSAL_ALLOW_WAM = '0'
        try {
            Connect-M365AssessGraphSession -TenantId $TenantId `
                -Scopes @('Application.ReadWrite.All') `
                -UseDeviceCode:$UseDeviceCode `
                -SignInProgressCallback $SignInProgressCallback `
                -Stage 'graph-bootstrap'
            $bootstrapCtx = Get-MgContext
            Write-OK "Connected (delegated) as: $($bootstrapCtx.Account)"
        }
        catch {
            throw "Delegated Graph connection failed: $($_.Exception.Message). " +
                  'Ensure the account has Application Administrator or Global Administrator rights.'
        }
        finally {
            $env:MSAL_ALLOW_WAM = $prevWam
        }

        # --- Check for duplicate app name ---
        # An earlier run that stopped part way leaves the app and its PFX behind. When this machine
        # holds the private key for that app, resume it instead of failing on the duplicate name.
        $certDirectory = Join-Path -Path (Join-Path -Path $HOME -ChildPath '.m365-assess') -ChildPath 'certs'
        $resumedApp = $false
        $existingApps = @(Get-MgApplication -Filter "displayName eq '$AppDisplayName'" -ErrorAction Stop)
        if ($existingApps.Count -gt 0) {
            $existingId = $existingApps[0].AppId
            $resumable = $null
            if ($IsWindows) {
                # The bootstrap stores the key in Cert:\CurrentUser\My on Windows.
                $resumable = Find-M365AssessStoreCertificate -AppKeys @($existingApps[0].KeyCredentials) -Subject "CN=M365-Assess-$TenantId"
            }
            else {
                $findParams = @{
                    AppKeys        = @($existingApps[0].KeyCredentials)
                    Directory      = $certDirectory
                    BaseName       = "M365-Assess-$TenantId"
                }
                $resumable = Find-M365AssessCertificate @findParams
            }
            if ($resumable) {
                $resumedApp = $true
                $ClientId = $existingId
                $cert = $resumable.Certificate
                $CertificateThumbprint = $resumable.Thumbprint
                $certificatePath = $resumable.CertificatePath
                $cerPath = $resumable.CerPath
                Write-OK "Resuming existing app '$AppDisplayName' (AppId: $ClientId)"
                $keyLocation = if ($certificatePath) { $certificatePath } else { "Cert:\CurrentUser\My\$CertificateThumbprint" }
                Write-OK "Using the private key already on this machine: $keyLocation"
            }
            else {
                Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null
                throw "An app named '$AppDisplayName' already exists (AppId: $existingId). " +
                      "Use -ClientId '$existingId' -CertificateThumbprint <thumbprint> to configure " +
                      'the existing app, or choose a different -AppDisplayName.'
            }
        }

        if (-not $resumedApp) {
            # --- Generate self-signed certificate ---
            Write-Step "Generating self-signed certificate (CN=M365-Assess-$TenantId, $CertificateExpiryYears yr)..."
            $certSubject = "CN=M365-Assess-$TenantId"
            if ($IsWindows) {
                $certParams = @{
                    Subject            = $certSubject
                    CertStoreLocation  = 'Cert:\CurrentUser\My'
                    KeyExportPolicy    = 'Exportable'
                    KeySpec            = 'Signature'
                    KeyLength          = 2048
                    KeyAlgorithm       = 'RSA'
                    HashAlgorithm      = 'SHA256'
                    NotAfter           = (Get-Date).AddYears($CertificateExpiryYears)
                }
                $cert = New-SelfSignedCertificate @certParams
                $CertificateThumbprint = $cert.Thumbprint
            }
            else {
                # No Windows certificate store: keep the key in an owner-only PFX file instead.
                $newCertParams = @{
                    Subject         = $certSubject
                    ExpiryYears     = $CertificateExpiryYears
                    OutputDirectory = $certDirectory
                    BaseName        = "M365-Assess-$TenantId"
                }
                $generated = New-M365AssessCertificate @newCertParams
                $cert = $generated.Certificate
                $CertificateThumbprint = $generated.Thumbprint
                $certificatePath = $generated.CertificatePath
            }
            Write-OK "Certificate created: $certSubject"
            Write-OK "Thumbprint: $CertificateThumbprint"
            Write-OK "Expires: $($cert.NotAfter.ToString('yyyy-MM-dd'))"
            if ($certificatePath) { Write-OK "Private key (PFX, owner-only): $certificatePath" }

            # --- Export public key (.cer) for portability ---
            if ($IsWindows) {
                $cerPath = Join-Path (Get-Location) "M365-Assess-$TenantId.cer"
                Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT | Out-Null
            }
            else {
                $cerPath = $generated.CerPath
            }
            Write-OK "Public key exported: $cerPath"

            # --- Create app registration with certificate ---
            Write-Step "Creating app registration '$AppDisplayName'..."
            $keyCredential = @{
                Type          = 'AsymmetricX509Cert'
                Usage         = 'Verify'
                Key           = $cert.RawData
                DisplayName   = $certSubject
                StartDateTime = $cert.NotBefore.ToUniversalTime().ToString('o')
                EndDateTime   = $cert.NotAfter.ToUniversalTime().ToString('o')
            }

            if ($PSCmdlet.ShouldProcess($AppDisplayName, 'Create new app registration')) {
                $newApp = New-MgApplication -DisplayName $AppDisplayName -SignInAudience 'AzureADMyOrg' -KeyCredentials @($keyCredential) -ErrorAction Stop
                $ClientId = $newApp.AppId
                Write-OK "App created: $AppDisplayName"
                Write-OK "Application (client) ID: $ClientId"
                Write-OK "Object ID: $($newApp.Id)"
            }

            # --- Create service principal ---
            Write-Step 'Creating service principal...'
            if ($PSCmdlet.ShouldProcess($AppDisplayName, 'Create service principal')) {
                $newSp = New-MgServicePrincipal -AppId $ClientId -ErrorAction Stop
                Write-OK "Service principal created (ObjectId: $($newSp.Id))"
            }
        }

        # --- Disconnect bootstrap session ---
        Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null
        Write-Info 'Disconnected bootstrap delegated session'

        # --- Wait for AAD replication ---
        # This delay is necessary for Azure AD to replicate the new app
        # registration and service principal across all directory partitions.
        if (-not $resumedApp) {
            Write-Info 'Waiting 10 seconds for Azure AD replication...'
            Start-Sleep -Seconds 10
        }

        $bootstrapCreated = -not $resumedApp

        # WhatIf guard -- downstream steps require the real app + cert to exist
        if ($WhatIfPreference) {
            Write-Host ''
            Write-Host '  [WhatIf] Would create app registration, certificate, and service principal,' -ForegroundColor DarkYellow
            Write-Host '           then proceed with permission assignment (Graph, Compliance, EXO).'    -ForegroundColor DarkYellow
            if ($IncludeWritePermissions) {
                Write-Host "  [WhatIf] Would also create operator app '$OperatorAppDisplayName' and grant: $(@($operatorSelection.Groups) -join ', ')." -ForegroundColor DarkYellow
            }
            Write-Host '  [WhatIf] Re-run without -WhatIf to execute.' -ForegroundColor DarkYellow
            return
        }
    }

    # ==================================================================
    # STEP 2 - RESOLVE APP + CONNECT DELEGATED FOR PERMISSION ASSIGNMENT
    #
    # All permission assignment steps (Graph API, directory roles) require
    # elevated privileges that the target app itself may not have. Instead
    # of using app-only auth (which fails with 403 if the app lacks
    # AppRoleAssignment.ReadWrite.All), we use a single delegated admin
    # session for Steps 2-4. The admin's Global Administrator role
    # inherits the ability to grant any permission.
    # ==================================================================

    Write-Step 'Validating certificate...'

    if (-not $cert) {
        if (-not $IsWindows) {
            throw "Certificate '$CertificateThumbprint' cannot be looked up on this platform: the Windows certificate store is unavailable. Use -CreateNew to generate a PFX-backed certificate."
        }
        $cert = Get-Item "Cert:\CurrentUser\My\$CertificateThumbprint" -ErrorAction SilentlyContinue
    }
    if (-not $cert) {
        throw "Certificate '$CertificateThumbprint' not found in Cert:\CurrentUser\My."
    }
    Write-OK "Certificate: $($cert.Subject)  [Expires: $($cert.NotAfter.ToString('yyyy-MM-dd'))]"

    # Connect delegated for all Graph operations (Steps 2-4)
    if ($AdminUpn) {
        Write-Step "Connecting to Microsoft Graph (delegated as $AdminUpn)..."
        Write-Info 'Delegated session used for all Graph steps (permission grants + directory roles).'

        # MSAL_ALLOW_WAM = '0' workaround is critical -- without it,
        # Connect-MgGraph fails on some Windows machines where the WAM
        # broker intercepts the auth flow and causes silent failures.
        $prevWam = $env:MSAL_ALLOW_WAM
        $env:MSAL_ALLOW_WAM = '0'
        try {
            $graphScopes = @(
                'Application.ReadWrite.All'
                'AppRoleAssignment.ReadWrite.All'
                'RoleManagement.ReadWrite.Directory'
                'Directory.Read.All'
            )
            Connect-M365AssessGraphSession -TenantId $TenantId `
                -Scopes $graphScopes `
                -UseDeviceCode:$UseDeviceCode `
                -SignInProgressCallback $SignInProgressCallback `
                -Stage 'graph-permissions'
            $ctx = Get-MgContext
            Write-OK "Connected (delegated) as: $($ctx.Account)"
        }
        catch {
            throw "Delegated Graph connection failed: $($_.Exception.Message). Ensure the account has Global Administrator or Application Administrator rights."
        }
        finally {
            $env:MSAL_ALLOW_WAM = $prevWam
        }
    }
    else {
        # No AdminUpn -- fall back to app-only (will work only if app already has sufficient perms)
        Write-Step 'Connecting to Microsoft Graph (app-only, certificate)...'
        Write-Info 'No -AdminUpn provided. App-only session may lack permission to grant roles. Use -AdminUpn for full setup.'
        if ($certificatePath) {
            Connect-MgGraph -TenantId $TenantId -ClientId $ClientId -Certificate $cert -NoWelcome
        }
        else {
            Connect-MgGraph -TenantId $TenantId -ClientId $ClientId -CertificateThumbprint $CertificateThumbprint -NoWelcome
        }
        $ctx = Get-MgContext
        Write-OK "Connected (app-only) | AuthType: $($ctx.AuthType)"
    }

    # Resolve app and SP (works with either auth type)
    Write-Step 'Resolving App Registration and Service Principal...'

    $app = Get-MgApplication -Filter "appId eq '$ClientId'" -ErrorAction Stop
    if (-not $app) { throw "No application found with ClientId '$ClientId'." }
    $sp = Get-MgServicePrincipal -Filter "appId eq '$ClientId'" -ErrorAction Stop
    if (-not $sp)  { throw "Service principal not found for appId '$ClientId'." }

    Write-OK "App       : $($app.DisplayName)"
    Write-OK "AppId     : $($app.AppId)"
    Write-OK "SP Object : $($sp.Id)"

    $spDisplayName = $app.DisplayName

    # ==================================================================
    # STEP 3 - MICROSOFT GRAPH API PERMISSIONS
    # ==================================================================

    $graphResults = [System.Collections.Generic.List[PSCustomObject]]::new()

    if ($SkipGraph) {
        Write-Step 'Microsoft Graph permissions - SKIPPED (-SkipGraph specified)'
    }
    else {
        Write-Step "Adding Microsoft Graph API permissions ($($script:RequiredGraphPermissions.Count) across all sections)..."

        $graphSp = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'" -ErrorAction Stop
        Write-OK "Graph SP resolved (ObjectId: $($graphSp.Id))"

        $roleLookup = @{}
        foreach ($r in $graphSp.AppRoles) { $roleLookup[$r.Value] = $r.Id }

        $existingIds = @(
            Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -ErrorAction SilentlyContinue |
                Where-Object { $_.ResourceId -eq $graphSp.Id } |
                Select-Object -ExpandProperty AppRoleId
        )
        Write-OK "Existing Graph role assignments: $($existingIds.Count)"

        foreach ($perm in $script:RequiredGraphPermissions) {
            $name = $perm.Name

            if (-not $roleLookup.ContainsKey($name)) {
                Write-Fail "$name - not found in Microsoft Graph app roles"
                $graphResults.Add([PSCustomObject]@{ Permission = $name; Status = 'NotFound'; Sections = $perm.Sections })
                continue
            }

            $roleId = $roleLookup[$name]

            if ($existingIds -contains $roleId) {
                Write-Skip "$name - already assigned"
                $graphResults.Add([PSCustomObject]@{ Permission = $name; Status = 'AlreadyPresent'; Sections = $perm.Sections })
                continue
            }

            if ($PSCmdlet.ShouldProcess($app.DisplayName, "Add Graph permission: $name")) {
                try {
                    $roleBody = @{
                        PrincipalId = $sp.Id
                        ResourceId  = $graphSp.Id
                        AppRoleId   = $roleId
                    }
                    New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -BodyParameter $roleBody | Out-Null
                    Write-OK "$name  [$($perm.Sections)]"
                    $graphResults.Add([PSCustomObject]@{ Permission = $name; Status = 'Added'; Sections = $perm.Sections })
                }
                catch {
                    Write-Fail "$name - $($_.Exception.Message)"
                    $graphResults.Add([PSCustomObject]@{ Permission = $name; Status = 'Failed'; Error = $_.Exception.Message; Sections = $perm.Sections })
                }
            }
            else {
                Write-Host "    [WhatIf] Would add: $name  [$($perm.Sections)]" -ForegroundColor DarkYellow
                $graphResults.Add([PSCustomObject]@{ Permission = $name; Status = 'WhatIf'; Sections = $perm.Sections })
            }
        }

        Write-Info 'Admin consent granted automatically via role assignment (application-type permissions).'

        # --- Exchange.ManageAsApp (Office 365 Exchange Online API) ---
        # Required for app-only certificate auth to Exchange Online.
        # This is NOT a Graph permission -- it belongs to the EXO resource SP.
        Write-Step 'Adding Exchange.ManageAsApp permission for app-only EXO auth...'
        try {
            $exoResourceAppId = '00000002-0000-0ff1-ce00-000000000000'
            $exoSp = Get-MgServicePrincipal -Filter "appId eq '$exoResourceAppId'" -ErrorAction Stop
            $manageAsAppRole = $exoSp.AppRoles | Where-Object { $_.Value -eq 'Exchange.ManageAsApp' }
            if ($manageAsAppRole) {
                $sp = Get-MgServicePrincipal -Filter "appId eq '$ClientId'" -ErrorAction Stop
                $existingExoRoles = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -ErrorAction SilentlyContinue
                $alreadyAssigned = $existingExoRoles | Where-Object { $_.AppRoleId -eq $manageAsAppRole.Id -and $_.ResourceId -eq $exoSp.Id }
                if ($alreadyAssigned) {
                    Write-OK 'Exchange.ManageAsApp  [Email, Security]  (already assigned)'
                }
                elseif ($PSCmdlet.ShouldProcess('Exchange.ManageAsApp', 'Grant app role')) {
                    $roleBody = @{
                        PrincipalId = $sp.Id
                        ResourceId  = $exoSp.Id
                        AppRoleId   = $manageAsAppRole.Id
                    }
                    New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -BodyParameter $roleBody | Out-Null
                    Write-OK 'Exchange.ManageAsApp  [Email, Security]'
                }
            }
            else {
                Write-Warn 'Exchange.ManageAsApp role not found on EXO service principal'
            }
        }
        catch {
            Write-Warn "Could not assign Exchange.ManageAsApp: $_"
        }

        # --- Additional EXO API permissions (Organization.Read.All, MailboxSettings.Read) ---
        $additionalExoRoles = @('Organization.Read.All', 'MailboxSettings.Read')
        foreach ($roleName in $additionalExoRoles) {
            $role = $exoSp.AppRoles | Where-Object { $_.Value -eq $roleName }
            if ($role) {
                $alreadyAssigned = $existingExoRoles | Where-Object { $_.AppRoleId -eq $role.Id -and $_.ResourceId -eq $exoSp.Id }
                if ($alreadyAssigned) {
                    Write-OK "$roleName  [Email]  (already assigned)"
                }
                elseif ($PSCmdlet.ShouldProcess($roleName, 'Grant app role')) {
                    $roleBody = @{
                        PrincipalId = $sp.Id
                        ResourceId  = $exoSp.Id
                        AppRoleId   = $role.Id
                    }
                    New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -BodyParameter $roleBody | Out-Null
                    Write-OK "$roleName  [Email]"
                }
            }
        }

        # --- Purview.ApplicationAccess (Microsoft Purview API) ---
        # Required for app-only certificate auth to Security & Compliance (Connect-IPPSSession).
        Write-Step 'Adding Purview.ApplicationAccess permission for app-only Purview auth...'
        try {
            $purviewResourceAppId = '00000007-0000-0ff1-ce00-000000000000'
            $purviewSp = Get-MgServicePrincipal -Filter "appId eq '$purviewResourceAppId'" -ErrorAction Stop
            $purviewAppRole = $purviewSp.AppRoles | Where-Object { $_.Value -eq 'Purview.ApplicationAccess' }
            if ($purviewAppRole) {
                $sp = Get-MgServicePrincipal -Filter "appId eq '$ClientId'" -ErrorAction Stop
                $existingPurviewRoles = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -ErrorAction SilentlyContinue
                $alreadyAssigned = $existingPurviewRoles | Where-Object { $_.AppRoleId -eq $purviewAppRole.Id -and $_.ResourceId -eq $purviewSp.Id }
                if ($alreadyAssigned) {
                    Write-OK 'Purview.ApplicationAccess  [Security]  (already assigned)'
                }
                elseif ($PSCmdlet.ShouldProcess('Purview.ApplicationAccess', 'Grant app role')) {
                    $roleBody = @{
                        PrincipalId = $sp.Id
                        ResourceId  = $purviewSp.Id
                        AppRoleId   = $purviewAppRole.Id
                    }
                    New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -BodyParameter $roleBody | Out-Null
                    Write-OK 'Purview.ApplicationAccess  [Security]'
                }
            }
            else {
                Write-Warn 'Purview.ApplicationAccess role not found on Purview service principal'
            }
        }
        catch {
            Write-Warn "Could not assign Purview.ApplicationAccess: $_"
        }
    }

    # ==================================================================
    # STEP 4 - PURVIEW / COMPLIANCE ENTRA DIRECTORY ROLES
    #
    # Uses the same delegated Graph session from Step 2 -- no
    # reconnection needed. If running app-only (no AdminUpn), this
    # step is skipped.
    # ==================================================================

    $complianceResults = [System.Collections.Generic.List[PSCustomObject]]::new()

    if ($SkipComplianceRoles) {
        Write-Step 'Compliance directory roles - SKIPPED (-SkipComplianceRoles specified)'
    }
    elseif (-not $AdminUpn) {
        Write-Warn 'Compliance directory role assignment requires -AdminUpn (delegated Graph connection).'
        Write-Warn 'Skipping compliance roles step. Re-run with -AdminUpn to complete this step.'
        foreach ($roleDef in $script:RequiredComplianceRoles) {
            $complianceResults.Add([PSCustomObject]@{ Role = $roleDef.DisplayName; Status = 'Skipped'; Sections = $roleDef.Sections })
        }
    }
    else {
        # Reuses the delegated Graph session from Step 2 -- no reconnection needed
        Write-Step "Assigning Entra ID directory roles for compliance/security access ($($script:RequiredComplianceRoles.Count) roles)..."

        $graphBase = switch ((Get-MgContext).Environment) {
            'USGov'    { 'https://graph.microsoft.us' }
            'USGovDoD' { 'https://dod-graph.microsoft.us' }
            default    { 'https://graph.microsoft.com' }
        }

        foreach ($roleDef in $script:RequiredComplianceRoles) {
            $roleName       = $roleDef.DisplayName
            $roleTemplateId = $roleDef.TemplateId

            $dirRole = Get-MgDirectoryRole -Filter "roleTemplateId eq '$roleTemplateId'" -ErrorAction SilentlyContinue
            if (-not $dirRole) {
                if ($PSCmdlet.ShouldProcess($roleName, 'Activate directory role in tenant')) {
                    try {
                        $dirRole = New-MgDirectoryRole -BodyParameter @{ roleTemplateId = $roleTemplateId } -ErrorAction Stop
                        Write-Info "$roleName - activated in tenant"
                    }
                    catch {
                        Write-Fail "$roleName - could not activate role: $($_.Exception.Message)"
                        $complianceResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'Failed'; Error = $_.Exception.Message; Sections = $roleDef.Sections })
                        continue
                    }
                }
                else {
                    Write-Host "    [WhatIf] Would activate directory role: $roleName" -ForegroundColor DarkYellow
                    $complianceResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'WhatIf'; Sections = $roleDef.Sections })
                    continue
                }
            }

            $existingMembers = @(
                Get-MgDirectoryRoleMemberAsServicePrincipal -DirectoryRoleId $dirRole.Id -All -ErrorAction SilentlyContinue |
                    Select-Object -ExpandProperty Id
            )

            if ($existingMembers -contains $sp.Id) {
                Write-Skip "$roleName - already assigned"
                $complianceResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'AlreadyPresent'; Sections = $roleDef.Sections })
                continue
            }

            if ($PSCmdlet.ShouldProcess($roleName, "Assign to $spDisplayName")) {
                try {
                    $memberRef = @{
                        '@odata.id' = "$graphBase/v1.0/directoryObjects/$($sp.Id)"
                    }
                    New-MgDirectoryRoleMemberByRef -DirectoryRoleId $dirRole.Id -BodyParameter $memberRef -ErrorAction Stop
                    Write-OK "$roleName  [$($roleDef.Sections)]"
                    $complianceResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'Added'; Sections = $roleDef.Sections })
                }
                catch {
                    if ($_.Exception.Message -match 'already exist') {
                        Write-Skip "$roleName - already assigned (confirmed via error)"
                        $complianceResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'AlreadyPresent'; Sections = $roleDef.Sections })
                    }
                    else {
                        Write-Fail "$roleName - $($_.Exception.Message)"
                        $complianceResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'Failed'; Error = $_.Exception.Message; Sections = $roleDef.Sections })
                    }
                }
            }
            else {
                Write-Host "    [WhatIf] Would assign role: $roleName  [$($roleDef.Sections)]" -ForegroundColor DarkYellow
                $complianceResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'WhatIf'; Sections = $roleDef.Sections })
            }
        }
    }

    # Disconnect Graph (delegated session) before EXO step
    Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null

    # ==================================================================
    # STEP 5 - EXCHANGE ONLINE RBAC ROLE GROUPS (delegated -- platform
    #          requirement)
    #
    # Add-RoleGroupMember is not available in app-only EXO sessions.
    # A delegated admin credential is required for this step only.
    #
    # Role groups used:
    #   "View-Only Organization Management" -- the correct cloud-only
    #     EXO group that covers mailboxes, recipients, transport config,
    #     and EOP/Defender policies.
    #     ("View-Only Recipients" and "View-Only Configuration" are
    #      on-prem/hybrid only.)
    #   "Compliance Management" -- EXO-side compliance config reads.
    # ==================================================================

    $exoResults = [System.Collections.Generic.List[PSCustomObject]]::new()

    if ($SkipExchangeRbac) {
        Write-Step 'Exchange Online RBAC - SKIPPED (-SkipExchangeRbac specified)'
    }
    else {
        Write-Step "Connecting to Exchange Online (delegated as $AdminUpn)..."
        Write-Info 'Note: Add-RoleGroupMember requires a delegated session -- this is a platform constraint.'

        $exoConnected = $false
        try {
            Connect-M365AssessExchangeSession -TenantId $TenantId `
                -AdminUpn $AdminUpn `
                -UseDeviceCode:$UseDeviceCode `
                -SignInProgressCallback $SignInProgressCallback `
                -TimeoutSeconds $DeviceCodeTimeoutSeconds `
                -DeviceCodeTokenAcquirer $DeviceCodeTokenAcquirer
            Write-OK 'Connected to Exchange Online'
            $exoConnected = $true
        }
        catch {
            $connectionError = $_.Exception.Message
            Write-Fail "Connection failed: $connectionError"
            # A device code that expired or timed out is an operator-visible failure, not a
            # connectivity problem to skip past: report it and stop so the wizard can say so.
            if ($UseDeviceCode -and $connectionError -match 'onboard\.device_code_') {
                throw
            }
            Write-Warn 'Exchange Online RBAC step skipped. Resolve connectivity and re-run.'
        }

        if ($exoConnected) {
            # Exchange keeps its own pointer object for an Entra service principal. A freshly
            # created app is unknown to Add-RoleGroupMember until that object exists.
            try {
                $exoSp = Get-ServicePrincipal -Identity $sp.Id -ErrorAction Stop
            }
            catch {
                $exoSp = $null
            }
            if (-not $exoSp) {
                if ($PSCmdlet.ShouldProcess($spDisplayName, 'Register service principal in Exchange Online')) {
                    try {
                        New-ServicePrincipal -AppId $ClientId -ObjectId $sp.Id -DisplayName $spDisplayName -ErrorAction Stop | Out-Null
                        Write-OK "Registered '$spDisplayName' as an Exchange Online service principal"
                    }
                    catch {
                        Write-Warn "Could not register the service principal in Exchange Online: $($_.Exception.Message)"
                    }
                }
            }

            Write-Step "Adding '$spDisplayName' to Exchange Online role groups ($($script:RequiredExoRoleGroups.Count) groups)..."

            foreach ($entry in $script:RequiredExoRoleGroups) {
                $rg = $entry.RoleGroup

                $alreadyMember = $false
                try {
                    $members = @(Get-RoleGroupMember -Identity $rg -ErrorAction Stop | Select-Object -ExpandProperty Name)
                    if ($members -contains $spDisplayName) { $alreadyMember = $true }
                }
                catch {
                    Write-Warn "$rg - could not query members: $($_.Exception.Message)"
                }

                if ($alreadyMember) {
                    Write-Skip "$rg - already a member"
                    $exoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'AlreadyPresent'; Sections = $entry.Sections })
                    continue
                }

                if ($PSCmdlet.ShouldProcess($rg, "Add '$spDisplayName'")) {
                    try {
                        # A new service principal can take a while to appear in Exchange. Retry
                        # "couldn't find object" a few times, trying the display name then the object id.
                        $added = $false
                        for ($attempt = 1; -not $added; $attempt++) {
                            $member = if ($attempt % 2 -eq 1) { $spDisplayName } else { $sp.Id }
                            try {
                                Add-RoleGroupMember -Identity $rg -Member $member -ErrorAction Stop
                                $added = $true
                            }
                            catch {
                                if ($attempt -ge 6 -or -not (Test-ExoTransientObjectError -Message $_.Exception.Message)) { throw }
                                Write-Info "$rg - service principal not visible to Exchange yet; retrying in 15s ($attempt/5)"
                                Start-Sleep -Seconds 15
                            }
                        }
                        Write-OK "$rg  [$($entry.Sections)]"
                        $exoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'Added'; Sections = $entry.Sections })
                    }
                    catch {
                        # Gracefully handle "already a member" errors from EXO (non-terminating wording varies)
                        if ($_.Exception.Message -match 'already a member') {
                            Write-Skip "$rg - already a member (confirmed via error)"
                            $exoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'AlreadyPresent'; Sections = $entry.Sections })
                        }
                        else {
                            Write-Fail "$rg - $($_.Exception.Message)"
                            $exoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'Failed'; Error = $_.Exception.Message; Sections = $entry.Sections })
                        }
                    }
                }
                else {
                    Write-Host "    [WhatIf] Would add '$spDisplayName' to EXO role group: $rg  [$($entry.Sections)]" -ForegroundColor DarkYellow
                    $exoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'WhatIf'; Sections = $entry.Sections })
                }
            }

            Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
            Write-Info 'Disconnected from Exchange Online'
        }
    }

    # ==================================================================
    # STEP 6 - OPERATOR APP REGISTRATION (OPT-IN WRITE ACCESS, T-0917)
    #
    # The reader app configured above is never granted a write permission.
    # When -IncludeWritePermissions is passed, a second app registration
    # (default 'M365-Assess-Operator') is created or updated with the same
    # certificate and only the selected write groups. Directory roles and
    # EXO role groups are assigned only when the 'exchange' group is selected.
    # ==================================================================

    $operatorGraphResults = [System.Collections.Generic.List[PSCustomObject]]::new()
    $operatorDirectoryResults = [System.Collections.Generic.List[PSCustomObject]]::new()
    $operatorExoResults = [System.Collections.Generic.List[PSCustomObject]]::new()
    $operatorClientId = $null
    $operatorCertificateThumbprint = $null
    $operatorCertificatePath = $null
    $operatorCreated = $false
    $operatorSp = $null

    if ($IncludeWritePermissions) {
        $certSubject = "CN=M365-Assess-$TenantId"
        $operatorKeyCredential = @{
            Type          = 'AsymmetricX509Cert'
            Usage         = 'Verify'
            Key           = $cert.RawData
            DisplayName   = $certSubject
            StartDateTime = $cert.NotBefore.ToUniversalTime().ToString('o')
            EndDateTime   = $cert.NotAfter.ToUniversalTime().ToString('o')
        }

        if ($WhatIfPreference) {
            Write-Step "[WhatIf] Would create or update operator app registration '$OperatorAppDisplayName'"
            Write-Host "    [WhatIf] Groups: $(@($operatorSelection.Groups) -join ', ')" -ForegroundColor DarkYellow
            foreach ($permission in @($operatorSelection.GraphPermissions)) {
                Write-Host "    [WhatIf] Would add Graph permission: $permission" -ForegroundColor DarkYellow
            }
            foreach ($role in @($operatorSelection.ExchangeAppRoles)) {
                Write-Host "    [WhatIf] Would add Exchange app role: $role" -ForegroundColor DarkYellow
            }
            foreach ($role in @($operatorSelection.DirectoryRoles)) {
                Write-Host "    [WhatIf] Would assign directory role: $role" -ForegroundColor DarkYellow
            }
            foreach ($rg in @($operatorSelection.ExoRoleGroups)) {
                Write-Host "    [WhatIf] Would add operator service principal to EXO role group: $rg" -ForegroundColor DarkYellow
            }
            $operatorClientId = '<planned>'
            $operatorCertificateThumbprint = $CertificateThumbprint
            $operatorCertificatePath = $certificatePath
        }
        else {
            Write-Step "Provisioning operator app registration '$OperatorAppDisplayName'..."
            Write-Info 'The operator app reuses the certificate generated or selected for the reader app.'

            $prevWam = $env:MSAL_ALLOW_WAM
            $env:MSAL_ALLOW_WAM = '0'
            try {
                Connect-M365AssessGraphSession -TenantId $TenantId `
                    -Scopes @(
                        'Application.ReadWrite.All'
                        'AppRoleAssignment.ReadWrite.All'
                        'RoleManagement.ReadWrite.Directory'
                        'Directory.Read.All'
                    ) `
                    -UseDeviceCode:$UseDeviceCode `
                    -SignInProgressCallback $SignInProgressCallback `
                    -Stage 'graph-operator'
                $operatorCtx = Get-MgContext
                Write-OK "Connected (delegated) as: $($operatorCtx.Account)"
            }
            catch {
                throw "Delegated Graph connection failed while provisioning the operator app: $($_.Exception.Message)"
            }
            finally {
                $env:MSAL_ALLOW_WAM = $prevWam
            }

            $existingOperator = @(Get-MgApplication -Filter "displayName eq '$OperatorAppDisplayName'" -ErrorAction Stop) |
                Select-Object -First 1
            if (-not $existingOperator) {
                if ($PSCmdlet.ShouldProcess($OperatorAppDisplayName, 'Create operator app registration')) {
                    $newOperatorApp = New-MgApplication -DisplayName $OperatorAppDisplayName -SignInAudience 'AzureADMyOrg' -KeyCredentials @($operatorKeyCredential) -ErrorAction Stop
                    $operatorClientId = $newOperatorApp.AppId
                    $operatorCreated = $true
                    Write-OK "Operator app created: $OperatorAppDisplayName"
                    Write-OK "Operator client id: $operatorClientId"
                    $operatorSp = New-MgServicePrincipal -AppId $operatorClientId -ErrorAction Stop
                    Write-OK "Operator service principal created (ObjectId: $($operatorSp.Id))"
                }
            }
            else {
                $operatorClientId = $existingOperator.AppId
                Write-Skip "Operator app already exists: $OperatorAppDisplayName ($operatorClientId)"
                $hasOperatorKey = @($existingOperator.KeyCredentials | Where-Object { $_.DisplayName -eq $certSubject }).Count -gt 0
                if (-not $hasOperatorKey) {
                    if ($PSCmdlet.ShouldProcess($OperatorAppDisplayName, 'Upload the reader certificate to the operator app')) {
                        $existingKeys = @($existingOperator.KeyCredentials | Where-Object { $_ })
                        $mergedKeys = $existingKeys + @($operatorKeyCredential)
                        Update-MgApplication -ApplicationId $existingOperator.Id -KeyCredentials $mergedKeys -ErrorAction Stop
                        Write-OK "Uploaded certificate $CertificateThumbprint to the operator app"
                    }
                }
                else {
                    Write-Skip "Operator app already trusts certificate $CertificateThumbprint"
                }
                $operatorSp = Get-MgServicePrincipal -Filter "appId eq '$operatorClientId'" -ErrorAction Stop
                if (-not $operatorSp) {
                    if ($PSCmdlet.ShouldProcess($OperatorAppDisplayName, 'Create operator service principal')) {
                        $operatorSp = New-MgServicePrincipal -AppId $operatorClientId -ErrorAction Stop
                        Write-OK "Operator service principal created (ObjectId: $($operatorSp.Id))"
                    }
                }
            }

            if (-not $operatorSp) {
                throw "Operator service principal could not be resolved for app id '$operatorClientId' (code: consent.operator_sp_missing)."
            }

            $operatorCertificateThumbprint = $CertificateThumbprint
            $operatorCertificatePath = $certificatePath

            # --- Selected Graph application permissions ---
            $operatorGraphRoleNames = @{}
            if ($SkipGraph) {
                Write-Step 'Operator Graph permissions - SKIPPED (-SkipGraph specified)'
            }
            elseif (@($operatorSelection.GraphPermissions).Count -gt 0 -or $ReplaceWriteGroups) {
                if (@($operatorSelection.GraphPermissions).Count -gt 0) {
                    Write-Step "Adding operator Graph permissions ($(@($operatorSelection.GraphPermissions).Count))..."
                }
                $graphSp = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'" -ErrorAction Stop
                $roleLookup = @{}
                foreach ($role in $graphSp.AppRoles) {
                    $roleLookup[$role.Value] = $role.Id
                    $operatorGraphRoleNames[[string]$role.Id] = $role.Value
                }
                $existingOperatorGraphIds = @(
                    Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $operatorSp.Id -ErrorAction SilentlyContinue |
                        Where-Object { $_.ResourceId -eq $graphSp.Id } |
                        Select-Object -ExpandProperty AppRoleId
                )
                foreach ($permission in @($operatorSelection.GraphPermissions)) {
                    if (-not $roleLookup.ContainsKey($permission)) {
                        Write-Fail "$permission - not found in Microsoft Graph app roles"
                        $operatorGraphResults.Add([PSCustomObject]@{ Permission = $permission; Status = 'NotFound' })
                        continue
                    }
                    $roleId = $roleLookup[$permission]
                    if ($existingOperatorGraphIds -contains $roleId) {
                        Write-Skip "$permission - already assigned"
                        $operatorGraphResults.Add([PSCustomObject]@{ Permission = $permission; Status = 'AlreadyPresent' })
                        continue
                    }
                    if ($PSCmdlet.ShouldProcess($OperatorAppDisplayName, "Add Graph permission: $permission")) {
                        try {
                            New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $operatorSp.Id -BodyParameter @{
                                PrincipalId = $operatorSp.Id
                                ResourceId  = $graphSp.Id
                                AppRoleId   = $roleId
                            } | Out-Null
                            Write-OK $permission
                            $operatorGraphResults.Add([PSCustomObject]@{ Permission = $permission; Status = 'Added' })
                        }
                        catch {
                            Write-Fail "$permission - $($_.Exception.Message)"
                            $operatorGraphResults.Add([PSCustomObject]@{ Permission = $permission; Status = 'Failed'; Error = $_.Exception.Message })
                        }
                    }
                    else {
                        Write-Host "    [WhatIf] Would add: $permission" -ForegroundColor DarkYellow
                        $operatorGraphResults.Add([PSCustomObject]@{ Permission = $permission; Status = 'WhatIf' })
                    }
                }

                # Reconciliation: remove managed Graph app roles that are no
                # longer selected. Unrelated assignments are left untouched.
                if ($ReplaceWriteGroups) {
                    Write-Step 'Reconciling operator Graph permissions to the selected write groups...'
                    $currentGraphAssignments = @(
                        Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $operatorSp.Id -ErrorAction SilentlyContinue |
                            Where-Object { $_.ResourceId -eq $graphSp.Id }
                    )
                    foreach ($assignment in $currentGraphAssignments) {
                        $roleId = [string]$assignment.AppRoleId
                        if (-not $roleId -or -not $operatorGraphRoleNames.ContainsKey($roleId)) { continue }
                        $name = [string]$operatorGraphRoleNames[$roleId]
                        if ($operatorManagedGraphPermissions -notcontains $name) { continue }
                        if (@($operatorSelection.GraphPermissions) -contains $name) { continue }
                        if ($PSCmdlet.ShouldProcess($OperatorAppDisplayName, "Remove Graph permission: $name")) {
                            try {
                                Remove-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $operatorSp.Id -AppRoleAssignmentId $assignment.Id -ErrorAction Stop
                                Write-OK "Removed $name"
                                $operatorGraphResults.Add([PSCustomObject]@{ Permission = $name; Status = 'Removed' })
                            }
                            catch {
                                Write-Fail "Removing $name - $($_.Exception.Message)"
                                $operatorGraphResults.Add([PSCustomObject]@{ Permission = $name; Status = 'Failed'; Error = $_.Exception.Message })
                            }
                        }
                        else {
                            Write-Host "    [WhatIf] Would remove: $name" -ForegroundColor DarkYellow
                            $operatorGraphResults.Add([PSCustomObject]@{ Permission = $name; Status = 'WhatIf' })
                        }
                    }
                }
            }

            # --- Exchange Online app roles (Exchange.ManageAsApp etc.) ---
            if (@($operatorSelection.ExchangeAppRoles).Count -gt 0) {
                Write-Step 'Adding Exchange app roles to the operator app...'
                try {
                    $exoResourceAppId = '00000002-0000-0ff1-ce00-000000000000'
                    $exoSp = Get-MgServicePrincipal -Filter "appId eq '$exoResourceAppId'" -ErrorAction Stop
                    $existingOperatorExo = @(Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $operatorSp.Id -ErrorAction SilentlyContinue)
                    foreach ($roleName in @($operatorSelection.ExchangeAppRoles)) {
                        $role = $exoSp.AppRoles | Where-Object { $_.Value -eq $roleName }
                        if (-not $role) {
                            Write-Warn "$roleName role not found on the Exchange service principal"
                            continue
                        }
                        $already = $existingOperatorExo | Where-Object { $_.AppRoleId -eq $role.Id -and $_.ResourceId -eq $exoSp.Id }
                        if ($already) {
                            Write-Skip "$roleName - already assigned"
                            continue
                        }
                        if ($PSCmdlet.ShouldProcess($roleName, 'Grant Exchange app role to operator app')) {
                            New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $operatorSp.Id -BodyParameter @{
                                PrincipalId = $operatorSp.Id
                                ResourceId  = $exoSp.Id
                                AppRoleId   = $role.Id
                            } | Out-Null
                            Write-OK $roleName
                        }
                    }
                }
                catch {
                    Write-Warn "Could not assign Exchange app roles to the operator app: $_"
                }
            }

            # --- Reconciliation of Exchange and Purview app roles ---
            # The write matrix owns Exchange.ManageAsApp, its read companions, and
            # Purview.ApplicationAccess. Remove only those on the operator app when
            # they are no longer selected; never touch another resource's grants.
            if ($ReplaceWriteGroups) {
                Write-Step 'Reconciling operator Exchange and Purview app roles...'
                $operatorAppRoleAssignments = @(
                    Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $operatorSp.Id -ErrorAction SilentlyContinue
                )
                $appRoleResources = @(
                    @{
                        AppId    = '00000002-0000-0ff1-ce00-000000000000'
                        Label    = 'Exchange'
                        Managed  = @($operatorManagedExchangeAppRoles)
                        Selected = @($operatorSelection.ExchangeAppRoles)
                    }
                    @{
                        AppId    = '00000007-0000-0ff1-ce00-000000000000'
                        Label    = 'Purview'
                        Managed  = @($operatorManagedPurviewAppRoles)
                        Selected = @()
                    }
                )
                foreach ($resource in $appRoleResources) {
                    if (@($resource.Managed).Count -eq 0) { continue }
                    try {
                        $resourceSp = Get-MgServicePrincipal -Filter "appId eq '$($resource.AppId)'" -ErrorAction Stop
                    }
                    catch {
                        Write-Warn "Could not resolve the $($resource.Label) service principal to reconcile its app roles: $($_.Exception.Message)"
                        continue
                    }
                    if (-not $resourceSp) { continue }
                    $resourceRoleNames = @{}
                    foreach ($role in $resourceSp.AppRoles) { $resourceRoleNames[[string]$role.Id] = $role.Value }
                    $currentAssignments = @(
                        $operatorAppRoleAssignments | Where-Object { $_.ResourceId -eq $resourceSp.Id }
                    )
                    foreach ($assignment in $currentAssignments) {
                        $roleId = [string]$assignment.AppRoleId
                        if (-not $roleId -or -not $resourceRoleNames.ContainsKey($roleId)) { continue }
                        $name = [string]$resourceRoleNames[$roleId]
                        if (@($resource.Managed) -notcontains $name) { continue }
                        if (@($resource.Selected) -contains $name) { continue }
                        if ($PSCmdlet.ShouldProcess($OperatorAppDisplayName, "Remove $($resource.Label) app role: $name")) {
                            try {
                                Remove-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $operatorSp.Id -AppRoleAssignmentId $assignment.Id -ErrorAction Stop
                                Write-OK "Removed $name ($($resource.Label))"
                                $operatorGraphResults.Add([PSCustomObject]@{ Permission = $name; Status = 'Removed' })
                            }
                            catch {
                                Write-Fail "Removing $name ($($resource.Label)) - $($_.Exception.Message)"
                                $operatorGraphResults.Add([PSCustomObject]@{ Permission = $name; Status = 'Failed'; Error = $_.Exception.Message })
                            }
                        }
                        else {
                            Write-Host "    [WhatIf] Would remove $($resource.Label) app role: $name" -ForegroundColor DarkYellow
                            $operatorGraphResults.Add([PSCustomObject]@{ Permission = $name; Status = 'WhatIf' })
                        }
                    }
                }
            }

            # --- Exchange / Purview / Teams directory roles (exchange group only) ---
            foreach ($roleName in @($operatorSelection.DirectoryRoles)) {
                $templateId = $script:OperatorDirectoryRoleTemplates[$roleName]
                if (-not $templateId) {
                    Write-Warn "No built-in role template is known for '$roleName'"
                    $operatorDirectoryResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'NotFound' })
                    continue
                }
                $dirRole = Get-MgDirectoryRole -Filter "roleTemplateId eq '$templateId'" -ErrorAction SilentlyContinue
                if (-not $dirRole) {
                    if ($PSCmdlet.ShouldProcess($roleName, 'Activate directory role in tenant')) {
                        try {
                            $dirRole = New-MgDirectoryRole -BodyParameter @{ roleTemplateId = $templateId } -ErrorAction Stop
                            Write-Info "$roleName - activated in tenant"
                        }
                        catch {
                            Write-Fail "$roleName - could not activate role: $($_.Exception.Message)"
                            $operatorDirectoryResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'Failed'; Error = $_.Exception.Message })
                            continue
                        }
                    }
                    else {
                        Write-Host "    [WhatIf] Would activate directory role: $roleName" -ForegroundColor DarkYellow
                        $operatorDirectoryResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'WhatIf' })
                        continue
                    }
                }

                $existingMembers = @(
                    Get-MgDirectoryRoleMemberAsServicePrincipal -DirectoryRoleId $dirRole.Id -All -ErrorAction SilentlyContinue |
                        Select-Object -ExpandProperty Id
                )
                if ($existingMembers -contains $operatorSp.Id) {
                    Write-Skip "$roleName - already assigned to the operator app"
                    $operatorDirectoryResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'AlreadyPresent' })
                    continue
                }

                if ($PSCmdlet.ShouldProcess($roleName, "Assign to $OperatorAppDisplayName")) {
                    try {
                        $graphBase = switch ((Get-MgContext).Environment) {
                            'USGov'    { 'https://graph.microsoft.us' }
                            'USGovDoD' { 'https://dod-graph.microsoft.us' }
                            default    { 'https://graph.microsoft.com' }
                        }
                        New-MgDirectoryRoleMemberByRef -DirectoryRoleId $dirRole.Id -BodyParameter @{
                            '@odata.id' = "$graphBase/v1.0/directoryObjects/$($operatorSp.Id)"
                        } -ErrorAction Stop
                        Write-OK "$roleName (operator app)"
                        $operatorDirectoryResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'Added' })
                    }
                    catch {
                        if ($_.Exception.Message -match 'already exist') {
                            Write-Skip "$roleName - already assigned (confirmed via error)"
                            $operatorDirectoryResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'AlreadyPresent' })
                        }
                        else {
                            Write-Fail "$roleName - $($_.Exception.Message)"
                            $operatorDirectoryResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'Failed'; Error = $_.Exception.Message })
                        }
                    }
                }
                else {
                    Write-Host "    [WhatIf] Would assign directory role: $roleName" -ForegroundColor DarkYellow
                    $operatorDirectoryResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'WhatIf' })
                }
            }

            # --- Reconciliation of managed directory roles ---
            if ($ReplaceWriteGroups) {
                Write-Step 'Reconciling operator directory roles to the selected write groups...'
                # Managed roles that are not selected, plus roles an earlier version assigned
                # by mistake, which are always removed (T-0958).
                $reconcileRoles = @{}
                foreach ($entry in $script:OperatorDirectoryRoleTemplates.GetEnumerator()) { $reconcileRoles[$entry.Key] = $entry.Value }
                foreach ($entry in $script:OperatorRetiredDirectoryRoleTemplates.GetEnumerator()) { $reconcileRoles[$entry.Key] = $entry.Value }
                foreach ($roleName in @($reconcileRoles.Keys)) {
                    if (@($operatorSelection.DirectoryRoles) -contains $roleName) { continue }
                    $templateId = $reconcileRoles[$roleName]
                    $dirRole = Get-MgDirectoryRole -Filter "roleTemplateId eq '$templateId'" -ErrorAction SilentlyContinue
                    if (-not $dirRole) { continue }
                    $existingMembers = @(
                        Get-MgDirectoryRoleMemberAsServicePrincipal -DirectoryRoleId $dirRole.Id -All -ErrorAction SilentlyContinue |
                            Select-Object -ExpandProperty Id
                    )
                    if ($existingMembers -notcontains $operatorSp.Id) { continue }
                    if ($PSCmdlet.ShouldProcess($OperatorAppDisplayName, "Remove directory role: $roleName")) {
                        try {
                            Remove-MgDirectoryRoleMemberByRef -DirectoryRoleId $dirRole.Id -DirectoryObjectId $operatorSp.Id -ErrorAction Stop
                            Write-OK "Removed $roleName"
                            $operatorDirectoryResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'Removed' })
                        }
                        catch {
                            Write-Fail "Removing $roleName - $($_.Exception.Message)"
                            $operatorDirectoryResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'Failed'; Error = $_.Exception.Message })
                        }
                    }
                    else {
                        Write-Host "    [WhatIf] Would remove directory role: $roleName" -ForegroundColor DarkYellow
                        $operatorDirectoryResults.Add([PSCustomObject]@{ Role = $roleName; Status = 'WhatIf' })
                    }
                }
            }

            Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null

            # --- Exchange Online role groups (exchange group only) ---
            # A replace run connects even when no EXO group is selected so it can
            # remove the managed groups that are no longer selected.
            if (@($operatorSelection.ExoRoleGroups).Count -gt 0 -or $ReplaceWriteGroups) {
                if ($SkipExchangeRbac) {
                    Write-Step 'Operator Exchange Online RBAC - SKIPPED (-SkipExchangeRbac specified)'
                    foreach ($rg in @($operatorSelection.ExoRoleGroups)) {
                        $operatorExoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'Skipped' })
                    }
                }
                else {
                    if (@($operatorSelection.ExoRoleGroups).Count -gt 0) {
                        Write-Step "Adding the operator app to Exchange Online role groups..."
                    }
                    else {
                        Write-Step 'Reconciling operator Exchange Online role groups...'
                    }
                    $operatorExoConnected = $false
                    try {
                        Connect-M365AssessExchangeSession -TenantId $TenantId `
                            -AdminUpn $AdminUpn `
                            -UseDeviceCode:$UseDeviceCode `
                            -SignInProgressCallback $SignInProgressCallback `
                            -TimeoutSeconds $DeviceCodeTimeoutSeconds `
                            -DeviceCodeTokenAcquirer $DeviceCodeTokenAcquirer
                        $operatorExoConnected = $true
                    }
                    catch {
                        $operatorConnectionError = $_.Exception.Message
                        Write-Fail "Connection failed: $operatorConnectionError"
                        if ($UseDeviceCode -and $operatorConnectionError -match 'onboard\.device_code_') {
                            throw
                        }
                    }

                    if ($operatorExoConnected) {
                        try {
                            $exoSp = Get-ServicePrincipal -Identity $operatorSp.Id -ErrorAction Stop
                        }
                        catch {
                            $exoSp = $null
                        }
                        if (-not $exoSp -and $PSCmdlet.ShouldProcess($OperatorAppDisplayName, 'Register service principal in Exchange Online')) {
                            try {
                                New-ServicePrincipal -AppId $operatorClientId -ObjectId $operatorSp.Id -DisplayName $OperatorAppDisplayName -ErrorAction Stop | Out-Null
                                Write-OK "Registered '$OperatorAppDisplayName' as an Exchange Online service principal"
                            }
                            catch {
                                Write-Warn "Could not register the operator service principal in Exchange Online: $($_.Exception.Message)"
                            }
                        }

                        foreach ($rg in @($operatorSelection.ExoRoleGroups)) {
                            $alreadyMember = $false
                            try {
                                $members = @(Get-RoleGroupMember -Identity $rg -ErrorAction Stop | Select-Object -ExpandProperty Name)
                                if ($members -contains $OperatorAppDisplayName) { $alreadyMember = $true }
                            }
                            catch {
                                Write-Warn "$rg - could not query members: $($_.Exception.Message)"
                            }
                            if ($alreadyMember) {
                                Write-Skip "$rg - already a member"
                                $operatorExoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'AlreadyPresent' })
                                continue
                            }
                            if ($PSCmdlet.ShouldProcess($rg, "Add '$OperatorAppDisplayName'")) {
                                try {
                                    $added = $false
                                    for ($attempt = 1; -not $added; $attempt++) {
                                        $member = if ($attempt % 2 -eq 1) { $OperatorAppDisplayName } else { $operatorSp.Id }
                                        try {
                                            Add-RoleGroupMember -Identity $rg -Member $member -ErrorAction Stop
                                            $added = $true
                                        }
                                        catch {
                                            if ($attempt -ge 6 -or -not (Test-ExoTransientObjectError -Message $_.Exception.Message)) { throw }
                                            Write-Info "$rg - operator service principal not visible to Exchange yet; retrying in 15s ($attempt/5)"
                                            Start-Sleep -Seconds 15
                                        }
                                    }
                                    Write-OK "$rg (operator app)"
                                    $operatorExoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'Added' })
                                }
                                catch {
                                    $exoMessage = $_.Exception.Message
                                    if ($exoMessage -match 'already a member') {
                                        Write-Skip "$rg - already a member (confirmed via error)"
                                        $operatorExoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'AlreadyPresent' })
                                    }
                                    else {
                                        # The operator app already has the Entra directory role of the
                                        # same name, which is the app-only authorization surface. A
                                        # stale Exchange DC that cannot resolve the EXO role group must
                                        # not block write access; record it and let onboarding finish.
                                        $entraRoleAssigned = @(
                                            $operatorDirectoryResults | Where-Object {
                                                $_.Role -eq $rg -and $_.Status -in @('Added', 'AlreadyPresent')
                                            }
                                        ).Count -gt 0
                                        if (Test-ExoPartnerManagedRoleGroupError -Message $exoMessage) {
                                            if ($entraRoleAssigned) {
                                                Write-Warn "$rg - Exchange role group is partner-managed and cannot be changed; the Entra '$rg' directory role is assigned, so app-only writes can proceed."
                                                $operatorExoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'Warning'; Error = $exoMessage })
                                            }
                                            else {
                                                $action = "The Exchange role group '$rg' is partner-managed and cannot be changed. Assign the Entra '$rg' directory role to the operator app (or use the partner's GDAP role), then retry."
                                                Write-Fail "$rg - $action"
                                                $operatorExoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'Failed'; Error = $action })
                                            }
                                        }
                                        elseif ($entraRoleAssigned -and (Test-ExoTransientObjectError -Message $exoMessage)) {
                                            Write-Warn "$rg - Exchange role group is not resolvable on this DC yet; the Entra '$rg' directory role is assigned, so app-only writes can proceed. Re-run onboarding later to add the EXO role group."
                                            $operatorExoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'Warning'; Error = $exoMessage })
                                        }
                                        else {
                                            Write-Fail "$rg - $exoMessage"
                                            $operatorExoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'Failed'; Error = $exoMessage })
                                        }
                                    }
                                }
                            }
                            else {
                                Write-Host "    [WhatIf] Would add the operator app to EXO role group: $rg" -ForegroundColor DarkYellow
                                $operatorExoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'WhatIf' })
                            }
                        }

                        # Reconciliation: remove managed EXO role-group memberships
                        # that are no longer selected. Only matrix groups are touched.
                        if ($ReplaceWriteGroups) {
                            foreach ($rg in @($operatorManagedExoRoleGroups)) {
                                if (@($operatorSelection.ExoRoleGroups) -contains $rg) { continue }
                                $isMember = $false
                                try {
                                    $memberObjects = @(Get-RoleGroupMember -Identity $rg -ErrorAction Stop)
                                    $memberKeys = @(
                                        foreach ($member in $memberObjects) {
                                            if ($member.Name) { [string]$member.Name }
                                            if ($member.Id) { [string]$member.Id }
                                        }
                                    )
                                    $isMember = $memberKeys -contains $OperatorAppDisplayName -or $memberKeys -contains $operatorSp.Id
                                }
                                catch {
                                    Write-Warn "$rg - could not query members: $($_.Exception.Message)"
                                }
                                if (-not $isMember) { continue }

                                if ($PSCmdlet.ShouldProcess($rg, "Remove '$OperatorAppDisplayName'")) {
                                    try {
                                        try {
                                            Remove-RoleGroupMember -Identity $rg -Member $OperatorAppDisplayName -ErrorAction Stop
                                        }
                                        catch {
                                            Remove-RoleGroupMember -Identity $rg -Member $operatorSp.Id -ErrorAction Stop
                                        }
                                        Write-OK "Removed operator from $rg"
                                        $operatorExoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'Removed' })
                                    }
                                    catch {
                                        Write-Fail "Removing operator from $rg - $($_.Exception.Message)"
                                        $operatorExoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'Failed'; Error = $_.Exception.Message })
                                    }
                                }
                                else {
                                    Write-Host "    [WhatIf] Would remove the operator app from EXO role group: $rg" -ForegroundColor DarkYellow
                                    $operatorExoResults.Add([PSCustomObject]@{ RoleGroup = $rg; Status = 'WhatIf' })
                                }
                            }
                        }

                        Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
                        Write-Info 'Disconnected from Exchange Online'
                    }
                }
            }
        }
    }

    # ==================================================================
    # FINAL SUMMARY
    # ==================================================================

    Write-Banner -Title 'Configuration Summary'

    Write-Host "  App Registration : $($app.DisplayName)" -ForegroundColor White
    Write-Host "  AppId            : $($app.AppId)"        -ForegroundColor White
    Write-Host "  Tenant           : $TenantId"            -ForegroundColor White
    Write-Host ''

    if (-not $SkipGraph)           { Write-StepSummary -Label 'Microsoft Graph API Permissions'      -Results $graphResults      -ItemField 'Permission' }
    if (-not $SkipComplianceRoles) { Write-StepSummary -Label 'Entra ID Compliance / Security Roles' -Results $complianceResults -ItemField 'Role'       }
    if (-not $SkipExchangeRbac)    { Write-StepSummary -Label 'Exchange Online RBAC Role Groups'     -Results $exoResults        -ItemField 'RoleGroup'  }

    if ($IncludeWritePermissions) {
        Write-Host "  Operator App     : $OperatorAppDisplayName"  -ForegroundColor White
        Write-Host "  Operator AppId   : $operatorClientId"         -ForegroundColor White
        Write-Host "  Write Groups     : $(@($operatorSelection.Groups) -join ', ')" -ForegroundColor White
        Write-Host ''
        if (-not $SkipGraph) {
            Write-StepSummary -Label 'Operator Graph API Permissions' -Results $operatorGraphResults -ItemField 'Permission'
        }
        if (@($operatorDirectoryResults).Count -gt 0) {
            Write-StepSummary -Label 'Operator Directory Roles' -Results $operatorDirectoryResults -ItemField 'Role'
        }
        if (@($operatorExoResults).Count -gt 0) {
            Write-StepSummary -Label 'Operator Exchange Online RBAC Role Groups' -Results $operatorExoResults -ItemField 'RoleGroup'
        }
    }

    $totalFailed = (
        @($graphResults      | Where-Object { $_.Status -in 'Failed', 'NotFound' }).Count +
        @($complianceResults | Where-Object { $_.Status -eq 'Failed' }).Count +
        @($exoResults        | Where-Object { $_.Status -eq 'Failed' }).Count +
        @($operatorGraphResults | Where-Object { $_.Status -in 'Failed', 'NotFound' }).Count +
        @($operatorDirectoryResults | Where-Object { $_.Status -eq 'Failed' }).Count +
        @($operatorExoResults | Where-Object { $_.Status -eq 'Failed' }).Count
    )

    if ($WhatIfPreference) {
        Write-Host '  *** WhatIf run complete. No changes were made. ***' -ForegroundColor Yellow
        Write-Host '      Re-run without -WhatIf to apply the changes shown above.' -ForegroundColor DarkGray
    }
    elseif ($totalFailed -gt 0) {
        Write-Host '  Configuration completed with errors.' -ForegroundColor Yellow
        Write-Host '  Review failures above and re-run -- already-present items are skipped automatically.' -ForegroundColor DarkGray
    }
    else {
        Write-Host '  All permissions configured successfully.' -ForegroundColor Green
        Write-Host '  The app registration is ready for use with Invoke-M365Assessment.' -ForegroundColor Green
    }

    if ($bootstrapCreated) {
        Write-Host ''
        Write-Banner -Title 'New App Registration Details'
        Write-Host "  App Display Name         : $AppDisplayName"          -ForegroundColor Green
        Write-Host "  Application (Client) ID  : $ClientId"               -ForegroundColor Green
        Write-Host "  Certificate Thumbprint   : $CertificateThumbprint"  -ForegroundColor Green
        Write-Host "  Certificate Subject      : CN=M365-Assess-$TenantId" -ForegroundColor White
        Write-Host "  Certificate Expires      : $($cert.NotAfter.ToString('yyyy-MM-dd'))" -ForegroundColor White
        Write-Host "  Public Key Exported      : $cerPath"                -ForegroundColor White
        Write-Host ''
        Write-Host '  Run the assessment with:' -ForegroundColor Cyan
        Write-Host ''
        Write-Host "    Invoke-M365Assessment -TenantId '$TenantId'" -ForegroundColor Yellow
        Write-Host ''
        Write-Host '  Credentials are saved automatically and will be used by the assessment.' -ForegroundColor DarkGray
        Write-Host ''
    }

    # ------------------------------------------------------------------
    # Save credentials to connection profile
    # ------------------------------------------------------------------
    # Connection profiles are thumbprint-based; a PFX-backed certificate has no store entry to
    # point at, so the portal credential store holds it instead.
    if ($ClientId -and $CertificateThumbprint -and -not $certificatePath -and -not $WhatIfPreference) {
        $profileHelper = Join-Path $PSScriptRoot 'Save-M365ConnectionProfile.ps1'
        if (Test-Path -Path $profileHelper) {
            . $profileHelper
            # Get-M365ConnectionProfile lives in its own file. The module loads both, but a
            # standalone dot-source of this script (the portal onboarding worker) does not.
            . (Join-Path $PSScriptRoot 'Get-M365ConnectionProfile.ps1')

            # Derive tenant prefix for naming
            $tenantPrefix = if ($TenantId -match '^([^.]+)\.onmicrosoft\.(com|us)$') {
                $Matches[1]
            }
            elseif ($TenantId -match '^([^.]+)\.') {
                $Matches[1]
            }
            else {
                $TenantId
            }

            # Check for existing profile matching this TenantId -- update it instead of creating a duplicate
            $existingProfiles = @(Get-M365ConnectionProfile -ErrorAction SilentlyContinue)
            $existingMatch = $existingProfiles | Where-Object { $_.TenantId -eq $TenantId } | Select-Object -First 1

            $resolvedProfileName = if ($ProfileName) {
                $ProfileName
            }
            elseif ($existingMatch) {
                $existingMatch.Name
            }
            else {
                "$tenantPrefix-AppReg"
            }

            $appName = if ($AppDisplayName) { $AppDisplayName }
                       elseif ($app) { $app.DisplayName }
                       else { '' }

            $profileParams = @{
                ProfileName           = $resolvedProfileName
                TenantId              = $TenantId
                AuthMethod            = 'Certificate'
                ClientId              = $ClientId
                CertificateThumbprint = $CertificateThumbprint
                AppName               = $appName
            }
            if ($AdminUpn) { $profileParams['UserPrincipalName'] = $AdminUpn }

            $verb = if ($existingMatch) { 'Updated' } else { 'Created' }
            Set-M365ConnectionProfile @profileParams
            Write-Info "$verb profile '$resolvedProfileName' -- use: Invoke-M365Assessment -ConnectionProfile '$resolvedProfileName'"
        }
    }

    Write-Host ''

    # ------------------------------------------------------------------
    # Return structured output
    # ------------------------------------------------------------------
    [PSCustomObject]@{
        ClientId              = $ClientId
        CertificateThumbprint = $CertificateThumbprint
        CertificatePath       = $certificatePath
        AppDisplayName        = $spDisplayName
        TenantId              = $TenantId
        BootstrapCreated      = $bootstrapCreated
        GraphPermissions      = $graphResults
        ComplianceRoles       = $complianceResults
        ExoRoleGroups         = $exoResults
        TotalFailed           = $totalFailed
        OperatorAppDisplayName        = if ($IncludeWritePermissions) { $OperatorAppDisplayName } else { $null }
        OperatorClientId              = $operatorClientId
        OperatorCertificateThumbprint = $operatorCertificateThumbprint
        OperatorCertificatePath       = $operatorCertificatePath
        OperatorCreated               = $operatorCreated
        WritePermissionGroups         = if ($IncludeWritePermissions) { @($operatorSelection.Groups) } else { @() }
        OperatorGraphPermissions      = $operatorGraphResults
        OperatorDirectoryRoles        = $operatorDirectoryResults
        OperatorExoRoleGroups         = $operatorExoResults
        OperatorRemoved               = @(
            @(
                @($operatorGraphResults) + @($operatorDirectoryResults) + @($operatorExoResults)
            ) | Where-Object { $_.Status -eq 'Removed' }
        )
        ReplaceWriteGroups            = [bool]$ReplaceWriteGroups
    }
}
