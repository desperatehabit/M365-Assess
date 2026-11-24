# Set-Group.ps1 — EPIC-014 Group CRUD worker (SPEC §4.1, §6, §8, §11.1, §11.4; T-0262, T-0900).
#
# Covers create, edit, delete, and convert operations for groups.
# Supports DryRun (plan preview mode returning diff without mutating).
# Validates dynamic membership rules before apply.
# Enforces naming confirmation for group deletion.

function Test-DynamicRuleSyntax {
    <#
    .SYNOPSIS
        Validates Graph membership rule syntax.
    .PARAMETER Rule
        Dynamic membership rule expression to validate.
    .EXAMPLE
        Test-DynamicRuleSyntax -Rule '(user.department -eq "Sales")'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [string]$Rule
    )

    if ([string]::IsNullOrWhiteSpace($Rule)) {
        return @{
            Valid   = $false
            Message = 'Dynamic membership rule cannot be empty.'
        }
    }

    $trimmed = $Rule.Trim()
    if (-not ($trimmed.StartsWith('(') -and $trimmed.EndsWith(')'))) {
        return @{
            Valid   = $false
            Message = 'Dynamic membership rule must be enclosed in parentheses.'
        }
    }

    # Parentheses balance check
    $openCount = ($trimmed.ToCharArray() | Where-Object -FilterScript { $_ -eq '(' }).Count
    $closeCount = ($trimmed.ToCharArray() | Where-Object -FilterScript { $_ -eq ')' }).Count
    if ($openCount -ne $closeCount) {
        return @{
            Valid   = $false
            Message = 'Mismatched parentheses in dynamic membership rule.'
        }
    }

    # Operator validation check (-eq, -ne, -contains, -notContains, -startsWith, -notStartsWith, -match, -notMatch, -in, -notIn)
    $validOpPattern = '-(eq|ne|contains|notContains|startsWith|notStartsWith|match|notMatch|in|notIn)\b'
    if (-not ($trimmed -match $validOpPattern)) {
        return @{
            Valid   = $false
            Message = 'Dynamic membership rule must contain at least one valid comparison operator (-eq, -ne, -contains, -startsWith, etc.).'
        }
    }

    return @{
        Valid   = $true
        Message = 'Rule syntax valid.'
    }
}

function Get-ResolvedGroupType {
    <#
    .SYNOPSIS
        Determines the EPIC-014 group type from a Microsoft Graph group object.
    .PARAMETER GroupEntry
        Graph group payload object.
    .EXAMPLE
        Get-ResolvedGroupType -GroupEntry $existing
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [object]$GroupEntry
    )

    $groupTypes = if ($GroupEntry.groupTypes) { @($GroupEntry.groupTypes) } else { @() }
    $isDynamic = ($groupTypes -contains 'DynamicMembership') -or (-not [string]::IsNullOrWhiteSpace([string]$GroupEntry.membershipRule))
    if ($isDynamic) {
        return 'dynamic'
    }
    if ($groupTypes -contains 'Unified') {
        return 'm365'
    }
    $mailEnabled = [bool]$GroupEntry.mailEnabled
    $securityEnabled = [bool]$GroupEntry.securityEnabled
    if ($mailEnabled -and (-not $securityEnabled)) {
        return 'distribution'
    }
    if ($mailEnabled -and $securityEnabled) {
        return 'mailEnabledSecurity'
    }
    return 'security'
}

function Set-CreatedGroupGalDelivery {
    <#
    .SYNOPSIS
        Applies GAL and delivery settings via Exchange Online after group creation.
    .PARAMETER GroupId
        Graph object id of the created group.
    .PARAMETER GroupType
        EPIC-014 group type created.
    .PARAMETER HiddenFromAddressListsEnabled
        Whether to hide the group from the Global Address List.
    .PARAMETER RequireSenderAuthenticationEnabled
        Whether to require internal sender authentication.
    .PARAMETER GrantSendOnBehalfTo
        Principals granted Send on Behalf permissions.
    .EXAMPLE
        Set-CreatedGroupGalDelivery -GroupId 'grp-1' -GroupType 'm365' -HiddenFromAddressListsEnabled $true
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$GroupId,

        [Parameter(Mandatory)]
        [string]$GroupType,

        [Parameter()]
        [bool]$HiddenFromAddressListsEnabled = $false,

        [Parameter()]
        [bool]$RequireSenderAuthenticationEnabled = $false,

        [Parameter()]
        [string[]]$GrantSendOnBehalfTo = @()
    )

    $hasGrants = $null -ne $GrantSendOnBehalfTo -and $GrantSendOnBehalfTo.Count -gt 0
    if (-not ($HiddenFromAddressListsEnabled -or $RequireSenderAuthenticationEnabled -or $hasGrants)) {
        return
    }
    if ($GroupType -notin @('m365', 'distribution', 'mailEnabledSecurity')) {
        Write-Verbose "Skipping Exchange Online GAL/delivery settings for non-mail group type '$GroupType'."
        return
    }

    $exoParams = @{
        Identity = $GroupId
        Confirm  = $false
    }
    if ($HiddenFromAddressListsEnabled) {
        $exoParams['HiddenFromAddressListsEnabled'] = $true
    }
    if ($RequireSenderAuthenticationEnabled) {
        $exoParams['RequireSenderAuthenticationEnabled'] = $true
    }
    if ($hasGrants) {
        $exoParams['GrantSendOnBehalfTo'] = @($GrantSendOnBehalfTo)
    }

    if ($GroupType -eq 'm365') {
        if (Get-Command -Name 'Set-UnifiedGroup' -ErrorAction SilentlyContinue) {
            Set-UnifiedGroup @exoParams
            return
        }
        if (Get-Command -Name 'Set-DistributionGroup' -ErrorAction SilentlyContinue) {
            Set-DistributionGroup @exoParams
            return
        }
    }
    else {
        if (Get-Command -Name 'Set-DistributionGroup' -ErrorAction SilentlyContinue) {
            Set-DistributionGroup @exoParams
            return
        }
        if (Get-Command -Name 'Set-UnifiedGroup' -ErrorAction SilentlyContinue) {
            Set-UnifiedGroup @exoParams
            return
        }
    }

    Write-Verbose "Exchange Online cmdlets unavailable; skipped GAL/delivery settings for created group '$GroupId'."
}

function New-GroupConvertPatchBody {
    <#
    .SYNOPSIS
        Builds the Microsoft Graph PATCH body for converting a group type.
    .PARAMETER CurrentType
        Current EPIC-014 group type.
    .PARAMETER TargetType
        Target EPIC-014 group type.
    .PARAMETER ExistingGroupTypes
        Existing Graph groupTypes array on the group.
    .PARAMETER DynamicRule
        Dynamic membership rule when converting to dynamic.
    .EXAMPLE
        New-GroupConvertPatchBody -CurrentType 'security' -TargetType 'dynamic' -DynamicRule '(user.department -eq "Sales")'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [string]$CurrentType,

        [Parameter(Mandatory)]
        [string]$TargetType,

        [Parameter()]
        [string[]]$ExistingGroupTypes = @(),

        [Parameter()]
        [string]$DynamicRule = ''
    )

    $body = @{}
    switch ($TargetType) {
        'm365' {
            $body.groupTypes = @('Unified')
            $body.mailEnabled = $true
            $body.securityEnabled = $true
        }
        'security' {
            $body.groupTypes = @()
            $body.mailEnabled = $false
            $body.securityEnabled = $true
        }
        'mailEnabledSecurity' {
            $body.groupTypes = @()
            $body.mailEnabled = $true
            $body.securityEnabled = $true
        }
        'distribution' {
            $body.groupTypes = @()
            $body.mailEnabled = $true
            $body.securityEnabled = $false
        }
        'dynamic' {
            $nextTypes = [System.Collections.Generic.List[string]]::new()
            if ($ExistingGroupTypes -contains 'Unified') {
                $nextTypes.Add('Unified')
            }
            $nextTypes.Add('DynamicMembership')
            $body.groupTypes = @($nextTypes)
            $body.membershipRule = $DynamicRule
            $body.membershipRuleProcessingState = 'On'
        }
    }

    if ($CurrentType -eq 'dynamic' -and $TargetType -ne 'dynamic') {
        $body.membershipRule = $null
        $body.membershipRuleProcessingState = $null
    }

    return $body
}

function Read-SetGroupJob {
    <#
    .SYNOPSIS
        Parses a T-0007 job envelope JSON for Set-Group.
    .PARAMETER Path
        Path to the job envelope JSON file.
    .EXAMPLE
        Read-SetGroupJob -Path './job.json'
    #>
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

    $raw = Get-Content -LiteralPath $Path -Raw
    $json = $raw | ConvertFrom-Json
    if (-not $json.tenantId) {
        throw "job envelope '$Path' is missing mandatory 'tenantId'"
    }
    if (-not $json.action) {
        throw "job envelope '$Path' is missing mandatory 'action'"
    }

    $hasDescriptionProp = $null -ne $json.PSObject.Properties['description']
    $hasDescription = $hasDescriptionProp -and ($null -ne $json.description)
    $descriptionValue = if ($hasDescription) { [string]$json.description } else { '' }

    $targetTypeValue = if ($json.targetType) { [string]$json.targetType } else { '' }
    $groupTypeValue = if ($json.groupType) {
        [string]$json.groupType
    }
    elseif ($targetTypeValue) {
        $targetTypeValue
    }
    else {
        'security'
    }

    $sendOnBehalf = @()
    if ($json.grantSendOnBehalfTo) {
        $sendOnBehalf = @($json.grantSendOnBehalfTo | ForEach-Object -Process { [string]$_ })
    }

    return @{
        TenantId                           = [string]$json.tenantId
        Action                             = [string]$json.action
        GroupId                            = if ($json.groupId) { [string]$json.groupId } else { '' }
        DisplayName                        = if ($json.displayName) { [string]$json.displayName } else { '' }
        GroupType                          = $groupTypeValue
        TargetType                         = $targetTypeValue
        MailNickname                       = if ($json.mailNickname) { [string]$json.mailNickname } else { '' }
        Description                        = $descriptionValue
        HasDescription                     = $hasDescription
        DynamicRule                        = if ($json.dynamicRule) { [string]$json.dynamicRule } else { '' }
        ConfirmName                        = if ($json.confirmName) { [string]$json.confirmName } else { '' }
        HiddenFromAddressListsEnabled      = [bool]($json.hiddenFromAddressListsEnabled -eq $true)
        RequireSenderAuthenticationEnabled = [bool]($json.requireSenderAuthenticationEnabled -eq $true)
        GrantSendOnBehalfTo                = $sendOnBehalf
        DryRun                             = [bool]($json.dryRun -eq $true)
    }
}

function Invoke-SetGroup {
    <#
    .SYNOPSIS
        Executes or previews group CRUD and conversion operations with dynamic-rule validation.
    .PARAMETER TenantId
        Target tenant identifier.
    .PARAMETER Action
        Operation to run: create, edit, delete, or convert.
    .PARAMETER GroupId
        Existing group identifier for edit, delete, or convert.
    .PARAMETER DisplayName
        Display name for create or edit.
    .PARAMETER GroupType
        Group type for create or convert.
    .PARAMETER TargetType
        Target group type for convert.
    .PARAMETER MailNickname
        Optional mail nickname for mail-enabled groups.
    .PARAMETER Description
        Description text for create or edit. Pass explicit empty string to clear on edit.
    .PARAMETER HasDescription
        Explicit indicator from job envelope that Description was supplied.
    .PARAMETER DynamicRule
        Dynamic membership rule expression.
    .PARAMETER ConfirmName
        Group display name confirmation required for delete.
    .PARAMETER HiddenFromAddressListsEnabled
        Hide created group from Global Address List (GAL).
    .PARAMETER RequireSenderAuthenticationEnabled
        Restrict created group to authenticated internal senders.
    .PARAMETER GrantSendOnBehalfTo
        List of delegates granted Send on Behalf permissions on create.
    .PARAMETER DryRun
        When true, computes and returns the plan without mutating the tenant.
    .EXAMPLE
        Invoke-SetGroup -TenantId 'tenant-a' -Action 'edit' -GroupId 'grp-1' -Description ''
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('create', 'edit', 'delete', 'convert')]
        [string]$Action,

        [Parameter()]
        [string]$GroupId = '',

        [Parameter()]
        [string]$DisplayName = '',

        [Parameter()]
        [ValidateSet('', 'm365', 'security', 'mailEnabledSecurity', 'distribution', 'dynamic')]
        [string]$GroupType = 'security',

        [Parameter()]
        [ValidateSet('', 'm365', 'security', 'mailEnabledSecurity', 'distribution', 'dynamic')]
        [string]$TargetType = '',

        [Parameter()]
        [string]$MailNickname = '',

        [Parameter()]
        [string]$Description = '',

        [Parameter()]
        [bool]$HasDescription = $false,

        [Parameter()]
        [string]$DynamicRule = '',

        [Parameter()]
        [string]$ConfirmName = '',

        [Parameter()]
        [bool]$HiddenFromAddressListsEnabled = $false,

        [Parameter()]
        [bool]$RequireSenderAuthenticationEnabled = $false,

        [Parameter()]
        [string[]]$GrantSendOnBehalfTo = @(),

        [Parameter()]
        [bool]$DryRun = $false
    )

    $effectiveTargetType = if ($Action -eq 'convert') {
        if (-not [string]::IsNullOrWhiteSpace($TargetType)) {
            $TargetType
        }
        elseif (-not [string]::IsNullOrWhiteSpace($GroupType)) {
            $GroupType
        }
        else {
            throw 'ValidationFailed: targetType is required for convert'
        }
    }
    else {
        $GroupType
    }

    if ($null -ne $GrantSendOnBehalfTo -and $GrantSendOnBehalfTo.Count -gt 0) {
        foreach ($grant in $GrantSendOnBehalfTo) {
            if ([string]::IsNullOrWhiteSpace($grant)) {
                throw 'ValidationFailed: GrantSendOnBehalfTo cannot contain empty entries.'
            }
        }
    }

    # 1. Dynamic Rule validation
    if ($effectiveTargetType -eq 'dynamic' -or -not [string]::IsNullOrWhiteSpace($DynamicRule)) {
        $ruleCheck = Test-DynamicRuleSyntax -Rule $DynamicRule
        if (-not $ruleCheck.Valid) {
            throw "ValidationFailed: $($ruleCheck.Message)"
        }
    }

    $descriptionSpecified = $HasDescription -or $PSBoundParameters.ContainsKey('Description')
    $before = $null
    $after = $null
    $diff = [System.Collections.Generic.List[string]]::new()
    $currentType = ''
    $existingGroupTypes = @()

    # 2. Handle before state for existing groups
    if ($Action -in @('edit', 'delete', 'convert')) {
        if ([string]::IsNullOrWhiteSpace($GroupId)) {
            throw "ValidationFailed: groupId is required for $Action"
        }
        $existing = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups/$GroupId"
        if (-not $existing) {
            throw "NotFound: Group '$GroupId' not found"
        }
        $existingGroupTypes = if ($existing.groupTypes) { @($existing.groupTypes) } else { @() }
        $currentType = Get-ResolvedGroupType -GroupEntry $existing
        $before = @{
            id          = [string]$existing.id
            displayName = [string]$existing.displayName
            description = if ($null -ne $existing.description) { [string]$existing.description } else { '' }
            mail        = [string]$existing.mail
            rule        = if ($null -ne $existing.membershipRule) { [string]$existing.membershipRule } else { '' }
        }
        if ($Action -eq 'convert') {
            $before.groupType = $currentType
        }

        # Delete confirmation requirement
        if ($Action -eq 'delete') {
            if ([string]::IsNullOrWhiteSpace($ConfirmName) -or $ConfirmName.Trim() -ne $existing.displayName) {
                throw "ConfirmationRequired: Deletion requires confirmName matching '$($existing.displayName)'"
            }
            $diff.Add("Delete group '$($existing.displayName)' ($GroupId)")
        }
    }

    if ($Action -eq 'create') {
        if ([string]::IsNullOrWhiteSpace($DisplayName)) {
            throw 'ValidationFailed: displayName is required for create'
        }
        $nickname = if (-not [string]::IsNullOrWhiteSpace($MailNickname)) {
            $MailNickname
        }
        else {
            $DisplayName -replace '[^a-zA-Z0-9]', ''
        }

        $after = @{
            displayName                        = $DisplayName
            description                        = $Description
            groupType                          = $GroupType
            mailNickname                       = $nickname
            dynamicRule                        = $DynamicRule
            hiddenFromAddressListsEnabled      = $HiddenFromAddressListsEnabled
            requireSenderAuthenticationEnabled = $RequireSenderAuthenticationEnabled
            grantSendOnBehalfTo                = @($GrantSendOnBehalfTo)
        }
        $diff.Add("Create $GroupType group '$DisplayName'")
        if ($DynamicRule) {
            $diff.Add("Set dynamic membership rule: $DynamicRule")
        }
        if ($HiddenFromAddressListsEnabled) {
            $diff.Add('Hide group from Global Address List (GAL)')
        }
        if ($RequireSenderAuthenticationEnabled) {
            $diff.Add('Enable delivery management (require sender authentication)')
        }
        if ($GrantSendOnBehalfTo -and $GrantSendOnBehalfTo.Count -gt 0) {
            $diff.Add("Grant send-on-behalf to: $($GrantSendOnBehalfTo -join ', ')")
        }
    }
    elseif ($Action -eq 'edit') {
        $nextDescription = if ($descriptionSpecified) { $Description } else { $before.description }
        $after = @{
            id          = $GroupId
            displayName = if ($DisplayName) { $DisplayName } else { $before.displayName }
            description = $nextDescription
            dynamicRule = if ($DynamicRule) { $DynamicRule } else { $before.rule }
        }
        if ($DisplayName -and $DisplayName -ne $before.displayName) {
            $diff.Add("Change displayName: '$($before.displayName)' -> '$DisplayName'")
        }
        if ($descriptionSpecified -and $nextDescription -ne $before.description) {
            $diff.Add("Change description: '$($before.description)' -> '$nextDescription'")
        }
        if ($DynamicRule -and $DynamicRule -ne $before.rule) {
            $diff.Add("Update dynamicRule: '$($before.rule)' -> '$DynamicRule'")
        }
    }
    elseif ($Action -eq 'convert') {
        $after = @{
            id          = $GroupId
            displayName = $before.displayName
            groupType   = $effectiveTargetType
            dynamicRule = if ($effectiveTargetType -eq 'dynamic') { $DynamicRule } else { '' }
        }
        if ($currentType -ne $effectiveTargetType) {
            $diff.Add("Convert group '$($before.displayName)': $currentType -> $effectiveTargetType")
            if ($effectiveTargetType -eq 'dynamic' -and $DynamicRule) {
                $diff.Add("Set dynamic membership rule: $DynamicRule")
            }
            elseif ($currentType -eq 'dynamic') {
                $diff.Add('Clear dynamic membership rule')
            }
        }
    }

    $plan = [pscustomobject]@{
        action               = $Action
        groupId              = $GroupId
        targetName           = if ($DisplayName) { $DisplayName } elseif ($before) { $before.displayName } else { '' }
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = ($Action -eq 'delete')
    }

    if ($DryRun) {
        return $plan
    }

    # Apply mutation live
    $appliedResult = $null
    $auditEvent = @{
        id         = [guid]::NewGuid().ToString()
        tenantId   = $TenantId
        action     = "group.$Action"
        targetId   = $GroupId
        targetName = $plan.targetName
        timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        before     = $before
        after      = $after
    }

    if ($Action -eq 'create') {
        $body = @{
            displayName     = $DisplayName
            mailNickname    = $plan.after.mailNickname
            description     = $Description
            mailEnabled     = ($GroupType -in @('m365', 'distribution', 'mailEnabledSecurity'))
            securityEnabled = ($GroupType -ne 'distribution')
        }
        if ($GroupType -eq 'm365') {
            $body.groupTypes = @('Unified')
        }
        elseif ($GroupType -eq 'dynamic') {
            $body.groupTypes = @('DynamicMembership')
            $body.membershipRule = $DynamicRule
            $body.membershipRuleProcessingState = 'On'
        }

        $appliedResult = Invoke-MgGraphRequest -Method POST -Uri '/v1.0/groups' -Body ($body | ConvertTo-Json -Depth 5)
        $createdId = [string]$appliedResult.id
        $auditEvent.targetId = $createdId

        if ($createdId) {
            $galParams = @{
                GroupId                            = $createdId
                GroupType                          = $GroupType
                HiddenFromAddressListsEnabled      = $HiddenFromAddressListsEnabled
                RequireSenderAuthenticationEnabled = $RequireSenderAuthenticationEnabled
                GrantSendOnBehalfTo                = $GrantSendOnBehalfTo
            }
            Set-CreatedGroupGalDelivery @galParams
        }
    }
    elseif ($Action -eq 'edit') {
        $body = @{}
        if ($DisplayName) { $body.displayName = $DisplayName }
        if ($descriptionSpecified) {
            $body.description = if ([string]::IsNullOrEmpty($Description)) { $null } else { $Description }
        }
        if ($DynamicRule) {
            $body.membershipRule = $DynamicRule
            $body.membershipRuleProcessingState = 'On'
        }
        $appliedResult = Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/groups/$GroupId" -Body ($body | ConvertTo-Json -Depth 5)
    }
    elseif ($Action -eq 'delete') {
        Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/groups/$GroupId"
        $appliedResult = @{ deleted = $true; id = $GroupId }
    }
    elseif ($Action -eq 'convert') {
        if ($currentType -eq $effectiveTargetType) {
            $appliedResult = @{
                id        = $GroupId
                groupType = $effectiveTargetType
                unchanged = $true
            }
        }
        else {
            $body = New-GroupConvertPatchBody -CurrentType $currentType -TargetType $effectiveTargetType -ExistingGroupTypes $existingGroupTypes -DynamicRule $DynamicRule
            $appliedResult = Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/groups/$GroupId" -Body ($body | ConvertTo-Json -Depth 5)
        }
    }

    return [pscustomobject]@{
        plan       = $plan
        result     = $appliedResult
        auditEvent = $auditEvent
        success    = $true
    }
}
