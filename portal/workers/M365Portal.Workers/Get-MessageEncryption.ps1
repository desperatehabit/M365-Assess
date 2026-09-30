# Get-MessageEncryption.ps1 — EPIC-024 message encryption (SPEC §2 US-5, §3.5, §4.3, §6, §8, §10; T-0469).
#
# Live EXO reads for the IRM/OME configuration and OME template settings, plus
# the gated OME template write. The read path issues only Get- cmdlets. The
# write path follows the EPIC-006 gated-executor contract (T-0108): an OME
# template change is not a registry CheckId command, so it cannot travel the
# CheckId-bound executor path. It follows the same contract instead — the BFF
# confirms the plan before dispatch (dryRun plans only), -DryRun reports the
# intended change without writing, -Confirmed is re-checked here so a job that
# skips confirmation cannot apply, every apply captures before/after, and
# every apply emits one audit record. The supervisor connects EXO in the child
# process after materializing the tenant credential in-process; this file
# never touches secrets.

function Read-EncryptionProperty {
    <#
    .SYNOPSIS
        Reads one property defensively so an unavailable slice cannot hide the rest.
    .DESCRIPTION
        EXO returns PSObjects while job envelopes and tests carry hashtables;
        both shapes are supported so one unavailable slice cannot hide the rest
        of the configuration.
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [object]$Record,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Name
    )

    if ($null -eq $Record) {
        return $null
    }
    if ($Record -is [System.Collections.IDictionary]) {
        if ($Record.Contains($Name)) {
            return $Record[$Name]
        }
        return $null
    }
    if ($null -ne $Record.PSObject -and $null -ne $Record.PSObject.Properties[$Name]) {
        return $Record.$Name
    }
    return $null
}

function ConvertTo-EncryptionConfigRow {
    <#
    .SYNOPSIS
        Shapes one Get-IRMConfiguration record into the IRM configuration view.
    .DESCRIPTION
        IRM licensing flags ride on varying property names across EXO module
        versions; every known flag is read defensively and coerced to a
        boolean so the panel renders one stable shape.
    .PARAMETER Record
        The Get-IRMConfiguration record.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Record
    )

    $readFlag = {
        param([string]$Name)
        $value = Read-EncryptionProperty -Record $Record -Name $Name
        if ($null -eq $value) {
            return $false
        }
        return [bool]$value
    }

    return [pscustomobject]@{
        identity                 = [string](Read-EncryptionProperty -Record $Record -Name 'Identity')
        azureRmsLicensingEnabled = & $readFlag 'AzureRMSLicensingEnabled'
        internalLicensingEnabled = & $readFlag 'InternalLicensingEnabled'
        externalLicensingEnabled = & $readFlag 'ExternalLicensingEnabled'
    }
}

function ConvertTo-OmeTemplateRow {
    <#
    .SYNOPSIS
        Shapes one Get-OMEConfiguration record into the OME template view.
    .DESCRIPTION
        The OME configuration carries the template settings (expiry, portal,
        disclaimer, email, read-button, and introduction text). Text settings
        default to '' and the expiry to null when EXO reports none, so the
        editor always renders a complete row.
    .PARAMETER Record
        The Get-OMEConfiguration record.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Record
    )

    $expiry = Read-EncryptionProperty -Record $Record -Name 'ExternalMailExpiryInDays'
    $expiryDays = $null
    if ($null -ne $expiry) {
        $parsed = 0
        if ([int]::TryParse([string]$expiry, [ref]$parsed)) {
            $expiryDays = $parsed
        }
    }

    return [pscustomobject]@{
        identity                 = [string](Read-EncryptionProperty -Record $Record -Name 'Identity')
        externalMailExpiryInDays = $expiryDays
        portalText               = [string](Read-EncryptionProperty -Record $Record -Name 'PortalText')
        disclaimerText           = [string](Read-EncryptionProperty -Record $Record -Name 'DisclaimerText')
        emailText                = [string](Read-EncryptionProperty -Record $Record -Name 'EmailText')
        readButtonText           = [string](Read-EncryptionProperty -Record $Record -Name 'ReadButtonText')
        introductionText         = [string](Read-EncryptionProperty -Record $Record -Name 'IntroductionText')
    }
}

function Get-MessageEncryption {
    <#
    .SYNOPSIS
        Reads the IRM/OME configuration and OME template settings live from EXO.
    .DESCRIPTION
        Reads Get-IRMConfiguration once and Get-OMEConfiguration for every OME
        template, shapes both into the panel view, and returns them with the
        tenant and retrieval timestamp. Only Get- cmdlets are issued; nothing
        is written to the tenant and configuration data is never mirrored to
        disk.
    .PARAMETER TenantId
        Tenant the configuration belongs to. Carried through to the result envelope.
    .EXAMPLE
        Get-MessageEncryption -TenantId 'tenant-a'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId
    )

    $irm = Get-IRMConfiguration -ErrorAction Stop
    if ($irm -is [array]) {
        $irm = $irm | Select-Object -First 1
    }
    if ($null -eq $irm) {
        throw 'IRM configuration was not found (code: encryption.config_not_found)'
    }

    $omeRecords = @(Get-OMEConfiguration -ErrorAction Stop)
    $templates = [System.Collections.Generic.List[object]]::new()
    foreach ($record in $omeRecords) {
        if ($null -eq $record) {
            continue
        }
        $templates.Add((ConvertTo-OmeTemplateRow -Record $record))
    }

    return [pscustomobject]@{
        tenantId         = $TenantId
        irmConfiguration = ConvertTo-EncryptionConfigRow -Record $irm
        omeTemplates     = @($templates)
        retrievedAt      = (Get-Date -Format 'o')
    }
}

function Invoke-MessageEncryptionTemplate {
    <#
    .SYNOPSIS
        Previews or applies one OME template change under the EPIC-006 gate set.
    .DESCRIPTION
        -DryRun returns the plan with no EXO write. Without -DryRun,
        -Confirmed is required or the apply is refused. The current OME
        configuration is read first for the before snapshot; only settings in
        the supported OME set are accepted, and every apply emits one
        auditEvent with before/after for the app audit sink.
    .PARAMETER TenantId
        Tenant the template belongs to. Carried through to the result envelope.
    .PARAMETER TemplateId
        OME template identity. Empty selects the default template.
    .PARAMETER Settings
        Supported OME settings to change (externalMailExpiryInDays plus the
        five text settings). Unknown settings are refused.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for apply; the BFF confirms the plan before dispatch.
    .EXAMPLE
        Invoke-MessageEncryptionTemplate -TenantId 'tenant-a' -TemplateId 'Default' -Settings @{ portalText = 'Confidential' } -Confirmed -DryRun
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$TemplateId = '',

        [Parameter()]
        [hashtable]$Settings = @{},

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false
    )

    $templateKey = $TemplateId.Trim()
    if ([string]::IsNullOrWhiteSpace($templateKey)) {
        $templateKey = 'Default'
    }

    if ($Settings.Count -eq 0) {
        throw 'encryption.no_settings: at least one OME template setting must be supplied (code: encryption.no_settings)'
    }

    $current = Get-OMEConfiguration -Identity $templateKey -ErrorAction Stop
    if ($current -is [array]) {
        $current = $current | Select-Object -First 1
    }
    if ($null -eq $current) {
        throw "NotFound: OME template '$templateKey' was not found (code: encryption.template_not_found)"
    }

    $before = ConvertTo-OmeTemplateRow -Record $current

    $settingParameterNames = @{
        externalMailExpiryInDays = 'ExternalMailExpiryInDays'
        portalText               = 'PortalText'
        disclaimerText           = 'DisclaimerText'
        emailText                = 'EmailText'
        readButtonText           = 'ReadButtonText'
        introductionText         = 'IntroductionText'
    }

    $after = [ordered]@{
        identity                 = $before.identity
        externalMailExpiryInDays = $before.externalMailExpiryInDays
        portalText               = $before.portalText
        disclaimerText           = $before.disclaimerText
        emailText                = $before.emailText
        readButtonText           = $before.readButtonText
        introductionText         = $before.introductionText
    }

    $diff = [System.Collections.Generic.List[string]]::new()
    $setParameters = [ordered]@{}
    foreach ($name in @($Settings.Keys)) {
        if (-not $settingParameterNames.Contains($name)) {
            throw "encryption.unsupported_setting: '$name' is not a supported OME template setting (code: encryption.unsupported_setting)"
        }
        $value = $Settings[$name]
        $stringValue = [string]$value
        if ($name -eq 'externalMailExpiryInDays') {
            $parsed = 0
            if (-not [int]::TryParse($stringValue, [ref]$parsed) -or $parsed -lt 0) {
                throw "encryption.invalid_setting: 'externalMailExpiryInDays' must be a non-negative integer (code: encryption.invalid_setting)"
            }
            $setParameters[$settingParameterNames[$name]] = $parsed
            $after[$name] = $parsed
            $diff.Add("${name}: $($before.externalMailExpiryInDays) -> $parsed")
        }
        else {
            $setParameters[$settingParameterNames[$name]] = $stringValue
            $after[$name] = $stringValue
            $diff.Add("${name} updated")
        }
    }

    $plan = [pscustomobject]@{
        action               = 'ome-template-apply'
        templateId           = $templateKey
        targetName           = $before.identity
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = (-not $Confirmed)
    }

    if ($DryRun) {
        return $plan
    }

    if (-not $Confirmed) {
        throw "encryption.confirm_required: OME template change for '$templateKey' requires explicit confirmation (code: encryption.confirm_required)"
    }

    $null = Set-OMEConfiguration -Identity $templateKey @setParameters

    $plan = [pscustomobject]@{
        action               = 'ome-template-apply'
        templateId           = $templateKey
        targetName           = $before.identity
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $false
        requiresConfirmation = $false
    }

    return [pscustomobject]@{
        plan       = $plan
        result     = @{ templateId = $templateKey; state = 'applied' }
        auditEvent = @{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = 'mail.encryption_template.apply'
            targetId   = $templateKey
            targetName = $before.identity
            timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            before     = $before
            after      = $after
        }
        success    = $true
    }
}

function Read-MessageEncryptionJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into message-encryption parameters.
    .DESCRIPTION
        Validates the envelope carries a tenant, then returns the action
        (read/apply), the template identity, the settings to change, and the
        dry-run/confirmation flags. The envelope carries references and
        planned values only.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Message encryption job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Message encryption job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Message encryption job is missing required field: tenantId'
    }

    $action = [string]$job['action']
    if ([string]::IsNullOrWhiteSpace($action)) {
        $action = 'read'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }

    $settings = @{}
    $rawSettings = $payload['settings']
    if ($rawSettings -is [System.Collections.IDictionary]) {
        $settings = $rawSettings
    }

    return @{
        TenantId   = $tenantId
        Action     = $action
        TemplateId = if ($payload['templateId']) { [string]$payload['templateId'] } else { '' }
        Settings   = $settings
        DryRun     = [bool]($payload['dryRun'] -eq $true)
        Confirmed  = [bool]($payload['confirmed'] -eq $true)
    }
}
