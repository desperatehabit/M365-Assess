# Invoke-TeamsVoice.ps1 — EPIC-026 Teams Business Voice worker (SPEC §3.3, §4.3, §5, §6, §8, §11.1; T-0508).
#
# Covers the voice-number inventory, assignment to users/resource accounts,
# number release, and voice-policy assignment. Voice is heavily license-gated
# (SPEC §3.3, §4.3, §9): the tenant must hold an active Phone System service
# plan (MCOEV / "Microsoft 365 Phone System") or every write is refused with a
# clear requirement message. Reads (list) still render the not-licensed state.
#
# Gating (EPIC-006 contract, T-0108): writes follow the same contract as the
# registry-bound executor — the BFF confirms the plan before dispatch (dryRun
# plans only), -DryRun reports the intended change without writing, -Confirmed
# is re-checked here so a job that skips confirmation cannot apply, every
# apply captures before/after, and every apply emits one audit record plus one
# TeamOperation row (T-0501). Release additionally requires explicit
# confirmation (SPEC §8). The supervisor connects Graph in the child process
# after materializing the tenant credential in-process; this file never touches
# secrets. Voice operations use Teams PowerShell cmdlets, which require a
# MicrosoftTeams session in the child process.

function Test-TeamsVoiceInput {
    <#
    .SYNOPSIS
        Validates one planned voice operation.
    .DESCRIPTION
        Mirrors the BFF route validation so the worker refuses the same rows
        the BFF would: assign needs a number and a target, release needs a
        number id, policy needs a policy id and a target. Returns the error
        list; empty is valid.
    .PARAMETER Action
        Planned voice action.
    .PARAMETER NumberId
        Planned phone-number assignment identity (release).
    .PARAMETER PhoneNumber
        Planned phone number (assign).
    .PARAMETER TargetId
        Planned user/resource account identity (assign, policy).
    .PARAMETER PolicyId
        Planned voice routing policy identity (policy).
    .EXAMPLE
        Test-TeamsVoiceInput -Action 'assign' -PhoneNumber '+15550100' -TargetId 'user-1'
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('assign', 'release', 'policy')]
        [string]$Action,

        [Parameter()]
        [string]$NumberId = '',

        [Parameter()]
        [string]$PhoneNumber = '',

        [Parameter()]
        [string]$TargetId = '',

        [Parameter()]
        [string]$PolicyId = ''
    )

    $errors = [System.Collections.Generic.List[string]]::new()
    switch ($Action) {
        'assign' {
            if ([string]::IsNullOrWhiteSpace($PhoneNumber)) {
                $errors.Add('phoneNumber is required for assign')
            }
            if ([string]::IsNullOrWhiteSpace($TargetId)) {
                $errors.Add('targetId is required for assign')
            }
        }
        'release' {
            if ([string]::IsNullOrWhiteSpace($NumberId)) {
                $errors.Add('numberId is required for release')
            }
        }
        'policy' {
            if ([string]::IsNullOrWhiteSpace($PolicyId)) {
                $errors.Add('policyId is required for policy assignment')
            }
            if ([string]::IsNullOrWhiteSpace($TargetId)) {
                $errors.Add('targetId is required for policy assignment')
            }
        }
    }
    return @($errors)
}

function Read-TeamsVoiceJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-TeamsVoice parameters.
    .DESCRIPTION
        Validates the envelope carries a tenant and an action, then returns the
        number, target, policy, confirmation, and dry-run flag. The envelope
        carries references and planned values only.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-TeamsVoiceJob -Path './run/voice-job.json'
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

    return @{
        TenantId    = [string]$json.tenantId
        Action      = [string]$json.action
        NumberId    = if ($json.numberId) { [string]$json.numberId } else { '' }
        PhoneNumber = if ($json.phoneNumber) { [string]$json.phoneNumber } else { '' }
        TargetId    = if ($json.targetId) { [string]$json.targetId } else { '' }
        PolicyId    = if ($json.policyId) { [string]$json.policyId } else { '' }
        Confirmed   = [bool]($json.confirmed -eq $true)
        DryRun      = [bool]($json.dryRun -eq $true)
    }
}

function Get-TeamsVoiceLicenseState {
    <#
    .SYNOPSIS
        Resolves whether the connected tenant is licensed for Teams Business Voice.
    .DESCRIPTION
        Reads Get-MgSubscribedSku and checks for an active Phone System service
        plan (SkuPartNumber MCOEV or ServicePlanName "Microsoft 365 Phone
        System" with ProvisioningStatus Success). Returns the license state the
        route and page render: Licensed, the missing plans, and the active
        plans. A tenant that cannot be read is treated as not licensed so the
        gate fails closed.
    .EXAMPLE
        Get-TeamsVoiceLicenseState
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param()

    $requiredPlans = [System.Collections.Generic.List[string]]::new()
    $null = $requiredPlans.Add('MCOEV')
    $activePlans = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )

    try {
        $skus = Get-MgSubscribedSku -All -ErrorAction Stop
        foreach ($sku in $skus) {
            if ($sku.SkuPartNumber) {
                $null = $activePlans.Add([string]$sku.SkuPartNumber)
            }
            foreach ($plan in $sku.ServicePlans) {
                if ($plan.ProvisioningStatus -eq 'Success' -and $plan.ServicePlanName) {
                    $null = $activePlans.Add([string]$plan.ServicePlanName)
                }
            }
        }
    }
    catch {
        Write-Warning "Could not resolve tenant licenses: $_. Voice license gate fails closed."
    }

    $licensed = $false
    foreach ($plan in $requiredPlans) {
        if ($activePlans.Contains($plan)) {
            $licensed = $true
        }
        if ($activePlans.Contains('Microsoft 365 Phone System')) {
            $licensed = $true
        }
    }

    return @{
        Licensed     = $licensed
        MissingPlans = @($requiredPlans | Where-Object { -not $activePlans.Contains($_) })
        ActivePlans  = @($activePlans)
    }
}

function Get-TeamsVoiceNumberRow {
    <#
    .SYNOPSIS
        Shapes one Teams phone-number assignment into the inventory row.
    .PARAMETER Assignment
        The live Teams phone-number assignment object.
    .EXAMPLE
        Get-TeamsVoiceNumberRow -Assignment $assignment
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [object]$Assignment
    )

    $numberId = [string]$Assignment.Id
    if ([string]::IsNullOrWhiteSpace($numberId)) {
        $numberId = [string]$Assignment.Number
    }
    return @{
        id         = $numberId
        number     = [string]$Assignment.Number
        type       = [string]$Assignment.PhoneNumberType
        assignedTo = [string]$Assignment.AssignedTo
        state      = [string]$Assignment.State
    }
}

function Get-TeamsVoiceCurrentUser {
    <#
    .SYNOPSIS
        Reads the current voice state of one live user for the before snapshot.
    .PARAMETER TargetId
        The user/resource account identity.
    .EXAMPLE
        Get-TeamsVoiceCurrentUser -TargetId 'user-1'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TargetId
    )

    $user = Get-CsOnlineUser -Identity $TargetId -ErrorAction Stop
    return @{
        id                    = $TargetId
        displayName           = [string]$user.DisplayName
        enterpriseVoiceEnabled = [bool]$user.EnterpriseVoiceEnabled
        lineUri               = [string]$user.OnPremLineURI
        voiceRoutingPolicy    = [string]$user.OnlineVoiceRoutingPolicy
    }
}

function Invoke-TeamsVoice {
    <#
    .SYNOPSIS
        Executes or previews Teams Business Voice operations with before/after capture.
    .DESCRIPTION
        -DryRun returns the plan with no tenant write. Without -DryRun,
        -Confirmed is required or the apply is refused. The license gate is
        re-checked on every write: an unlicensed tenant is refused with a clear
        requirement message. Every applied write emits one auditEvent with
        before/after for the app audit sink and one TeamOperation row (T-0501).
        Release requires explicit confirmation (SPEC §8).
    .PARAMETER TenantId
        Tenant the voice work belongs to. Carried through to the result envelope.
    .PARAMETER Action
        'list' reads the inventory and license state; 'assign', 'release', and
        'policy' apply through the gated executor.
    .PARAMETER NumberId
        Phone-number assignment identity for release.
    .PARAMETER PhoneNumber
        Phone number to assign.
    .PARAMETER TargetId
        User/resource account identity for assign and policy.
    .PARAMETER PolicyId
        Voice routing policy identity for policy assignment.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for apply; the BFF confirms the plan before dispatch.
    .EXAMPLE
        Invoke-TeamsVoice -TenantId 'tenant-a' -Action 'assign' -PhoneNumber '+15550100' -TargetId 'user-1' -DryRun
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('list', 'assign', 'release', 'policy')]
        [string]$Action,

        [Parameter()]
        [string]$NumberId = '',

        [Parameter()]
        [string]$PhoneNumber = '',

        [Parameter()]
        [string]$TargetId = '',

        [Parameter()]
        [string]$PolicyId = '',

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false
    )

    $license = Get-TeamsVoiceLicenseState

    if ($Action -eq 'list') {
        $numbers = @()
        if ($license.Licensed) {
            $assignments = @(Get-CsPhoneNumberAssignment -ErrorAction Stop)
            $numbers = @($assignments | ForEach-Object { Get-TeamsVoiceNumberRow -Assignment $_ })
        }
        return [pscustomobject]@{
            tenantId = $TenantId
            license  = $license
            numbers  = $numbers
        }
    }

    if (-not $license.Licensed) {
        $missing = ($license.MissingPlans -join ', ')
        throw "voice.license_required: tenant '$TenantId' is not licensed for Teams Business Voice (missing service plan: $missing)"
    }

    $failures = @(Test-TeamsVoiceInput -Action $Action -NumberId $NumberId -PhoneNumber $PhoneNumber -TargetId $TargetId -PolicyId $PolicyId)
    if ($failures.Count -gt 0) {
        throw "ValidationFailed: $($failures -join '; ')"
    }

    switch ($Action) {
        'assign' {
            $before = Get-TeamsVoiceCurrentUser -TargetId $TargetId
            $after = @{
                id                    = $TargetId
                displayName           = $before['displayName']
                enterpriseVoiceEnabled = $true
                lineUri               = $PhoneNumber.Trim()
                voiceRoutingPolicy    = $before['voiceRoutingPolicy']
            }
            $diff = [System.Collections.Generic.List[string]]::new()
            if ($before['lineUri'] -eq $PhoneNumber.Trim()) {
                $null = $diff.Add("User '$TargetId' already carries number '$($PhoneNumber.Trim())'; no change applied")
            }
            else {
                $null = $diff.Add("Assign phone number '$($PhoneNumber.Trim())' to '$TargetId'")
            }

            $plan = [pscustomobject]@{
                action               = $Action
                phoneNumber          = $PhoneNumber.Trim()
                targetId             = $TargetId.Trim()
                before               = $before
                after                = $after
                diff                 = @($diff)
                valid                = $true
                dryRun               = $DryRun
                requiresConfirmation = $false
            }

            if ($DryRun) {
                return $plan
            }
            if (-not $Confirmed) {
                throw "voice.confirm_required: action '$Action' requires explicit confirmation"
            }

            if ($before['lineUri'] -eq $PhoneNumber.Trim()) {
                return [pscustomobject]@{
                    plan           = $plan
                    result         = @{ targetId = $TargetId.Trim(); phoneNumber = $PhoneNumber.Trim(); noop = $true }
                    teamOperation  = New-TeamsVoiceOperation -TenantId $TenantId -Action $Action -TargetId $TargetId.Trim() -Before $before -After $after -State 'noop'
                    auditEvent     = New-TeamsVoiceAuditEvent -TenantId $TenantId -Action $Action -TargetId $TargetId.Trim() -Before $before -After $after -Note 'already assigned; no change applied'
                    noop           = $true
                    success        = $true
                }
            }

            $null = Set-CsPhoneNumberAssignment -Identity $TargetId.Trim() -PhoneNumber $PhoneNumber.Trim() -PhoneNumberType DirectRouting
            $refreshed = Get-TeamsVoiceCurrentUser -TargetId $TargetId.Trim()
            $after = @{
                id                    = $TargetId.Trim()
                displayName           = $refreshed['displayName']
                enterpriseVoiceEnabled = $true
                lineUri               = $PhoneNumber.Trim()
                voiceRoutingPolicy    = $refreshed['voiceRoutingPolicy']
            }
            $plan = [pscustomobject]@{
                action               = $Action
                phoneNumber          = $PhoneNumber.Trim()
                targetId             = $TargetId.Trim()
                before               = $before
                after                = $after
                diff                 = @($diff)
                valid                = $true
                dryRun               = $false
                requiresConfirmation = $false
            }
            return [pscustomobject]@{
                plan           = $plan
                result         = @{ targetId = $TargetId.Trim(); phoneNumber = $PhoneNumber.Trim() }
                teamOperation  = New-TeamsVoiceOperation -TenantId $TenantId -Action $Action -TargetId $TargetId.Trim() -Before $before -After $after -State 'applied'
                auditEvent     = New-TeamsVoiceAuditEvent -TenantId $TenantId -Action $Action -TargetId $TargetId.Trim() -Before $before -After $after
                success        = $true
            }
        }
        'release' {
            $assignment = Get-CsPhoneNumberAssignment -Identity $NumberId.Trim() -ErrorAction Stop
            if (-not $assignment) {
                throw "NotFound: phone-number assignment '$($NumberId.Trim())' not found"
            }
            $before = Get-TeamsVoiceNumberRow -Assignment $assignment
            $after = @{
                id         = $before['id']
                number     = $before['number']
                type       = $before['type']
                assignedTo = ''
                state      = 'Unassigned'
            }
            $diff = [System.Collections.Generic.List[string]]::new()
            $null = $diff.Add("Release phone number '$($before['number'])' from '$($before['assignedTo'])'")

            $plan = [pscustomobject]@{
                action               = $Action
                numberId             = $NumberId.Trim()
                phoneNumber          = $before['number']
                before               = $before
                after                = $after
                diff                 = @($diff)
                valid                = $true
                dryRun               = $DryRun
                requiresConfirmation = $true
            }

            if ($DryRun) {
                return $plan
            }
            if (-not $Confirmed) {
                throw "voice.confirm_required: release requires explicit confirmation"
            }

            $null = Remove-CsPhoneNumberAssignment -Identity $NumberId.Trim() -ErrorAction Stop
            return [pscustomobject]@{
                plan           = $plan
                result         = @{ numberId = $NumberId.Trim(); phoneNumber = $before['number'] }
                teamOperation  = New-TeamsVoiceOperation -TenantId $TenantId -Action $Action -TargetId $before['assignedTo'] -Before $before -After $after -State 'applied'
                auditEvent     = New-TeamsVoiceAuditEvent -TenantId $TenantId -Action $Action -TargetId $before['assignedTo'] -Before $before -After $after
                success        = $true
            }
        }
        'policy' {
            $before = Get-TeamsVoiceCurrentUser -TargetId $TargetId
            $after = @{
                id                    = $TargetId
                displayName           = $before['displayName']
                enterpriseVoiceEnabled = $before['enterpriseVoiceEnabled']
                lineUri               = $before['lineUri']
                voiceRoutingPolicy    = $PolicyId.Trim()
            }
            $diff = [System.Collections.Generic.List[string]]::new()
            if ($before['voiceRoutingPolicy'] -eq $PolicyId.Trim()) {
                $null = $diff.Add("User '$TargetId' already carries voice policy '$($PolicyId.Trim())'; no change applied")
            }
            else {
                $null = $diff.Add("Assign voice routing policy '$($PolicyId.Trim())' to '$TargetId'")
            }

            $plan = [pscustomobject]@{
                action               = $Action
                policyId             = $PolicyId.Trim()
                targetId             = $TargetId.Trim()
                before               = $before
                after                = $after
                diff                 = @($diff)
                valid                = $true
                dryRun               = $DryRun
                requiresConfirmation = $false
            }

            if ($DryRun) {
                return $plan
            }
            if (-not $Confirmed) {
                throw "voice.confirm_required: action '$Action' requires explicit confirmation"
            }

            if ($before['voiceRoutingPolicy'] -eq $PolicyId.Trim()) {
                return [pscustomobject]@{
                    plan           = $plan
                    result         = @{ targetId = $TargetId.Trim(); policyId = $PolicyId.Trim(); noop = $true }
                    teamOperation  = New-TeamsVoiceOperation -TenantId $TenantId -Action $Action -TargetId $TargetId.Trim() -Before $before -After $after -State 'noop'
                    auditEvent     = New-TeamsVoiceAuditEvent -TenantId $TenantId -Action $Action -TargetId $TargetId.Trim() -Before $before -After $after -Note 'already assigned; no change applied'
                    noop           = $true
                    success        = $true
                }
            }

            $null = Grant-CsOnlineVoiceRoutingPolicy -Identity $TargetId.Trim() -PolicyName $PolicyId.Trim() -ErrorAction Stop
            $refreshed = Get-TeamsVoiceCurrentUser -TargetId $TargetId.Trim()
            $after = @{
                id                    = $TargetId.Trim()
                displayName           = $refreshed['displayName']
                enterpriseVoiceEnabled = $refreshed['enterpriseVoiceEnabled']
                lineUri               = $refreshed['lineUri']
                voiceRoutingPolicy    = $PolicyId.Trim()
            }
            $plan = [pscustomobject]@{
                action               = $Action
                policyId             = $PolicyId.Trim()
                targetId             = $TargetId.Trim()
                before               = $before
                after                = $after
                diff                 = @($diff)
                valid                = $true
                dryRun               = $false
                requiresConfirmation = $false
            }
            return [pscustomobject]@{
                plan           = $plan
                result         = @{ targetId = $TargetId.Trim(); policyId = $PolicyId.Trim() }
                teamOperation  = New-TeamsVoiceOperation -TenantId $TenantId -Action $Action -TargetId $TargetId.Trim() -Before $before -After $after -State 'applied'
                auditEvent     = New-TeamsVoiceAuditEvent -TenantId $TenantId -Action $Action -TargetId $TargetId.Trim() -Before $before -After $after
                success        = $true
            }
        }
    }
}

function New-TeamsVoiceOperation {
    <#
    .SYNOPSIS
        Builds the TeamOperation audit record for one applied voice change.
    .DESCRIPTION
        Shapes the T-0501 TeamOperation row: id, tenantId, teamId (voice is
        tenant-scoped, so the tenant id is the scope), operation, state, by,
        at, and result. The route persists it through the injected sink.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$TargetId,
        [Parameter(Mandatory)]$Before,
        [Parameter(Mandatory)]$After,
        [Parameter(Mandatory)][ValidateSet('applied', 'noop', 'failed')][string]$State
    )

    return @{
        id        = [guid]::NewGuid().ToString()
        tenantId  = $TenantId
        teamId    = $TenantId
        operation = "voice.$Action"
        state     = $State
        by        = $null
        at        = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        result    = if ($State -eq 'applied') { 'applied' } else { 'noop' }
    }
}

function New-TeamsVoiceAuditEvent {
    <#
    .SYNOPSIS
        Builds the audit event for one applied voice change.
    .DESCRIPTION
        Shapes the app audit sink event: id, tenantId, action, targetId,
        targetName, timestamp, before, after, and an optional note.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$TargetId,
        [Parameter(Mandatory)]$Before,
        [Parameter(Mandatory)]$After,
        [Parameter()][string]$Note = ''
    )

    $auditEvent = @{
        id         = [guid]::NewGuid().ToString()
        tenantId   = $TenantId
        action     = "voice.$Action"
        targetId   = $TargetId
        targetName = $TargetId
        timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        before     = $Before
        after      = $After
    }
    if ($Note) {
        $auditEvent['note'] = $Note
    }
    return $auditEvent
}
