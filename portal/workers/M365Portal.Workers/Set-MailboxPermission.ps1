# Set-MailboxPermission.ps1 — EPIC-020 mailbox/calendar permission worker (SPEC §3.3, §4.2, §5, §6, §11.1; T-0384).
#
# Covers add/edit (grant) and remove for mailbox permissions (FullAccess,
# SendAs, SendOnBehalf) and calendar folder permissions. Supports DryRun (plan
# preview mode returning the effective permission change without mutating).
#
# Gating (EPIC-006 contract, T-0107): grants are security-sensitive, so they
# follow the same contract as the shared-mailbox cut — the BFF confirms the
# plan before dispatch (dryRun plans only), -DryRun reports the intended
# change without writing, -Confirmed is re-checked here so a job that skips
# confirmation cannot apply, every apply captures before/after, and every
# grant or removal emits one audit record for the app audit sink and the
# MailboxOperation row. The supervisor connects EXO in the child process after
# materializing the tenant credential in-process; this file never touches secrets.

function Test-MailboxPermissionInput {
    <#
    .SYNOPSIS
        Validates one planned mailbox or calendar permission change.
    .DESCRIPTION
        Mirrors the BFF route validation so the worker refuses the same rows
        the BFF would: missing principal, unknown scope or permission type,
        and missing calendar access rights. Returns the error list; empty is valid.
    .PARAMETER Scope
        'mailbox' or 'calendar'.
    .PARAMETER PermissionType
        FullAccess, SendAs, or SendOnBehalf for mailbox scope; ignored for calendar.
    .PARAMETER Principal
        The grantee identity.
    .PARAMETER AccessRights
        Calendar folder rights; required for calendar scope.
    .EXAMPLE
        Test-MailboxPermissionInput -Scope 'mailbox' -PermissionType 'FullAccess' -Principal 'delegate'
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter()]
        [string]$Scope = 'mailbox',

        [Parameter()]
        [string]$PermissionType = '',

        [Parameter()]
        [string]$Principal = '',

        [Parameter()]
        [string[]]$AccessRights = @()
    )

    $errors = [System.Collections.Generic.List[string]]::new()
    if ($Scope -ne 'mailbox' -and $Scope -ne 'calendar') {
        $errors.Add("scope '$Scope' must be 'mailbox' or 'calendar'")
    }
    if ([string]::IsNullOrWhiteSpace($Principal)) {
        $errors.Add('principal is required')
    }
    if ($Scope -eq 'mailbox' -and $PermissionType -notin @('FullAccess', 'SendAs', 'SendOnBehalf')) {
        $errors.Add("permissionType '$PermissionType' must be one of: FullAccess, SendAs, SendOnBehalf")
    }
    if ($Scope -eq 'calendar' -and @($AccessRights).Count -eq 0) {
        $errors.Add('accessRights must be a non-empty array for calendar permissions')
    }
    return @($errors)
}

function Get-MailboxPermissionBefore {
    <#
    .SYNOPSIS
        Reads the current grant for one principal for the before snapshot.
    .DESCRIPTION
        Returns the existing mailbox or calendar grant as a hashtable, or null
        when no grant exists. A failed calendar read yields null so one
        unavailable slice cannot fail the plan.
    .PARAMETER MailboxId
        Mailbox identity.
    .PARAMETER Scope
        'mailbox' or 'calendar'.
    .PARAMETER PermissionType
        Mailbox permission type; ignored for calendar scope.
    .PARAMETER Principal
        The grantee identity.
    .PARAMETER Folder
        Calendar folder path suffix for calendar scope.
    .EXAMPLE
        Get-MailboxPermissionBefore -MailboxId 'mbx-1' -Scope 'mailbox' -PermissionType 'FullAccess' -Principal 'delegate'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId,

        [Parameter()]
        [ValidateSet('mailbox', 'calendar')]
        [string]$Scope = 'mailbox',

        [Parameter()]
        [string]$PermissionType = 'FullAccess',

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Principal,

        [Parameter()]
        [string]$Folder = 'Calendar'
    )

    $key = $Principal.Trim()
    if ($Scope -eq 'calendar') {
        try {
            $entries = @(Get-EXOMailboxFolderPermission -Identity "${MailboxId}:\$Folder" -ErrorAction Stop)
            foreach ($entry in $entries) {
                if ([string]$entry.User -eq $key) {
                    return @{
                        principal    = $key
                        scope        = 'calendar'
                        accessRights = @($entry.AccessRights)
                        automap      = $false
                        inherited    = $false
                    }
                }
            }
        }
        catch {
            Write-Verbose "Calendar permissions unavailable for '$MailboxId': $($_.Exception.Message)"
        }
        return $null
    }

    if ($PermissionType -eq 'FullAccess') {
        $grants = @(Get-MailboxPermission -Identity $MailboxId -ErrorAction Stop | Where-Object { [string]$_.User -eq $key })
        foreach ($grant in $grants) {
            return @{
                principal      = $key
                scope          = 'mailbox'
                permissionType = 'FullAccess'
                accessRights   = @($grant.AccessRights)
                automap        = ($grant.AutoMapping -ne $false)
                inherited      = [bool]$grant.IsInherited
            }
        }
        return $null
    }

    if ($PermissionType -eq 'SendAs') {
        $grants = @(Get-RecipientPermission -Identity $MailboxId -ErrorAction Stop | Where-Object { [string]$_.Trustee -eq $key })
        foreach ($grant in $grants) {
            return @{
                principal      = $key
                scope          = 'mailbox'
                permissionType = 'SendAs'
                accessRights   = @('SendAs')
                automap        = $false
                inherited      = $false
            }
        }
        return $null
    }

    $mailbox = Get-EXOMailbox -Identity $MailboxId -Properties GrantSendOnBehalfTo -ErrorAction Stop
    foreach ($delegate in @($mailbox.GrantSendOnBehalfTo)) {
        if ([string]$delegate -eq $key) {
            return @{
                principal      = $key
                scope          = 'mailbox'
                permissionType = 'SendOnBehalf'
                accessRights   = @('SendOnBehalf')
                automap        = $false
                inherited      = $false
            }
        }
    }
    return $null
}

function Read-SetMailboxPermissionJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-SetMailboxPermission parameters.
    .DESCRIPTION
        Validates the envelope carries a tenant, mailbox, action, and grantee,
        then returns the planned permission change with confirmation and
        dry-run flags. The envelope carries references and planned values only.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-SetMailboxPermissionJob -Path './run/mailbox-permission-job.json'
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
    if (-not $json.mailboxId) {
        throw "job envelope '$Path' is missing mandatory 'mailboxId'"
    }
    if (-not $json.action) {
        throw "job envelope '$Path' is missing mandatory 'action'"
    }
    if (-not $json.principal) {
        throw "job envelope '$Path' is missing mandatory 'principal'"
    }

    $rights = @()
    if ($json.accessRights) {
        $rights = @($json.accessRights | ForEach-Object { [string]$_ })
    }

    return @{
        TenantId       = [string]$json.tenantId
        Action         = [string]$json.action
        MailboxId      = [string]$json.mailboxId
        Scope          = if ($json.scope) { [string]$json.scope } else { 'mailbox' }
        PermissionType = if ($json.permissionType) { [string]$json.permissionType } else { 'FullAccess' }
        Principal      = [string]$json.principal
        AccessRights   = $rights
        Automapping    = if ($null -ne $json.automap) { [bool]$json.automap } else { $true }
        Folder         = if ($json.folder) { [string]$json.folder } else { 'Calendar' }
        Confirmed      = [bool]($json.confirmed -eq $true)
        DryRun         = [bool]($json.dryRun -eq $true)
    }
}

function Invoke-SetMailboxPermission {
    <#
    .SYNOPSIS
        Previews or applies one mailbox or calendar permission add/edit/remove.
    .DESCRIPTION
        -DryRun returns the plan showing the effective permission change with
        no EXO write. Without -DryRun, -Confirmed is required or the apply is
        refused. Add and edit both grant (edit replaces the current grant);
        remove withdraws it and throws NotFound when no grant exists. Every
        apply captures before/after and emits one auditEvent with the
        mailbox.permission.grant/remove action for the app audit sink and the
        MailboxOperation row.
    .PARAMETER TenantId
        Tenant the mailbox belongs to. Carried through to the result envelope.
    .PARAMETER Action
        'add' grants, 'edit' replaces the current grant, 'remove' withdraws it.
    .PARAMETER MailboxId
        Mailbox identity.
    .PARAMETER Scope
        'mailbox' or 'calendar'.
    .PARAMETER PermissionType
        FullAccess, SendAs, or SendOnBehalf for mailbox scope.
    .PARAMETER Principal
        The grantee identity.
    .PARAMETER AccessRights
        Calendar folder rights for calendar scope.
    .PARAMETER Automapping
        FullAccess automapping flag.
    .PARAMETER Folder
        Calendar folder path suffix for calendar scope.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for apply; the BFF confirms the plan before dispatch.
    .EXAMPLE
        Invoke-SetMailboxPermission -TenantId 'tenant-a' -Action 'add' -MailboxId 'mbx-1' -PermissionType 'FullAccess' -Principal 'delegate' -Confirmed -DryRun
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('add', 'edit', 'remove')]
        [string]$Action,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId,

        [Parameter()]
        [ValidateSet('mailbox', 'calendar')]
        [string]$Scope = 'mailbox',

        [Parameter()]
        [string]$PermissionType = 'FullAccess',

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Principal,

        [Parameter()]
        [string[]]$AccessRights = @(),

        [Parameter()]
        [bool]$Automapping = $true,

        [Parameter()]
        [string]$Folder = 'Calendar',

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false
    )

    $mailboxKey = $MailboxId.Trim()
    $grantee = $Principal.Trim()
    $failures = @(Test-MailboxPermissionInput -Scope $Scope -PermissionType $PermissionType -Principal $grantee -AccessRights $AccessRights)
    if ($failures.Count -gt 0) {
        throw "ValidationFailed: $($failures -join '; ')"
    }

    $existing = Get-EXOMailbox -Identity $mailboxKey -Properties PrimarySmtpAddress, GrantSendOnBehalfTo -ErrorAction Stop
    if (-not $existing) {
        throw "NotFound: Mailbox '$mailboxKey' not found"
    }
    $targetName = $mailboxKey

    $before = Get-MailboxPermissionBefore -MailboxId $mailboxKey -Scope $Scope -PermissionType $PermissionType -Principal $grantee -Folder $Folder

    $diff = [System.Collections.Generic.List[string]]::new()
    $after = $null
    if ($Scope -eq 'calendar') {
        $rightsText = ($AccessRights -join ', ')
        if ($Action -eq 'remove') {
            if (-not $before) {
                throw "NotFound: Calendar permission for '$grantee' on mailbox '$mailboxKey' not found"
            }
            $diff.Add("Remove calendar rights '$rightsText' on mailbox '$targetName' from '$grantee'")
        }
        elseif ($Action -eq 'edit' -and $before) {
            $diff.Add("Change calendar rights on mailbox '$targetName' for '$grantee' from '$($before['accessRights'] -join ', ')' to '$rightsText'")
            $after = @{ principal = $grantee; scope = 'calendar'; accessRights = @($AccessRights); automap = $false; inherited = $false }
        }
        else {
            $diff.Add("Grant calendar rights '$rightsText' on mailbox '$targetName' to '$grantee'")
            $after = @{ principal = $grantee; scope = 'calendar'; accessRights = @($AccessRights); automap = $false; inherited = $false }
        }
    }
    else {
        if ($Action -eq 'remove') {
            if (-not $before) {
                throw "NotFound: $PermissionType permission for '$grantee' on mailbox '$mailboxKey' not found"
            }
            $diff.Add("Remove $PermissionType on mailbox '$targetName' from '$grantee'")
        }
        elseif ($Action -eq 'edit' -and $before) {
            $diff.Add("Change $PermissionType on mailbox '$targetName' for '$grantee'")
            $after = @{ principal = $grantee; scope = 'mailbox'; permissionType = $PermissionType; accessRights = @($before['accessRights']); automap = [bool]$before['automap']; inherited = $false }
            if ($PermissionType -eq 'FullAccess') {
                $after['automap'] = $Automapping
            }
        }
        else {
            $verb = if ($Action -eq 'edit') { 'Grant' } else { 'Grant' }
            $diff.Add("$verb $PermissionType on mailbox '$targetName' to '$grantee'")
            $rights = @($PermissionType)
            if ($PermissionType -eq 'FullAccess') {
                $rights = @('FullAccess')
            }
            $after = @{ principal = $grantee; scope = 'mailbox'; permissionType = $PermissionType; accessRights = $rights; automap = ($PermissionType -eq 'FullAccess' -and $Automapping); inherited = $false }
        }
    }

    $shownType = $PermissionType
    if ($Scope -eq 'calendar') {
        $shownType = 'Calendar'
    }
    $plan = [pscustomobject]@{
        action               = $Action
        mailboxId            = $mailboxKey
        scope                = $Scope
        principal            = $grantee
        permissionType       = $shownType
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
        throw "mailbox.confirm_required: action '$Action' requires explicit confirmation"
    }

    if ($Scope -eq 'calendar') {
        $folderIdentity = "${mailboxKey}:\$Folder"
        if ($Action -eq 'remove') {
            $null = Remove-MailboxFolderPermission -Identity $folderIdentity -User $grantee -Confirm:$false
        }
        elseif ($before) {
            $null = Set-MailboxFolderPermission -Identity $folderIdentity -User $grantee -AccessRights $AccessRights
            $after = @{ principal = $grantee; scope = 'calendar'; accessRights = @($AccessRights); automap = $false; inherited = $false }
        }
        else {
            $null = Add-MailboxFolderPermission -Identity $folderIdentity -User $grantee -AccessRights $AccessRights
        }
    }
    elseif ($PermissionType -eq 'FullAccess') {
        if ($Action -eq 'remove') {
            $null = Remove-MailboxPermission -Identity $mailboxKey -User $grantee -AccessRights FullAccess -Confirm:$false
        }
        else {
            if ($Action -eq 'edit' -and $before) {
                $null = Remove-MailboxPermission -Identity $mailboxKey -User $grantee -AccessRights FullAccess -Confirm:$false
            }
            $null = Add-MailboxPermission -Identity $mailboxKey -User $grantee -AccessRights FullAccess -AutoMapping:$Automapping
            $after = @{ principal = $grantee; scope = 'mailbox'; permissionType = 'FullAccess'; accessRights = @('FullAccess'); automap = $Automapping; inherited = $false }
        }
    }
    elseif ($PermissionType -eq 'SendAs') {
        if ($Action -eq 'remove') {
            $null = Remove-RecipientPermission -Identity $mailboxKey -Trustee $grantee -AccessRights SendAs -Confirm:$false
        }
        else {
            if ($Action -eq 'edit' -and $before) {
                $null = Remove-RecipientPermission -Identity $mailboxKey -Trustee $grantee -AccessRights SendAs -Confirm:$false
            }
            $null = Add-RecipientPermission -Identity $mailboxKey -Trustee $grantee -AccessRights SendAs -Confirm:$false
            $after = @{ principal = $grantee; scope = 'mailbox'; permissionType = 'SendAs'; accessRights = @('SendAs'); automap = $false; inherited = $false }
        }
    }
    else {
        if ($Action -eq 'remove') {
            $null = Set-Mailbox -Identity $mailboxKey -GrantSendOnBehalfTo @{ Remove = $grantee }
        }
        else {
            $null = Set-Mailbox -Identity $mailboxKey -GrantSendOnBehalfTo @{ Add = $grantee }
            $after = @{ principal = $grantee; scope = 'mailbox'; permissionType = 'SendOnBehalf'; accessRights = @('SendOnBehalf'); automap = $false; inherited = $false }
        }
    }

    $auditAction = 'mailbox.permission.grant'
    if ($Action -eq 'remove') {
        $auditAction = 'mailbox.permission.remove'
    }
    $plan = [pscustomobject]@{
        action               = $Action
        mailboxId            = $mailboxKey
        scope                = $Scope
        principal            = $grantee
        permissionType       = $shownType
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $false
        requiresConfirmation = $false
    }

    return [pscustomobject]@{
        plan       = $plan
        result     = @{ mailboxId = $mailboxKey; principal = $grantee; scope = $Scope; permissionType = $shownType; action = $Action }
        auditEvent = @{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = $auditAction
            targetId   = $mailboxKey
            targetName = $targetName
            timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            before     = $before
            after      = $after
        }
        success    = $true
    }
}
