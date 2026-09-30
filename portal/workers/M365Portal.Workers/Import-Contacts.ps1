# Import-Contacts.ps1 — EPIC-023 bulk contact CSV import worker (SPEC §3.1, §4.1, §6, §7, §8, §9; T-0444).
#
# Accepts a CSV body or a rows array, validates each row's external address,
# detects duplicates both within the file and against the tenant's existing
# mail contacts/mail users, and applies the valid rows one at a time through the
# EPIC-006 gated executor (Invoke-ContactAction). Every input row gets exactly
# one result — created, skipped-duplicate, invalid, or failed (ready on preview)
# — so a malformed address or a duplicate never aborts the rest of the file.
# Valid applies emit one AuditEvent each through the -WriteAudit seam and are
# returned in auditEvents for the supervisor to persist. The EXO session is
# connected by the entrypoint after materializing the tenant credential
# in-process; this file never touches secrets.

$script:ContactImportMaxRows = 500

function Get-ContactImportValue {
    <#
    .SYNOPSIS
        Reads a property from a hashtable or a PSCustomObject.
    .PARAMETER Object
        The row to read from.
    .PARAMETER Name
        The property name.
    .EXAMPLE
        Get-ContactImportValue -Object $row -Name 'externalAddress'
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter()]
        [object]$Object = $null,

        [Parameter(Mandatory)]
        [string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }
    if ($Object -is [System.Collections.IDictionary]) {
        return $Object[$Name]
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) {
        return $property.Value
    }
    return $null
}

function ConvertTo-ContactImportAddress {
    <#
    .SYNOPSIS
        Normalises an external address for duplicate comparison.
    .DESCRIPTION
        Trims, drops the EXO 'smtp:' prefix, and lower-cases so a CSV address and
        a tenant record compare case-insensitively.
    .PARAMETER Address
        The raw external address.
    .EXAMPLE
        ConvertTo-ContactImportAddress -Address 'smtp:Vendor@Example.com'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [string]$Address = ''
    )

    if ($null -eq $Address) {
        return ''
    }
    $value = $Address.Trim()
    if ($value -match '^(?i)smtp:') {
        $value = $value.Substring(5).Trim()
    }
    return $value.ToLowerInvariant()
}

function Test-ContactImportAddress {
    <#
    .SYNOPSIS
        Tests whether an external address is a plausible SMTP address.
    .PARAMETER Address
        The raw external address.
    .EXAMPLE
        Test-ContactImportAddress -Address 'vendor@example.com'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [string]$Address = ''
    )

    if ([string]::IsNullOrWhiteSpace($Address)) {
        return $false
    }
    $candidate = ConvertTo-ContactImportAddress -Address $Address
    return $candidate -match '^[^@\s]+@[^@\s]+\.[^@\s]+$'
}

function Test-ContactImportRow {
    <#
    .SYNOPSIS
        Returns the reason a row is invalid, or $null when it is valid.
    .PARAMETER DisplayName
        The row display name.
    .PARAMETER ExternalAddress
        The row external email address.
    .PARAMETER Type
        The row contact type.
    .EXAMPLE
        Test-ContactImportRow -DisplayName 'Vendor' -ExternalAddress 'v@example.com' -Type 'mailContact'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [string]$DisplayName = '',

        [Parameter()]
        [string]$ExternalAddress = '',

        [Parameter()]
        [string]$Type = ''
    )

    if ([string]::IsNullOrWhiteSpace($DisplayName)) {
        return 'displayName is required'
    }
    if ([string]::IsNullOrWhiteSpace($ExternalAddress)) {
        return 'externalAddress is required'
    }
    if ($Type -ne 'mailContact' -and $Type -ne 'mailUser') {
        return "type '$Type' must be one of: mailContact, mailUser"
    }
    if (-not (Test-ContactImportAddress -Address $ExternalAddress)) {
        return "externalAddress '$ExternalAddress' is not a valid email address"
    }
    return $null
}

function ConvertFrom-ContactImportCsv {
    <#
    .SYNOPSIS
        Parses a contacts import CSV into row hashtables.
    .DESCRIPTION
        Accepts the columns displayName, externalAddress, type, and hiddenFromGal
        and requires externalAddress. Rows are returned in file order so the
        caller can report one result per input row.
    .PARAMETER Csv
        The CSV body text.
    .EXAMPLE
        ConvertFrom-ContactImportCsv -Csv $csv
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Csv
    )

    $records = @($Csv | ConvertFrom-Csv)
    if ($records.Count -eq 0) {
        throw 'CSV body has no data rows'
    }
    $headers = @($records[0].PSObject.Properties.Name)
    if ($headers -notcontains 'externalAddress') {
        throw "CSV is missing the 'externalAddress' column"
    }
    return , @(foreach ($record in $records) {
            @{
                displayName     = [string]$record.displayName
                externalAddress = [string]$record.externalAddress
                type            = [string]$record.type
                hiddenFromGal   = [string]$record.hiddenFromGal
            }
        })
}

function Get-ContactImportExistingAddresses {
    <#
    .SYNOPSIS
        Reads the tenant's existing contact external addresses for duplicate detection.
    .DESCRIPTION
        Pages Get-MailContact and Get-MailUser once and returns the normalised
        external addresses as a case-insensitive set. Only Get- cmdlets are
        issued; nothing is written to the tenant and nothing is mirrored to disk.
    .EXAMPLE
        Get-ContactImportExistingAddresses
    #>
    [CmdletBinding()]
    [OutputType([System.Collections.Generic.HashSet[string]])]
    param()

    $addresses = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $records = @()
    $records += @(Get-MailContact -ResultSize Unlimited -Properties DisplayName, ExternalEmailAddress, RecipientTypeDetails)
    $records += @(Get-MailUser -ResultSize Unlimited -Properties DisplayName, ExternalEmailAddress, RecipientTypeDetails)
    foreach ($record in $records) {
        if ($null -eq $record) {
            continue
        }
        $normalized = ConvertTo-ContactImportAddress -Address ([string]$record.ExternalEmailAddress)
        if ($normalized.Length -gt 0) {
            $null = $addresses.Add($normalized)
        }
    }
    return , $addresses
}

function Invoke-ContactsImport {
    <#
    .SYNOPSIS
        Validates and imports contacts, reporting one result per input row.
    .DESCRIPTION
        Validates every row's address and type, flags duplicates within the file
        and against the tenant's existing contacts, and applies the remaining
        rows one at a time through Invoke-ContactAction (the EPIC-006 gated
        executor) so every valid apply is audited. A row that fails validation,
        duplicates another, or fails at apply time is reported on its own row;
        it never aborts its siblings. Preview returns ready/skipped-duplicate/
        invalid rows with no tenant write.
    .PARAMETER TenantId
        Tenant the contacts belong to. Carried through to the result envelope.
    .PARAMETER Rows
        Import rows. Each row carries displayName, externalAddress, type, and
        hiddenFromGal.
    .PARAMETER Csv
        CSV body text; parsed into rows when Rows is not supplied.
    .PARAMETER Preview
        Plan only: no tenant write, no audit.
    .PARAMETER Actor
        Caller identity recorded on each audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on each audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-ContactsImport -TenantId 'tenant-a' -Csv $csv
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [object[]]$Rows = @(),

        [Parameter()]
        [string]$Csv = '',

        [Parameter()]
        [switch]$Preview,

        [Parameter()]
        [string]$Actor = 'system',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    if (-not [string]::IsNullOrWhiteSpace($Csv)) {
        try {
            $Rows = ConvertFrom-ContactImportCsv -Csv $Csv
        }
        catch {
            return @{ error = 'contacts.csv_invalid'; message = $_.Exception.Message; statusCode = 400 }
        }
    }
    $Rows = @($Rows | Where-Object { $null -ne $_ })
    if ($Rows.Count -eq 0) {
        return @{ error = 'contacts.validation_failed'; message = 'no contact rows to import'; statusCode = 400 }
    }
    if ($Rows.Count -gt $script:ContactImportMaxRows) {
        return @{ error = 'contacts.validation_failed'; message = "at most $($script:ContactImportMaxRows) contacts per import"; statusCode = 400 }
    }

    $existing = Get-ContactImportExistingAddresses
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $results = [System.Collections.Generic.List[object]]::new()
    $sink = $WriteAudit
    $collected = [System.Collections.Generic.List[object]]::new()
    $captureAudit = { param($AuditEvent) $collected.Add($AuditEvent); & $sink $AuditEvent }

    for ($index = 0; $index -lt $Rows.Count; $index++) {
        $row = $Rows[$index]
        $displayName = ([string](Get-ContactImportValue -Object $row -Name 'displayName')).Trim()
        $externalAddress = ([string](Get-ContactImportValue -Object $row -Name 'externalAddress')).Trim()
        $type = ([string](Get-ContactImportValue -Object $row -Name 'type')).Trim()
        if ([string]::IsNullOrWhiteSpace($type)) {
            $type = 'mailContact'
        }
        $hiddenRaw = Get-ContactImportValue -Object $row -Name 'hiddenFromGal'
        $hidden = ($hiddenRaw -eq $true) -or (([string]$hiddenRaw).Trim().ToLowerInvariant() -eq 'true')

        $result = @{
            row             = $index + 1
            displayName     = $displayName
            externalAddress = $externalAddress
            status          = 'created'
            reason          = $null
            contactId       = $null
        }

        $problem = Test-ContactImportRow -DisplayName $displayName -ExternalAddress $externalAddress -Type $type
        if ($problem) {
            $result.status = 'invalid'
            $result.reason = $problem
            $results.Add($result)
            continue
        }

        $normalized = ConvertTo-ContactImportAddress -Address $externalAddress
        if (-not $seen.Add($normalized)) {
            $result.status = 'skipped-duplicate'
            $result.reason = 'address appears earlier in this import'
            $results.Add($result)
            continue
        }
        if ($existing.Contains($normalized)) {
            $result.status = 'skipped-duplicate'
            $result.reason = 'address already exists in the tenant'
            $results.Add($result)
            continue
        }

        if ($Preview) {
            $result.status = 'ready'
            $results.Add($result)
            continue
        }

        $outcome = Invoke-ContactAction -TenantId $TenantId -Action 'create' -DisplayName $displayName -ExternalAddress $externalAddress -Type $type -HiddenFromGal $hidden -Actor $Actor -CorrelationId $CorrelationId -WriteAudit $captureAudit
        if ($outcome.success -eq $true) {
            $result.status = 'created'
            if ($outcome.auditEvent -and $outcome.auditEvent.contactId) {
                $result.contactId = [string]$outcome.auditEvent.contactId
            }
        }
        else {
            $result.status = 'failed'
            $result.reason = [string]$outcome.error
        }
        $results.Add($result)
    }

    $count = { param($status) @($results | Where-Object { $_.status -eq $status }).Count }
    return @{
        tenantId    = $TenantId
        preview     = [bool]$Preview
        rows        = @($results)
        summary     = @{
            total            = $results.Count
            created          = & $count 'created'
            skippedDuplicate = & $count 'skipped-duplicate'
            invalid          = & $count 'invalid'
            failed           = & $count 'failed'
            ready            = & $count 'ready'
        }
        auditEvents = @($collected)
    }
}

function Read-ContactsImportJob {
    <#
    .SYNOPSIS
        Reads a contacts import job envelope file into Invoke-ContactsImport parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the CSV
        body or rows array plus the preview and audit fields. The envelope
        carries references only; secrets are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-ContactsImportJob -Path './run/contacts-import-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Contacts import job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Contacts import job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Contacts import job is missing required field: tenantId'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }

    $rows = @()
    $rawRows = $payload['rows']
    if ($null -ne $rawRows -and $rawRows -isnot [string] -and $rawRows -is [System.Collections.IEnumerable]) {
        $rows = @($rawRows)
    }

    return @{
        TenantId      = $tenantId
        Csv           = [string]$payload['csv']
        Rows          = $rows
        Preview       = ($payload['preview'] -eq $true)
        Actor         = [string]$payload['actor']
        CorrelationId = [string]$job['correlationId']
    }
}
