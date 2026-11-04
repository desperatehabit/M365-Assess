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
        [ValidateSet('Graph', 'ExchangeOnline', 'SecurityCompliance', 'SharePoint', 'Teams', 'PowerBI', 'Azure')]
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
            'Azure' {
                $context = $null
                if (Get-Command -Name Get-AzContext -ErrorAction SilentlyContinue) {
                    $context = Get-AzContext
                }
                if ($null -eq $context) {
                    throw 'Not connected to Azure. Run Connect-AzAccount (Az.Accounts) first.'
                }
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

    # A comparison that throws (for example a nested property missing from
    # the tenant's response) means the state is not in the desired shape.
    $compliant = $false
    try { $compliant = [bool](& $TestState $before) }
    catch { Write-Verbose "State comparison failed, treating as not compliant: $($_.Exception.Message)" }

    if ($compliant) {
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

    $verified = $false
    try { $verified = [bool](& $TestState $after) }
    catch { Write-Verbose "Post-apply comparison failed: $($_.Exception.Message)" }

    if ($SkipVerify.IsPresent -or $verified) {
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

function Get-RemediationCaPolicy {
    <#
    .SYNOPSIS
        Returns the Conditional Access policy with the given display name, or $null.
    .PARAMETER DisplayName
        Exact display name of the policy.
    .EXAMPLE
        Get-RemediationCaPolicy -DisplayName 'M365-Assess - Require MFA for admins'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$DisplayName
    )

    $escaped = $DisplayName.Replace("'", "''")
    $uri = "/v1.0/identity/conditionalAccess/policies?`$filter=displayName eq '$escaped'"
    $response = Invoke-MgGraphRequest -Method GET -Uri $uri -OutputType HashTable -ErrorAction Stop
    @($response['value']) | Where-Object { $null -ne $_ -and $_['displayName'] -eq $DisplayName } | Select-Object -First 1
}

function Set-RemediationCaPolicy {
    <#
    .SYNOPSIS
        Creates a Conditional Access policy, or updates the existing one with the same display name.
    .PARAMETER Existing
        The current policy (from Get-RemediationCaPolicy), or $null to create.
    .PARAMETER Policy
        Full policy body (displayName, state, conditions, grantControls / sessionControls).
    .EXAMPLE
        Set-RemediationCaPolicy -Existing $current -Policy $policy
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [object]$Existing,

        [Parameter(Mandatory)]
        [hashtable]$Policy
    )

    $json = $Policy | ConvertTo-Json -Depth 20
    if ($null -eq $Existing) {
        Invoke-MgGraphRequest -Method POST -Uri '/v1.0/identity/conditionalAccess/policies' -Body $json -ContentType 'application/json' -ErrorAction Stop | Out-Null
    }
    else {
        Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/identity/conditionalAccess/policies/$($Existing['id'])" -Body $json -ContentType 'application/json' -ErrorAction Stop | Out-Null
    }
}

function Test-RemediationCaPolicy {
    <#
    .SYNOPSIS
        Returns $true when a Conditional Access policy exists with the wanted state and settings.
    .DESCRIPTION
        Compares the state, then every leaf value of the desired policy's
        conditions, grantControls, and sessionControls (arrays as sets).
    .PARAMETER State
        Current policy (hashtable) or $null.
    .PARAMETER Policy
        Desired policy body.
    .EXAMPLE
        Test-RemediationCaPolicy -State $current -Policy $policy
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [object]$State,

        [Parameter(Mandatory)]
        [hashtable]$Policy
    )

    if ($null -eq $State) { return $false }
    $expected = @{ state = $Policy['state'] }
    $stack = [System.Collections.Generic.Stack[object]]::new()
    foreach ($root in @('conditions', 'grantControls', 'sessionControls')) {
        if ($Policy[$root] -is [System.Collections.IDictionary]) { $stack.Push(@($root, $Policy[$root])) }
    }
    while ($stack.Count -gt 0) {
        $item = $stack.Pop()
        foreach ($key in $item[1].Keys) {
            $value = $item[1][$key]
            $path = "$($item[0]).$key"
            if ($value -is [System.Collections.IDictionary]) { $stack.Push(@($path, $value)) }
            else { $expected[$path] = $value }
        }
    }
    Test-RemediationProperty -State $State -Expected $expected
}

function Get-RemediationPimRule {
    <#
    .SYNOPSIS
        Returns one PIM role management policy rule for a directory role.
    .PARAMETER RoleDefinitionId
        Entra role template / definition ID.
    .PARAMETER RuleId
        Rule ID, e.g. 'Expiration_EndUser_Assignment' or 'Approval_EndUser_Assignment'.
    .EXAMPLE
        Get-RemediationPimRule -RoleDefinitionId '62e90394-69f5-4237-9190-012177145e10' -RuleId 'Enablement_EndUser_Assignment'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$RoleDefinitionId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$RuleId
    )

    $filter = "scopeId eq '/' and scopeType eq 'DirectoryRole' and roleDefinitionId eq '$RoleDefinitionId'"
    $assignment = @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/policies/roleManagementPolicyAssignments?`$filter=$filter" -OutputType HashTable -ErrorAction Stop)['value']) | Select-Object -First 1
    if ($null -eq $assignment) {
        throw "No PIM policy assignment found for role $RoleDefinitionId. PIM requires Entra ID P2."
    }
    $rule = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/policies/roleManagementPolicies/$($assignment['policyId'])/rules/$RuleId" -OutputType HashTable -ErrorAction Stop
    $rule['policyId'] = $assignment['policyId']
    $rule
}

function Set-RemediationPimRule {
    <#
    .SYNOPSIS
        Replaces one PIM role management policy rule.
    .PARAMETER Current
        The rule as returned by Get-RemediationPimRule (supplies policyId, id, and @odata.type).
    .PARAMETER Changes
        Properties to set on the rule (merged over the current rule).
    .EXAMPLE
        Set-RemediationPimRule -Current $rule -Changes @{ maximumDuration = 'PT4H' }
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Current,

        [Parameter(Mandatory)]
        [hashtable]$Changes
    )

    $body = @{}
    foreach ($key in $Current.Keys) {
        if ($key -notin @('policyId', '@odata.context')) { $body[$key] = $Current[$key] }
    }
    foreach ($key in $Changes.Keys) { $body[$key] = $Changes[$key] }
    Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/policies/roleManagementPolicies/$($Current['policyId'])/rules/$($Current['id'])" -Body ($body | ConvertTo-Json -Depth 20) -ContentType 'application/json' -ErrorAction Stop | Out-Null
}

function Get-RemediationDirectorySetting {
    <#
    .SYNOPSIS
        Returns the tenant directory setting created from a template as a name/value hashtable, or $null.
    .PARAMETER TemplateId
        Directory setting template ID (e.g. Password Rule Settings 5cf42378-d67d-4f36-ba46-e8b86229381d).
    .EXAMPLE
        Get-RemediationDirectorySetting -TemplateId '5cf42378-d67d-4f36-ba46-e8b86229381d'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TemplateId
    )

    $setting = @((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/settings' -OutputType HashTable -ErrorAction Stop)['value']) |
        Where-Object { $null -ne $_ -and $_['templateId'] -eq $TemplateId } | Select-Object -First 1
    if ($null -eq $setting) { return $null }
    $values = @{ '_id' = $setting['id'] }
    foreach ($pair in @($setting['values'])) { $values[$pair['name']] = $pair['value'] }
    $values
}

function Set-RemediationDirectorySetting {
    <#
    .SYNOPSIS
        Updates values on a tenant directory setting, creating it from its template if needed.
    .DESCRIPTION
        When the setting does not exist yet it is created with the template's
        default values, overridden by -Values.
    .PARAMETER TemplateId
        Directory setting template ID.
    .PARAMETER Values
        Setting name to string value.
    .EXAMPLE
        Set-RemediationDirectorySetting -TemplateId '5cf42378-d67d-4f36-ba46-e8b86229381d' -Values @{ LockoutThreshold = '10' }
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TemplateId,

        [Parameter(Mandatory)]
        [hashtable]$Values
    )

    $current = Get-RemediationDirectorySetting -TemplateId $TemplateId
    if ($null -eq $current) {
        $template = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/directorySettingTemplates/$TemplateId" -OutputType HashTable -ErrorAction Stop
        $merged = @{}
        foreach ($v in @($template['values'])) { $merged[$v['name']] = "$($v['defaultValue'])" }
        foreach ($k in $Values.Keys) { $merged[$k] = "$($Values[$k])" }
        $body = @{ templateId = $TemplateId; values = @($merged.Keys | ForEach-Object { @{ name = $_; value = $merged[$_] } }) }
        Invoke-MgGraphRequest -Method POST -Uri '/v1.0/settings' -Body ($body | ConvertTo-Json -Depth 5) -ContentType 'application/json' -ErrorAction Stop | Out-Null
    }
    else {
        $merged = @{}
        foreach ($k in $current.Keys) { if ($k -ne '_id') { $merged[$k] = "$($current[$k])" } }
        foreach ($k in $Values.Keys) { $merged[$k] = "$($Values[$k])" }
        $body = @{ values = @($merged.Keys | ForEach-Object { @{ name = $_; value = $merged[$_] } }) }
        Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/settings/$($current['_id'])" -Body ($body | ConvertTo-Json -Depth 5) -ContentType 'application/json' -ErrorAction Stop | Out-Null
    }
}

function Get-RemediationApplication {
    <#
    .SYNOPSIS
        Returns app registrations (all, or the listed object IDs) as hashtables.
    .PARAMETER ObjectId
        Application object IDs. Omit to page through every app registration.
    .EXAMPLE
        Get-RemediationApplication -ObjectId '00000000-0000-0000-0000-000000000001'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter()]
        [string[]]$ObjectId
    )

    $select = 'id,appId,displayName,signInAudience,web,spa,publicClient,passwordCredentials,keyCredentials'
    $ids = @($ObjectId | Where-Object { $_ })
    if ($ids.Count -gt 0) {
        foreach ($id in $ids) {
            Invoke-MgGraphRequest -Method GET -Uri "/v1.0/applications/$id`?`$select=$select" -OutputType HashTable -ErrorAction Stop
        }
        return
    }
    $uri = "/v1.0/applications?`$select=$select&`$top=999"
    while ($uri) {
        $page = Invoke-MgGraphRequest -Method GET -Uri $uri -OutputType HashTable -ErrorAction Stop
        @($page['value']) | Where-Object { $null -ne $_ }
        $uri = $page['@odata.nextLink']
    }
}

function Remove-RemediationAppCredential {
    <#
    .SYNOPSIS
        Removes client secrets and/or certificates from an app registration or service principal.
    .DESCRIPTION
        Secrets are removed with removePassword (one call per key). Certificates
        are removed by writing back keyCredentials without them, which needs no
        proof-of-possession token.
    .PARAMETER ObjectId
        Object ID of the application (or service principal with -ServicePrincipal).
    .PARAMETER SecretKeyId
        keyIds of client secrets to remove.
    .PARAMETER CertificateKeyId
        keyIds of certificates to remove.
    .PARAMETER ServicePrincipal
        Target a service principal instead of an application.
    .EXAMPLE
        Remove-RemediationAppCredential -ObjectId $app['id'] -SecretKeyId $keyId
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$ObjectId,

        [Parameter()]
        [string[]]$SecretKeyId = @(),

        [Parameter()]
        [string[]]$CertificateKeyId = @(),

        [Parameter()]
        [switch]$ServicePrincipal
    )

    $collection = if ($ServicePrincipal.IsPresent) { 'servicePrincipals' } else { 'applications' }
    foreach ($keyId in @($SecretKeyId | Where-Object { $_ })) {
        Invoke-MgGraphRequest -Method POST -Uri "/v1.0/$collection/$ObjectId/removePassword" -Body (@{ keyId = $keyId } | ConvertTo-Json) -ContentType 'application/json' -ErrorAction Stop | Out-Null
    }
    $certs = @($CertificateKeyId | Where-Object { $_ })
    if ($certs.Count -gt 0) {
        $current = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/$collection/$ObjectId`?`$select=keyCredentials" -OutputType HashTable -ErrorAction Stop
        $keep = @($current['keyCredentials'] | Where-Object { $null -ne $_ -and $certs -notcontains "$($_['keyId'])" })
        Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/$collection/$ObjectId" -Body (@{ keyCredentials = $keep } | ConvertTo-Json -Depth 10) -ContentType 'application/json' -ErrorAction Stop | Out-Null
    }
}
