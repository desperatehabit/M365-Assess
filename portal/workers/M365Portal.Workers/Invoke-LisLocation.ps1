# Invoke-LisLocation.ps1 — EPIC-026 Teams & Voice LIS Locations CRUD worker (SPEC §2 US-5, §3.4, §4.4, §6; T-0509).
#
# Covers list, create, edit, and delete for Location Information Service locations
# used for emergency calling. Validates required civic address fields before any
# write. Emits an AuditEvent on every write.

function Read-InvokeLisLocationJob {
    [CmdletBinding()]
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

    $result = @{
        TenantId    = [string]$json.tenantId
        Action      = [string]$json.action
        LocationId  = if ($json.locationId) { [string]$json.locationId } else { '' }
        DisplayName = if ($json.displayName) { [string]$json.displayName } else { '' }
        Street      = if ($json.street) { [string]$json.street } else { '' }
        City        = if ($json.city) { [string]$json.city } else { '' }
        State       = if ($json.state) { [string]$json.state } else { '' }
        Country     = if ($json.country) { [string]$json.country } else { '' }
        PostalCode  = if ($json.postalCode) { [string]$json.postalCode } else { '' }
        CompanyName = if ($json.companyName) { [string]$json.companyName } else { '' }
        ConfirmName = if ($json.confirmName) { [string]$json.confirmName } else { '' }
        DryRun      = [bool]($json.dryRun -eq $true)
    }

    return $result
}

function Test-CountryCodeFormat {
    param([string]$Code)
    if ([string]::IsNullOrWhiteSpace($Code)) { return $false }
    return ($Code.Trim() -match '^[A-Za-z]{2}$')
}

function Get-MissingCivicFields {
    param(
        [string]$DisplayName,
        [string]$Street,
        [string]$City,
        [string]$State,
        [string]$Country,
        [string]$PostalCode
    )

    $missing = @()
    if ([string]::IsNullOrWhiteSpace($DisplayName)) { $missing += 'displayName' }
    if ([string]::IsNullOrWhiteSpace($Street)) { $missing += 'street' }
    if ([string]::IsNullOrWhiteSpace($City)) { $missing += 'city' }
    if ([string]::IsNullOrWhiteSpace($State)) { $missing += 'state' }
    if ([string]::IsNullOrWhiteSpace($Country)) { $missing += 'country' }
    if ([string]::IsNullOrWhiteSpace($PostalCode)) { $missing += 'postalCode' }
    return $missing
}

function ConvertTo-LisLocationHashtable {
    param($RawLocation)

    if ($null -eq $RawLocation) { return $null }

    $id = if ($RawLocation['id']) { [string]$RawLocation['id'] } else { [string]$RawLocation.id }
    $displayName = if ($RawLocation['displayName']) { [string]$RawLocation['displayName'] } else { [string]$RawLocation.displayName }
    $companyName = if ($RawLocation['companyName']) { [string]$RawLocation['companyName'] } elseif ($RawLocation.companyName) { [string]$RawLocation.companyName } else { '' }

    $street = ''
    $city = ''
    $state = ''
    $country = ''
    $postalCode = ''

    $address = if ($RawLocation['address']) { $RawLocation['address'] } elseif ($RawLocation.address) { $RawLocation.address } else { $null }
    if ($address) {
        $street = if ($address['street']) { [string]$address['street'] } elseif ($address.street) { [string]$address.street } else { '' }
        $city = if ($address['city']) { [string]$address['city'] } elseif ($address.city) { [string]$address.city } else { '' }
        $state = if ($address['state']) { [string]$address['state'] } elseif ($address.state) { [string]$address.state } else { '' }
        $country = if ($address['country']) { [string]$address['country'] } elseif ($address.country) { [string]$address.country } elseif ($address['countryOrRegion']) { [string]$address.countryOrRegion } elseif ($address.countryOrRegion) { [string]$address.countryOrRegion } else { '' }
        $postalCode = if ($address['postalCode']) { [string]$address['postalCode'] } elseif ($address.postalCode) { [string]$address.postalCode } else { '' }
    }
    else {
        $street = if ($RawLocation['street']) { [string]$RawLocation['street'] } elseif ($RawLocation.street) { [string]$RawLocation.street } else { '' }
        $city = if ($RawLocation['city']) { [string]$RawLocation['city'] } elseif ($RawLocation.city) { [string]$RawLocation.city } else { '' }
        $state = if ($RawLocation['state']) { [string]$RawLocation['state'] } elseif ($RawLocation.state) { [string]$RawLocation.state } else { '' }
        $country = if ($RawLocation['country']) { [string]$RawLocation['country'] } elseif ($RawLocation.country) { [string]$RawLocation.country } elseif ($RawLocation['countryOrRegion']) { [string]$RawLocation.countryOrRegion } elseif ($RawLocation.countryOrRegion) { [string]$RawLocation.countryOrRegion } else { '' }
        $postalCode = if ($RawLocation['postalCode']) { [string]$RawLocation['postalCode'] } elseif ($RawLocation.postalCode) { [string]$RawLocation.postalCode } else { '' }
    }

    return @{
        id          = $id
        displayName = $displayName
        street      = $street
        city        = $city
        state       = $state
        country     = $country
        postalCode  = $postalCode
        companyName = $companyName
    }
}

function Build-LisLocationDiff {
    param(
        [hashtable]$Before,
        [hashtable]$After
    )

    $diff = @()
    if ($null -eq $Before -and $null -ne $After) {
        $diff += "+ LIS Location: $($After['displayName']) ($($After['city']), $($After['state']) $($After['country']))"
    }
    elseif ($null -ne $Before -and $null -eq $After) {
        $diff += "- LIS Location: $($Before['displayName']) ($($Before['city']), $($Before['state']) $($Before['country']))"
    }
    elseif ($null -ne $Before -and $null -ne $After) {
        if ($Before['displayName'] -ne $After['displayName']) {
            $diff += "~ DisplayName: '$($Before['displayName'])' -> '$($After['displayName'])'"
        }
        if ($Before['street'] -ne $After['street']) {
            $diff += "~ Street: '$($Before['street'])' -> '$($After['street'])'"
        }
        if ($Before['city'] -ne $After['city']) {
            $diff += "~ City: '$($Before['city'])' -> '$($After['city'])'"
        }
        if ($Before['state'] -ne $After['state']) {
            $diff += "~ State: '$($Before['state'])' -> '$($After['state'])'"
        }
        if ($Before['country'] -ne $After['country']) {
            $diff += "~ Country: '$($Before['country'])' -> '$($After['country'])'"
        }
        if ($Before['postalCode'] -ne $After['postalCode']) {
            $diff += "~ PostalCode: '$($Before['postalCode'])' -> '$($After['postalCode'])'"
        }
        if ($Before['companyName'] -ne $After['companyName']) {
            $diff += "~ CompanyName: '$($Before['companyName'])' -> '$($After['companyName'])'"
        }
    }

    if ($diff.Count -eq 0) {
        $diff += "No changes detected."
    }

    return $diff
}

function Invoke-LisLocation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('list', 'create', 'edit', 'delete')]
        [string]$Action,

        [Parameter()]
        [string]$LocationId = '',

        [Parameter()]
        [string]$DisplayName = '',

        [Parameter()]
        [string]$Street = '',

        [Parameter()]
        [string]$City = '',

        [Parameter()]
        [string]$State = '',

        [Parameter()]
        [string]$Country = '',

        [Parameter()]
        [string]$PostalCode = '',

        [Parameter()]
        [string]$CompanyName = '',

        [Parameter()]
        [string]$ConfirmName = '',

        [Parameter()]
        [bool]$DryRun = $false
    )

    if ($Action -eq 'list') {
        $response = Invoke-MgGraphRequest -Method GET -Uri '/v1.0/communications/lis/locations' -ErrorAction Stop
        $rawItems = @()
        if ($response -and $response['value']) {
            $rawItems = @($response['value'])
        }
        elseif ($response -and $response.value) {
            $rawItems = @($response.value)
        }

        $items = @()
        foreach ($raw in $rawItems) {
            $itemHash = ConvertTo-LisLocationHashtable -RawLocation $raw
            $items += [pscustomobject]@{
                id          = $itemHash['id']
                displayName = $itemHash['displayName']
                street      = $itemHash['street']
                city        = $itemHash['city']
                state       = $itemHash['state']
                country     = $itemHash['country']
                postalCode  = $itemHash['postalCode']
                companyName = $itemHash['companyName']
            }
        }

        return [pscustomobject]@{
            tenantId   = $TenantId
            totalCount = $items.Count
            items      = $items
        }
    }

    $before = $null
    $after = $null
    $targetName = $DisplayName

    if ($Action -eq 'create') {
        $missing = Get-MissingCivicFields -DisplayName $DisplayName -Street $Street -City $City -State $State -Country $Country -PostalCode $PostalCode
        if ($missing.Count -gt 0) {
            throw "ValidationFailed: $($missing -join ', ') required"
        }
        if (-not (Test-CountryCodeFormat -Code $Country)) {
            throw "ValidationFailed: Invalid country code '$Country'. Must be a 2-letter ISO 3166-1 alpha-2 code."
        }
        $targetName = $DisplayName

        $after = @{
            displayName = $DisplayName
            street      = $Street
            city        = $City
            state       = $State
            country     = $Country.Trim().ToUpperInvariant()
            postalCode  = $PostalCode
            companyName = $CompanyName
        }
    }
    else {
        if ([string]::IsNullOrWhiteSpace($LocationId)) {
            throw "ValidationFailed: locationId is required for $Action"
        }

        $existingRaw = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/communications/lis/locations/$LocationId" -ErrorAction Stop
        $before = ConvertTo-LisLocationHashtable -RawLocation $existingRaw
        $targetName = $before['displayName']

        if ($Action -eq 'edit') {
            $newDisplayName = if (-not [string]::IsNullOrWhiteSpace($DisplayName)) { $DisplayName } else { $before['displayName'] }
            $newStreet = if (-not [string]::IsNullOrWhiteSpace($Street)) { $Street } else { $before['street'] }
            $newCity = if (-not [string]::IsNullOrWhiteSpace($City)) { $City } else { $before['city'] }
            $newState = if (-not [string]::IsNullOrWhiteSpace($State)) { $State } else { $before['state'] }
            $newCountry = if (-not [string]::IsNullOrWhiteSpace($Country)) { $Country } else { $before['country'] }
            $newPostalCode = if (-not [string]::IsNullOrWhiteSpace($PostalCode)) { $PostalCode } else { $before['postalCode'] }
            $newCompanyName = if ($PSBoundParameters.ContainsKey('CompanyName') -and -not [string]::IsNullOrWhiteSpace($CompanyName)) { $CompanyName } else { $before['companyName'] }
            $targetName = $newDisplayName

            $missing = Get-MissingCivicFields -DisplayName $newDisplayName -Street $newStreet -City $newCity -State $newState -Country $newCountry -PostalCode $newPostalCode
            if ($missing.Count -gt 0) {
                throw "ValidationFailed: $($missing -join ', ') required"
            }
            if (-not (Test-CountryCodeFormat -Code $newCountry)) {
                throw "ValidationFailed: Invalid country code '$newCountry'. Must be a 2-letter ISO 3166-1 alpha-2 code."
            }

            $after = @{
                id          = $LocationId
                displayName = $newDisplayName
                street      = $newStreet
                city        = $newCity
                state       = $newState
                country     = $newCountry.Trim().ToUpperInvariant()
                postalCode  = $newPostalCode
                companyName = $newCompanyName
            }
        }
        elseif ($Action -eq 'delete') {
            $after = $null
        }
    }

    $diff = Build-LisLocationDiff -Before $before -After $after

    $plan = [pscustomobject]@{
        action               = $Action
        locationId           = if ($LocationId) { $LocationId } else { $null }
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = $diff
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = ($Action -eq 'delete')
    }

    if ($DryRun) {
        return [pscustomobject]@{
            success = $true
            plan    = $plan
        }
    }

    $result = $null
    if ($Action -eq 'create') {
        $bodyHash = @{
            displayName = $after['displayName']
            street      = $after['street']
            city        = $after['city']
            state       = $after['state']
            country     = $after['country']
            postalCode  = $after['postalCode']
        }
        if (-not [string]::IsNullOrWhiteSpace($after['companyName'])) {
            $bodyHash['companyName'] = $after['companyName']
        }

        $body = $bodyHash | ConvertTo-Json -Depth 10 -Compress
        $res = Invoke-MgGraphRequest -Method POST -Uri '/v1.0/communications/lis/locations' -Body $body -ErrorAction Stop
        $LocationId = if ($res -and $res.id) { [string]$res.id } else { [Guid]::NewGuid().ToString() }
        $plan.locationId = $LocationId
        $result = $res
    }
    elseif ($Action -eq 'edit') {
        $bodyHash = @{
            displayName = $after['displayName']
            street      = $after['street']
            city        = $after['city']
            state       = $after['state']
            country     = $after['country']
            postalCode  = $after['postalCode']
        }
        if (-not [string]::IsNullOrWhiteSpace($after['companyName'])) {
            $bodyHash['companyName'] = $after['companyName']
        }

        $body = $bodyHash | ConvertTo-Json -Depth 10 -Compress
        $res = Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/communications/lis/locations/$LocationId" -Body $body -ErrorAction Stop
        $result = $res
    }
    elseif ($Action -eq 'delete') {
        if ([string]::IsNullOrWhiteSpace($ConfirmName) -or ($ConfirmName.Trim() -ne $before['displayName'].Trim())) {
            throw "ValidationFailed: Deletion requires confirmation: confirmName must match '$($before['displayName'])'."
        }
        Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/communications/lis/locations/$LocationId" -ErrorAction Stop
        $result = @{ deleted = $true }
    }

    $auditEvent = [pscustomobject]@{
        id         = [Guid]::NewGuid().ToString()
        tenantId   = $TenantId
        action     = "teams.lis.$Action"
        targetId   = $LocationId
        targetName = $targetName
        timestamp  = (Get-Date).ToUniversalTime().ToString('o')
        before     = $before
        after      = $after
    }

    return [pscustomobject]@{
        success    = $true
        plan       = $plan
        result     = $result
        auditEvent = $auditEvent
    }
}
