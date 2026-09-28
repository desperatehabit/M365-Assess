# Set-EnrollmentProfile.ps1 - EPIC-017 enrollment profile worker (SPEC section 3.5, section 4.4, section 8; T-0329).
#
# Platforms:
#   apple-ade          depIOSEnrollmentProfile / depMacOSEnrollmentProfile under an ADE token
#                      (depOnboardingSettings/{tokenId}/enrollmentProfiles); assigned to device serials.
#   android-enterprise androidDeviceOwnerEnrollmentProfile; devices enroll with the profile's token.
# Actions (job field 'action'):
#   list   - every profile plus the status of every enrollment token (Apple ADE tokens and
#            Android profile tokens): expiry date, days remaining, ok / expiring / expired.
#   create / update / delete / assign - previewed (plan with before/after) or applied, each
#            applied write returning an audit event with before/after.
# Android enrollment secrets (tokenValue, QR code) let anyone enroll a device into the tenant;
# they are stripped from every result, plan, and audit event.

$script:EnrollBeta = '/beta/deviceManagement'
$script:EnrollExpiringDays = 30
$script:EnrollSecretFields = @('tokenValue', 'qrCodeContent', 'qrCodeImage')
$script:EnrollReadOnlyFields = @('id', 'createdDateTime', 'lastModifiedDateTime', 'enrolledDeviceCount', 'tokenCreationDateTime', 'tokenExpirationDateTime', 'isDefault', '@odata.context') + $script:EnrollSecretFields

function Read-EnrollmentProfileJob {
    <#
    .SYNOPSIS
        Parses a job document for Set-EnrollmentProfile.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "job envelope not found at '$Path'"
    }
    $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
    if (-not $json['tenantId']) { throw "job envelope '$Path' is missing mandatory 'tenantId'" }
    if (@('list', 'create', 'update', 'delete', 'assign') -notcontains [string]$json['action']) {
        throw "job envelope '$Path' has unknown action '$($json['action'])'"
    }
    if ($json['action'] -ne 'list' -and @('apple-ade', 'android-enterprise') -notcontains [string]$json['platform']) {
        throw "job envelope '$Path' has unknown platform '$($json['platform'])'"
    }
    return $json
}

function Get-EnrollValue {
    # Reads a property from a hashtable or a PSCustomObject.
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function Get-EnrollCollection {
    <#
    .SYNOPSIS
        GETs a Graph collection and follows @odata.nextLink to the end.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param([Parameter(Mandatory)][string]$Uri)

    $items = [System.Collections.Generic.List[object]]::new()
    $next = $Uri
    while ($next) {
        $response = Invoke-MgGraphRequest -Method GET -Uri $next
        foreach ($item in @(Get-EnrollValue -Object $response -Name 'value')) { if ($null -ne $item) { $items.Add($item) } }
        $next = Get-EnrollValue -Object $response -Name '@odata.nextLink'
    }
    return , $items.ToArray()
}

function Remove-EnrollmentSecret {
    <#
    .SYNOPSIS
        Copies a Graph object into a hashtable without enrollment secrets.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([object]$Object)

    if ($null -eq $Object) { return $null }
    $copy = @{}
    $keys = if ($Object -is [System.Collections.IDictionary]) { $Object.Keys } else { $Object.PSObject.Properties.Name }
    foreach ($key in $keys) {
        if ($script:EnrollSecretFields -notcontains $key) { $copy[[string]$key] = Get-EnrollValue -Object $Object -Name $key }
    }
    return $copy
}

function Get-EnrollmentTokenState {
    <#
    .SYNOPSIS
        Classifies a token expiry: expired, expiring (within 30 days), ok, or unknown.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([object]$ExpiresAt, [datetime]$Now = (Get-Date).ToUniversalTime())

    if (-not $ExpiresAt) { return @{ expiresAt = $null; daysRemaining = $null; state = 'unknown' } }
    $expiry = [datetime]::Parse([string]$ExpiresAt, [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal)
    $days = [int][Math]::Floor(($expiry - $Now).TotalDays)
    $state = if ($expiry -le $Now) { 'expired' } elseif ($days -lt $script:EnrollExpiringDays) { 'expiring' } else { 'ok' }
    return @{ expiresAt = $expiry.ToString('o'); daysRemaining = $days; state = $state }
}

function Get-EnrollmentProfiles {
    <#
    .SYNOPSIS
        Lists Apple ADE and Android Enterprise enrollment profiles with token status.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [datetime]$Now = (Get-Date).ToUniversalTime()
    )

    $profiles = [System.Collections.Generic.List[hashtable]]::new()
    $tokens = [System.Collections.Generic.List[hashtable]]::new()

    foreach ($dep in (Get-EnrollCollection -Uri "$script:EnrollBeta/depOnboardingSettings")) {
        $depId = [string](Get-EnrollValue -Object $dep -Name 'id')
        $status = Get-EnrollmentTokenState -ExpiresAt (Get-EnrollValue -Object $dep -Name 'tokenExpirationDateTime') -Now $Now
        $tokens.Add(@{
                platform       = 'apple-ade'
                id             = $depId
                name           = [string](Get-EnrollValue -Object $dep -Name 'tokenName')
                appleId        = [string](Get-EnrollValue -Object $dep -Name 'appleIdentifier')
                lastSyncAt     = Get-EnrollValue -Object $dep -Name 'lastSuccessfulSyncDateTime'
                expiresAt      = $status.expiresAt
                daysRemaining  = $status.daysRemaining
                state          = $status.state
            })
        foreach ($p in (Get-EnrollCollection -Uri "$script:EnrollBeta/depOnboardingSettings/$depId/enrollmentProfiles")) {
            $profiles.Add(@{
                    platform               = 'apple-ade'
                    id                     = [string](Get-EnrollValue -Object $p -Name 'id')
                    displayName            = [string](Get-EnrollValue -Object $p -Name 'displayName')
                    profileType            = (([string](Get-EnrollValue -Object $p -Name '@odata.type')) -replace '#microsoft.graph.', '')
                    depOnboardingSettingId = $depId
                    isDefault              = [bool](Get-EnrollValue -Object $p -Name 'isDefault')
                    tokenState             = $status.state
                    tokenExpiresAt         = $status.expiresAt
                })
        }
    }

    foreach ($p in (Get-EnrollCollection -Uri "$script:EnrollBeta/androidDeviceOwnerEnrollmentProfiles")) {
        $id = [string](Get-EnrollValue -Object $p -Name 'id')
        $status = Get-EnrollmentTokenState -ExpiresAt (Get-EnrollValue -Object $p -Name 'tokenExpirationDateTime') -Now $Now
        $name = [string](Get-EnrollValue -Object $p -Name 'displayName')
        $profiles.Add(@{
                platform            = 'android-enterprise'
                id                  = $id
                displayName         = $name
                profileType         = 'androidDeviceOwnerEnrollmentProfile'
                enrollmentMode      = [string](Get-EnrollValue -Object $p -Name 'enrollmentMode')
                enrolledDeviceCount = Get-EnrollValue -Object $p -Name 'enrolledDeviceCount'
                tokenState          = $status.state
                tokenExpiresAt      = $status.expiresAt
            })
        $tokens.Add(@{ platform = 'android-enterprise'; id = $id; name = $name; expiresAt = $status.expiresAt; daysRemaining = $status.daysRemaining; state = $status.state })
    }

    return @{ tenantId = $TenantId; profiles = @($profiles); tokens = @($tokens) }
}

function Get-EnrollmentProfileUri {
    # The Graph path for a platform's profile collection, or one profile.
    param([Parameter(Mandatory)][string]$Platform, [string]$DepOnboardingSettingId, [string]$ProfileId)
    $base = if ($Platform -eq 'apple-ade') {
        if (-not $DepOnboardingSettingId) { throw [System.ArgumentException]::new('depOnboardingSettingId is required for an Apple ADE profile') }
        "$script:EnrollBeta/depOnboardingSettings/$([uri]::EscapeDataString($DepOnboardingSettingId))/enrollmentProfiles"
    }
    else { "$script:EnrollBeta/androidDeviceOwnerEnrollmentProfiles" }
    if ($ProfileId) { return "$base/$([uri]::EscapeDataString($ProfileId))" }
    return $base
}

function Get-EnrollmentProfileCurrent {
    # Reads one live profile (secrets removed); $null when it does not exist.
    param([Parameter(Mandatory)][string]$Uri)
    try { return Remove-EnrollmentSecret -Object (Invoke-MgGraphRequest -Method GET -Uri $Uri) }
    catch {
        if ($_.Exception.Message -match '404|NotFound|ResourceNotFound') { return $null }
        throw
    }
}

function Invoke-EnrollmentProfileWrite {
    <#
    .SYNOPSIS
        Previews or applies an enrollment profile create, update, delete, or Apple device assignment.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [Parameter(Mandatory)][ValidateSet('create', 'update', 'delete', 'assign')][string]$Action,
        [Parameter(Mandatory)][ValidateSet('apple-ade', 'android-enterprise')][string]$Platform,
        [string]$DepOnboardingSettingId = '',
        [string]$ProfileId = '',
        [System.Collections.IDictionary]$ProfileBody = @{},
        [string[]]$SerialNumbers = @(),
        [string]$ConfirmName = '',
        [switch]$Preview,
        [string]$Actor = 'system'
    )

    try {
        if ($Action -ne 'create' -and -not $ProfileId) { throw [System.ArgumentException]::new("profileId is required to $Action a profile") }
        if ($Action -eq 'assign' -and $Platform -ne 'apple-ade') {
            throw [System.ArgumentException]::new('Android Enterprise profiles are not assigned; devices enroll with the profile token')
        }
        if ($Action -eq 'assign' -and $SerialNumbers.Count -eq 0) { throw [System.ArgumentException]::new('at least one device serial number is required') }
        $collectionUri = Get-EnrollmentProfileUri -Platform $Platform -DepOnboardingSettingId $DepOnboardingSettingId
        $itemUri = if ($ProfileId) { Get-EnrollmentProfileUri -Platform $Platform -DepOnboardingSettingId $DepOnboardingSettingId -ProfileId $ProfileId } else { $null }
    }
    catch [System.ArgumentException] {
        return @{ error = 'request.validation_failed'; message = $_.Exception.Message; statusCode = 400 }
    }

    $before = if ($itemUri) { Get-EnrollmentProfileCurrent -Uri $itemUri } else { $null }
    if ($Action -ne 'create' -and $null -eq $before) {
        return @{ error = 'enrollment-profile.not_found'; message = "enrollment profile '$ProfileId' not found"; statusCode = 404 }
    }

    $body = @{}
    foreach ($key in $ProfileBody.Keys) { if ($script:EnrollReadOnlyFields -notcontains $key) { $body[[string]$key] = $ProfileBody[$key] } }
    if ($Platform -eq 'android-enterprise' -and -not $body['@odata.type']) { $body['@odata.type'] = '#microsoft.graph.androidDeviceOwnerEnrollmentProfile' }

    $after = switch ($Action) {
        'create' { $body }
        'update' { $merged = @{} + $before; foreach ($k in $body.Keys) { $merged[$k] = $body[$k] }; $merged }
        'delete' { $null }
        'assign' { @{ assignedSerialNumbers = @($SerialNumbers) } }
    }
    $plan = @{
        action   = $Action
        platform = $Platform
        profileId = $ProfileId
        before   = $before
        after    = $after
        requiresConfirmation = ($Action -eq 'delete')
    }

    if ($Action -eq 'delete' -and -not $Preview -and $ConfirmName -cne [string]$before['displayName']) {
        return @{ error = 'enrollment-profile.confirmation_required'; message = "type the profile name '$($before['displayName'])' to confirm deletion"; statusCode = 400; plan = $plan }
    }
    if ($Preview -or -not $PSCmdlet.ShouldProcess($TenantId, "$Action $Platform enrollment profile")) {
        return @{ tenantId = $TenantId; preview = $true; plan = $plan; auditEvent = $null }
    }

    $json = { param($o) $o | ConvertTo-Json -Depth 20 -Compress }
    switch ($Action) {
        'create' {
            $created = Invoke-MgGraphRequest -Method POST -Uri $collectionUri -Body (& $json $body)
            $ProfileId = [string](Get-EnrollValue -Object $created -Name 'id')
            $after = Remove-EnrollmentSecret -Object $created
        }
        'update' { $null = Invoke-MgGraphRequest -Method PATCH -Uri $itemUri -Body (& $json $body) }
        'delete' { $null = Invoke-MgGraphRequest -Method DELETE -Uri $itemUri }
        'assign' { $null = Invoke-MgGraphRequest -Method POST -Uri "$itemUri/updateDeviceProfileAssignment" -Body (& $json @{ deviceIds = @($SerialNumbers) }) }
    }

    return @{
        tenantId   = $TenantId
        preview    = $false
        profileId  = $ProfileId
        plan       = $plan
        auditEvent = @{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = "intune.enrollment-profile.$Action"
            targetId   = $ProfileId
            targetName = if ($after -and $after['displayName']) { [string]$after['displayName'] } elseif ($before) { [string]$before['displayName'] } else { '' }
            platform   = $Platform
            actor      = $Actor
            timestamp  = (Get-Date).ToUniversalTime().ToString('o')
            before     = $before
            after      = $after
            result     = 'success'
        }
    }
}
