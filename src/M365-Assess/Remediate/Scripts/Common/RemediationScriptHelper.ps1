# Shared helpers for the per-check remediation scripts under Remediate/Scripts.
#
# These scripts are NOT part of the gated typed-binding path
# (Get-RemediationCommand.ps1 / Invoke-RemediationAction.ps1). They are
# standalone, operator-run scripts that a maintainer hand-validates against a
# real tenant before promoting the check into the typed-binding table
# (EPIC-006 SPEC.md section 4.5). Every script follows the same contract:
#
#   1. Assert the required service connection exists (no connecting here).
#   2. Read the current state.
#   3. If already compliant, report and stop.
#   4. Ask ShouldProcess (-WhatIf / -Confirm). ConfirmImpact is High, so the
#      operator is prompted unless -Confirm:$false is passed.
#   5. Apply the minimal change.
#   6. Re-read the state and verify the change took.
#
# Each run returns one PSCustomObject per remediation step with CheckId,
# Target, Status, Desired, Before, After, and Message. Status is one of:
#   AlreadyCompliant | WhatIf | Applied | VerifyFailed | Failed

function Assert-RemediationConnection {
    <#
    .SYNOPSIS
        Throws if the session is not connected to the required service.
    .DESCRIPTION
        Checks for an existing connection only. Scripts never connect on the
        operator's behalf: the operator connects with the least-privileged
        account suitable for the change, then runs the script.
    .PARAMETER Service
        One or more services the script needs.
    .PARAMETER GraphScope
        Microsoft Graph scopes the change needs. When the current delegated
        context does not list them, a warning is written (a broader scope
        may still grant the change).
    .EXAMPLE
        Assert-RemediationConnection -Service Graph -GraphScope 'Policy.ReadWrite.Authorization'
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('Graph', 'ExchangeOnline', 'SecurityCompliance', 'SharePoint', 'Teams', 'PowerBI')]
        [string[]]$Service,

        [Parameter()]
        [string[]]$GraphScope = @()
    )

    foreach ($svc in $Service) {
        switch ($svc) {
            'Graph' {
                $context = $null
                if (Get-Command -Name Get-MgContext -ErrorAction SilentlyContinue) {
                    $context = Get-MgContext
                }
                if ($null -eq $context) {
                    throw 'Not connected to Microsoft Graph. Run Connect-MgGraph with the scopes listed in this script''s help first.'
                }
                $granted = @($context.Scopes)
                if ($GraphScope.Count -gt 0 -and $granted.Count -gt 0) {
                    $missing = @($GraphScope | Where-Object { $granted -notcontains $_ })
                    if ($missing.Count -gt 0) {
                        # A broader scope (e.g. Directory.ReadWrite.All) can also grant
                        # the change, so warn rather than stop; Graph returns 403 if not.
                        Write-Warning "Microsoft Graph context does not list scope(s): $($missing -join ', '). If the change fails with 403, reconnect with Connect-MgGraph -Scopes $($GraphScope -join ',')."
                    }
                }
            }
            'ExchangeOnline' {
                $connected = $false
                if (Get-Command -Name Get-ConnectionInformation -ErrorAction SilentlyContinue) {
                    $connected = @(Get-ConnectionInformation | Where-Object { $_.State -eq 'Connected' -and -not $_.IsEopSession }).Count -gt 0
                }
                if (-not $connected) {
                    throw 'Not connected to Exchange Online. Run Connect-ExchangeOnline first.'
                }
            }
            'SecurityCompliance' {
                $connected = $false
                if (Get-Command -Name Get-ConnectionInformation -ErrorAction SilentlyContinue) {
                    $connected = @(Get-ConnectionInformation | Where-Object { $_.State -eq 'Connected' -and $_.IsEopSession }).Count -gt 0
                }
                if (-not $connected) {
                    throw 'Not connected to Security & Compliance PowerShell. Run Connect-IPPSSession first.'
                }
            }
            'SharePoint' {
                if (-not (Get-Command -Name Get-SPOTenant -ErrorAction SilentlyContinue)) {
                    throw 'SharePoint Online Management Shell is not loaded. Run Connect-SPOService first.'
                }
                try { $null = Get-SPOTenant -ErrorAction Stop }
                catch { throw "Not connected to SharePoint Online: $($_.Exception.Message). Run Connect-SPOService first." }
            }
            'Teams' {
                if (-not (Get-Command -Name Get-CsTenant -ErrorAction SilentlyContinue)) {
                    throw 'MicrosoftTeams module is not loaded. Run Connect-MicrosoftTeams first.'
                }
                try { $null = Get-CsTenant -ErrorAction Stop }
                catch { throw "Not connected to Microsoft Teams: $($_.Exception.Message). Run Connect-MicrosoftTeams first." }
            }
            'PowerBI' {
                if (-not (Get-Command -Name Get-PowerBIAccessToken -ErrorAction SilentlyContinue)) {
                    throw 'MicrosoftPowerBIMgmt module is not loaded. Run Connect-PowerBIServiceAccount first.'
                }
                try { $null = Get-PowerBIAccessToken -ErrorAction Stop -WarningAction SilentlyContinue }
                catch { throw "Not connected to Power BI: $($_.Exception.Message). Run Connect-PowerBIServiceAccount first." }
            }
        }
    }
}

function Invoke-RemediationStep {
    <#
    .SYNOPSIS
        Runs one read / compare / confirm / apply / verify remediation step.
    .DESCRIPTION
        The caller passes its own $PSCmdlet so -WhatIf and -Confirm on the
        script apply to the change. GetState and SetState talk to the tenant;
        TestState is a pure comparison that receives the state object and
        returns $true when it is compliant.
    .PARAMETER Cmdlet
        The calling script's $PSCmdlet.
    .PARAMETER CheckId
        Registry check id the step remediates.
    .PARAMETER Target
        Human-readable name of what is changed (shown in -WhatIf output).
    .PARAMETER Desired
        Human-readable description of the compliant state.
    .PARAMETER GetState
        Returns the current state.
    .PARAMETER TestState
        Receives the state as its first argument and returns $true when it is compliant.
    .PARAMETER SetState
        Applies the change. Receives the before-state as its first argument.
    .PARAMETER SkipVerify
        Skip the post-apply comparison (for changes whose effect is not
        readable right away, such as asynchronous provisioning). The step
        still reports the re-read state.
    .EXAMPLE
        Invoke-RemediationStep -Cmdlet $PSCmdlet -CheckId 'X-001' -Target 'Setting' -Desired 'On' -GetState { Get-Thing } -TestState { param($s) $s.On } -SetState { Set-Thing -On $true }
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSShouldProcess', '', Justification = 'ShouldProcess is called on the calling script''s $PSCmdlet so its -WhatIf/-Confirm apply.')]
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [System.Management.Automation.PSCmdlet]$Cmdlet,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$CheckId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Target,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Desired,

        [Parameter(Mandatory)]
        [scriptblock]$GetState,

        [Parameter(Mandatory)]
        [scriptblock]$TestState,

        [Parameter(Mandatory)]
        [scriptblock]$SetState,

        [Parameter()]
        [switch]$SkipVerify
    )

    $result = [PSCustomObject]@{
        CheckId = $CheckId
        Target  = $Target
        Status  = $null
        Desired = $Desired
        Before  = $null
        After   = $null
        Message = $null
    }

    try {
        $before = & $GetState
        $result.Before = $before
    }
    catch {
        $result.Status = 'Failed'
        $result.Message = "Could not read current state: $($_.Exception.Message)"
        return $result
    }

    if ([bool](& $TestState $before)) {
        $result.Status = 'AlreadyCompliant'
        $result.Message = 'No change needed.'
        return $result
    }

    if (-not $Cmdlet.ShouldProcess($Target, "Set to: $Desired")) {
        $result.Status = 'WhatIf'
        $result.Message = 'Change not applied (WhatIf or declined).'
        return $result
    }

    try {
        $null = & $SetState $before
    }
    catch {
        $result.Status = 'Failed'
        $result.Message = "Apply failed: $($_.Exception.Message)"
        return $result
    }

    try {
        $after = & $GetState
        $result.After = $after
    }
    catch {
        $result.Status = 'VerifyFailed'
        $result.Message = "Applied, but could not re-read state: $($_.Exception.Message)"
        return $result
    }

    if ($SkipVerify.IsPresent -or [bool](& $TestState $after)) {
        $result.Status = 'Applied'
        $result.Message = if ($SkipVerify.IsPresent) { 'Applied; verification skipped (change may take time to show).' } else { 'Applied and verified.' }
    }
    else {
        $result.Status = 'VerifyFailed'
        $result.Message = 'Applied, but the re-read state is still not compliant. Changes can take a few minutes to replicate; re-run the assessment check to confirm.'
    }
    $result
}

function Get-PowerBITenantSettingState {
    <#
    .SYNOPSIS
        Returns one Power BI / Fabric tenant setting object, or $null.
    .DESCRIPTION
        Uses the same admin/tenantSettings read the Power BI collector uses.
    .PARAMETER SettingName
        Fabric tenant setting name (e.g. 'PublishToWeb').
    .EXAMPLE
        Get-PowerBITenantSettingState -SettingName 'PublishToWeb'
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SettingName
    )

    $response = Invoke-PowerBIRestMethod -Url 'admin/tenantSettings' -Method Get -WarningAction SilentlyContinue | ConvertFrom-Json
    $setting = $response.tenantSettings | Where-Object { $_.settingName -eq $SettingName } | Select-Object -First 1
    if ($null -eq $setting) {
        throw "Tenant setting '$SettingName' was not returned by admin/tenantSettings. List the names with (Invoke-PowerBIRestMethod -Url 'admin/tenantSettings' -Method Get | ConvertFrom-Json).tenantSettings.settingName and re-run with -SettingName."
    }
    $setting
}

function Set-PowerBITenantSettingState {
    <#
    .SYNOPSIS
        Updates one Power BI / Fabric tenant setting.
    .DESCRIPTION
        Calls the Fabric admin API Tenants - Update Tenant Setting
        (POST /v1/admin/tenantsettings/{name}/update). The caller's
        Invoke-RemediationStep owns ShouldProcess. Only the enabled flag
        is changed unless a security group list is supplied, so an existing
        group scoping is kept when the setting stays enabled.
    .PARAMETER SettingName
        Fabric tenant setting name.
    .PARAMETER Enabled
        Desired enabled state.
    .PARAMETER EnabledSecurityGroupIds
        Optional Entra security group object IDs to scope an enabled setting to.
    .EXAMPLE
        Set-PowerBITenantSettingState -SettingName 'PublishToWeb' -Enabled $false
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SettingName,

        [Parameter(Mandatory)]
        [bool]$Enabled,

        [Parameter()]
        [string[]]$EnabledSecurityGroupIds = @()
    )

    $body = @{ enabled = $Enabled }
    if ($Enabled -and $EnabledSecurityGroupIds.Count -gt 0) {
        $body['enabledSecurityGroups'] = @($EnabledSecurityGroupIds | ForEach-Object { @{ graphId = $_ } })
    }
    $url = "https://api.fabric.microsoft.com/v1/admin/tenantsettings/$SettingName/update"
    Invoke-PowerBIRestMethod -Url $url -Method Post -Body ($body | ConvertTo-Json -Depth 5) -ContentType 'application/json' -WarningAction SilentlyContinue | Out-Null
}

function Get-RemediationGraphObject {
    <#
    .SYNOPSIS
        GETs a Microsoft Graph resource as a hashtable.
    .PARAMETER Uri
        Relative Graph URI including the version segment, e.g. '/v1.0/policies/authorizationPolicy'.
    .EXAMPLE
        Get-RemediationGraphObject -Uri '/beta/admin/forms/settings'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Uri
    )

    Invoke-MgGraphRequest -Method GET -Uri $Uri -OutputType HashTable -ErrorAction Stop
}

function Set-RemediationGraphObject {
    <#
    .SYNOPSIS
        Writes a JSON body to a Microsoft Graph resource (PATCH by default).
    .PARAMETER Uri
        Relative Graph URI including the version segment.
    .PARAMETER Body
        Properties to send. Nested hashtables are serialized as JSON objects.
    .PARAMETER Method
        PATCH (default), POST, or PUT.
    .EXAMPLE
        Set-RemediationGraphObject -Uri '/beta/admin/forms/settings' -Body @{ isPhishingScanEnabled = $true }
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Uri,

        [Parameter(Mandatory)]
        [hashtable]$Body,

        [Parameter()]
        [ValidateSet('PATCH', 'POST', 'PUT')]
        [string]$Method = 'PATCH'
    )

    Invoke-MgGraphRequest -Method $Method -Uri $Uri -Body ($Body | ConvertTo-Json -Depth 20) -ContentType 'application/json' -ErrorAction Stop
}

function Test-RemediationProperty {
    <#
    .SYNOPSIS
        Returns $true when every expected property on an object has the expected value.
    .DESCRIPTION
        Keys may be dotted paths into nested hashtables / objects
        ('defaultUserRolePermissions.allowedToCreateApps'). Array values are
        compared as unordered sets. String comparison is case-insensitive.
    .PARAMETER State
        Object (hashtable or PSObject) to inspect.
    .PARAMETER Expected
        Map of property path to expected value.
    .EXAMPLE
        Test-RemediationProperty -State $s -Expected @{ isPhishingScanEnabled = $true }
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [object]$State,

        [Parameter(Mandatory)]
        [hashtable]$Expected
    )

    if ($null -eq $State) { return $false }
    foreach ($path in $Expected.Keys) {
        $value = $State
        foreach ($segment in $path.Split('.')) {
            if ($null -eq $value) { break }
            if ($value -is [System.Collections.IDictionary]) { $value = $value[$segment] }
            else { $value = $value.$segment }
        }
        $want = $Expected[$path]
        if ($want -is [array]) {
            $have = @($value | ForEach-Object { "$_" } | Sort-Object)
            $need = @($want | ForEach-Object { "$_" } | Sort-Object)
            if (($have -join "`n") -ne ($need -join "`n")) { return $false }
        }
        elseif ($null -eq $want) {
            if ($null -ne $value) { return $false }
        }
        elseif ($null -eq $value) {
            return $false
        }
        elseif ($want -is [bool]) {
            if ($value -isnot [bool] -or $value -ne $want) { return $false }
        }
        elseif ("$value" -ne "$want") {
            return $false
        }
    }
    $true
}
