# Get-Groups.ps1 — EPIC-014 Groups read (SPEC §3.1, §6, §11.1; T-0261, T-0900).
#
# Live Graph + optional Exchange Online reads only: groups are never mirrored to disk.
# Emits group items with type discrimination (m365, security, mailEnabledSecurity, distribution, dynamic),
# derived membership count, owner count, hiddenFromAddressListsEnabled, deliveryManagementEnabled,
# grantSendOnBehalfTo, and dynamic membership rule.
# The worker is read-only: only GET requests and read-only EXO cmdlets are issued.

function Read-GroupsJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-Groups.
    .PARAMETER Path
        Path to the job envelope JSON file.
    .EXAMPLE
        Read-GroupsJob -Path './job.json'
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

    $result = @{
        TenantId       = [string]$json.tenantId
        Type           = if ($json.type) { [string]$json.type } else { '' }
        Hidden         = if ($null -ne $json.hidden) { [string]$json.hidden } else { '' }
        Dynamic        = if ($null -ne $json.dynamic) { [string]$json.dynamic } else { '' }
        MembershipSize = if ($json.membershipSize) { [string]$json.membershipSize } else { '' }
        Search         = if ($json.search) { [string]$json.search } else { '' }
        Top            = if ($json.top) { [int]$json.top } else { 100 }
        Cursor         = if ($json.cursor) { [string]$json.cursor } else { '' }
    }
    return $result
}

function ConvertTo-GroupsCursor {
    <#
    .SYNOPSIS
        Encodes an integer offset into an opaque base64 cursor.
    .PARAMETER Offset
        Zero-based item offset.
    .EXAMPLE
        ConvertTo-GroupsCursor -Offset 100
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [int]$Offset
    )
    if ($Offset -le 0) { return '' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("offset:$Offset")
    return [System.Convert]::ToBase64String($bytes)
}

function ConvertFrom-GroupsCursor {
    <#
    .SYNOPSIS
        Decodes an opaque base64 cursor into an integer offset.
    .PARAMETER Cursor
        Opaque cursor string.
    .EXAMPLE
        ConvertFrom-GroupsCursor -Cursor 'b2Zmc2V0OjEwMA=='
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter()]
        [string]$Cursor
    )
    if ([string]::IsNullOrWhiteSpace($Cursor)) { return 0 }
    try {
        $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Cursor))
        if ($decoded -match '^offset:(\d+)$') {
            return [int]$Matches[1]
        }
        return 0
    }
    catch {
        return 0
    }
}

function Get-DiscriminatedGroupType {
    <#
    .SYNOPSIS
        Classifies a Graph group object into the EPIC-014 groupType enum.
    .PARAMETER GroupEntry
        Raw Microsoft Graph group object.
    .EXAMPLE
        Get-DiscriminatedGroupType -GroupEntry $entry
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [object]$GroupEntry
    )

    $groupTypes = @()
    if ($GroupEntry.groupTypes) {
        $groupTypes = @($GroupEntry.groupTypes)
    }

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
    if ($securityEnabled) {
        return 'security'
    }

    return 'security'
}

function ConvertTo-SendOnBehalfList {
    <#
    .SYNOPSIS
        Normalizes EXO GrantSendOnBehalfTo values into a unique string array.
    .PARAMETER RawGrants
        Raw GrantSendOnBehalfTo collection from EXO or Graph fallback.
    .EXAMPLE
        ConvertTo-SendOnBehalfList -RawGrants @('alice@example.invalid')
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter()]
        [object]$RawGrants
    )

    $list = [System.Collections.Generic.List[string]]::new()
    if ($null -eq $RawGrants) {
        return ,@()
    }

    foreach ($item in @($RawGrants)) {
        if ($null -eq $item) { continue }
        $val = if ($item -is [string]) {
            $item.Trim()
        }
        elseif ($item.PSObject.Properties['PrimarySmtpAddress'] -and -not [string]::IsNullOrWhiteSpace([string]$item.PrimarySmtpAddress)) {
            ([string]$item.PrimarySmtpAddress).Trim()
        }
        elseif ($item.PSObject.Properties['UserPrincipalName'] -and -not [string]::IsNullOrWhiteSpace([string]$item.UserPrincipalName)) {
            ([string]$item.UserPrincipalName).Trim()
        }
        elseif ($item.PSObject.Properties['Mail'] -and -not [string]::IsNullOrWhiteSpace([string]$item.Mail)) {
            ([string]$item.Mail).Trim()
        }
        elseif ($item.PSObject.Properties['Name'] -and -not [string]::IsNullOrWhiteSpace([string]$item.Name)) {
            ([string]$item.Name).Trim()
        }
        else {
            ([string]$item).Trim()
        }

        if (-not [string]::IsNullOrWhiteSpace($val) -and (-not $list.Contains($val))) {
            $list.Add($val)
        }
    }

    return ,@($list.ToArray())
}

function Add-ExoGroupMapEntry {
    <#
    .SYNOPSIS
        Indexes an Exchange Online group object into ID and mail lookup maps.
    .PARAMETER Map
        Lookup container holding ById and ByMail hashtables.
    .PARAMETER ExoObject
        Exchange Online UnifiedGroup or DistributionGroup object.
    .EXAMPLE
        Add-ExoGroupMapEntry -Map $map -ExoObject $exoGroup
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Map,

        [Parameter(Mandatory)]
        [object]$ExoObject
    )

    foreach ($idProp in @('ExternalDirectoryObjectId', 'Id', 'Guid', 'Identity')) {
        if ($ExoObject.PSObject.Properties[$idProp]) {
            $key = [string]$ExoObject.$idProp
            if (-not [string]::IsNullOrWhiteSpace($key)) {
                $Map.ById[$key.Trim()] = $ExoObject
            }
        }
        elseif ($ExoObject -is [System.Collections.IDictionary] -and $ExoObject.Contains($idProp)) {
            $key = [string]$ExoObject[$idProp]
            if (-not [string]::IsNullOrWhiteSpace($key)) {
                $Map.ById[$key.Trim()] = $ExoObject
            }
        }
    }

    foreach ($mailProp in @('PrimarySmtpAddress', 'WindowsEmailAddress')) {
        if ($ExoObject.PSObject.Properties[$mailProp]) {
            $mailKey = [string]$ExoObject.$mailProp
            if (-not [string]::IsNullOrWhiteSpace($mailKey)) {
                $Map.ByMail[$mailKey.Trim()] = $ExoObject
            }
        }
        elseif ($ExoObject -is [System.Collections.IDictionary] -and $ExoObject.Contains($mailProp)) {
            $mailKey = [string]$ExoObject[$mailProp]
            if (-not [string]::IsNullOrWhiteSpace($mailKey)) {
                $Map.ByMail[$mailKey.Trim()] = $ExoObject
            }
        }
    }
}

function Invoke-ExoGroupQuery {
    <#
    .SYNOPSIS
        Queries an Exchange Online group cmdlet when available and indexes results.
    .PARAMETER CmdletName
        Name of the read-only EXO cmdlet (Get-UnifiedGroup or Get-DistributionGroup).
    .PARAMETER CandidateGroups
        Graph groups matching this EXO group category.
    .PARAMETER Map
        Lookup container holding ById and ByMail hashtables.
    .EXAMPLE
        Invoke-ExoGroupQuery -CmdletName 'Get-UnifiedGroup' -CandidateGroups $m365Groups -Map $map
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$CmdletName,

        [Parameter(Mandatory)]
        [object[]]$CandidateGroups,

        [Parameter(Mandatory)]
        [hashtable]$Map
    )

    if ($CandidateGroups.Count -eq 0) {
        return
    }

    $cmd = Get-Command -Name $CmdletName -ErrorAction SilentlyContinue
    if (-not $cmd) {
        return
    }

    try {
        $results = @()
        if ($cmd.Parameters.ContainsKey('ResultSize')) {
            $queryParams = @{ ResultSize = 'Unlimited' }
            $results = @(& $CmdletName @queryParams)
        }
        else {
            $results = @(& $CmdletName)
        }

        foreach ($item in $results) {
            if ($null -ne $item) {
                Add-ExoGroupMapEntry -Map $Map -ExoObject $item
            }
        }

        if ($results.Count -eq 0 -and $cmd.Parameters.ContainsKey('Identity')) {
            foreach ($candidate in $CandidateGroups) {
                $identityValue = if ($candidate.id) { [string]$candidate.id } elseif ($candidate.mail) { [string]$candidate.mail } else { '' }
                if ([string]::IsNullOrWhiteSpace($identityValue)) { continue }
                $single = & $CmdletName -Identity $identityValue
                if ($null -ne $single) {
                    foreach ($item in @($single)) {
                        if ($null -ne $item) {
                            Add-ExoGroupMapEntry -Map $Map -ExoObject $item
                        }
                    }
                }
            }
        }
    }
    catch {
        Write-Verbose "$CmdletName enrichment unavailable; falling back to Graph properties: $($_.Exception.Message)"
    }
}

function Get-ExoGroupSettingsMap {
    <#
    .SYNOPSIS
        Builds an EXO group settings lookup table for mail-enabled groups when EXO is available.
    .PARAMETER RawGroups
        Raw Microsoft Graph group entries.
    .EXAMPLE
        Get-ExoGroupSettingsMap -RawGroups $allRawGroups
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter()]
        [object[]]$RawGroups = @()
    )

    $map = @{
        ById   = [hashtable]::new([System.StringComparer]::OrdinalIgnoreCase)
        ByMail = [hashtable]::new([System.StringComparer]::OrdinalIgnoreCase)
    }

    $m365Groups = [System.Collections.Generic.List[object]]::new()
    $dgGroups = [System.Collections.Generic.List[object]]::new()

    foreach ($entry in $RawGroups) {
        if ($null -eq $entry) { continue }
        $kind = Get-DiscriminatedGroupType -GroupEntry $entry
        if ($kind -eq 'm365') {
            $m365Groups.Add($entry)
        }
        elseif ($kind -in @('distribution', 'mailEnabledSecurity')) {
            $dgGroups.Add($entry)
        }
    }

    if ($m365Groups.Count -gt 0) {
        Invoke-ExoGroupQuery -CmdletName 'Get-UnifiedGroup' -CandidateGroups @($m365Groups) -Map $map
    }
    if ($dgGroups.Count -gt 0) {
        Invoke-ExoGroupQuery -CmdletName 'Get-DistributionGroup' -CandidateGroups @($dgGroups) -Map $map
    }

    return $map
}

function ConvertTo-GroupRow {
    <#
    .SYNOPSIS
        Maps a raw Graph group entry (with optional EXO enrichment) into a portal group row.
    .PARAMETER Entry
        Raw Microsoft Graph group object.
    .PARAMETER ExoEntry
        Optional Exchange Online UnifiedGroup or DistributionGroup object.
    .EXAMPLE
        ConvertTo-GroupRow -Entry $entry -ExoEntry $exo
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Entry,

        [Parameter()]
        [object]$ExoEntry = $null
    )

    $groupType = Get-DiscriminatedGroupType -GroupEntry $Entry
    $groupTypes = if ($Entry.groupTypes) { @($Entry.groupTypes) } else { @() }
    $isDynamic = ($groupType -eq 'dynamic') -or ($groupTypes -contains 'DynamicMembership') -or (-not [string]::IsNullOrWhiteSpace([string]$Entry.membershipRule))

    $membershipCount = 0
    if ($null -ne $Entry.'members@odata.count') {
        $membershipCount = [int]$Entry.'members@odata.count'
    }
    elseif ($null -ne $Entry.membershipCount) {
        $membershipCount = [int]$Entry.membershipCount
    }
    elseif ($Entry.members -is [System.Collections.IEnumerable] -and $Entry.members -isnot [string]) {
        $membershipCount = @($Entry.members).Count
    }

    $ownerCount = 0
    if ($null -ne $Entry.'owners@odata.count') {
        $ownerCount = [int]$Entry.'owners@odata.count'
    }
    elseif ($null -ne $Entry.ownerCount) {
        $ownerCount = [int]$Entry.ownerCount
    }
    elseif ($Entry.owners -is [System.Collections.IEnumerable] -and $Entry.owners -isnot [string]) {
        $ownerCount = @($Entry.owners).Count
    }

    $hiddenFromGal = $false
    if ($null -ne $ExoEntry -and $null -ne $ExoEntry.HiddenFromAddressListsEnabled) {
        $hiddenFromGal = [bool]$ExoEntry.HiddenFromAddressListsEnabled
    }
    elseif ($null -ne $Entry.hideFromAddressLists) {
        $hiddenFromGal = [bool]$Entry.hideFromAddressLists
    }
    elseif ($null -ne $Entry.hiddenFromAddressListsEnabled) {
        $hiddenFromGal = [bool]$Entry.hiddenFromAddressListsEnabled
    }

    $deliveryMgmt = $false
    if ($null -ne $ExoEntry -and $null -ne $ExoEntry.RequireSenderAuthenticationEnabled) {
        $deliveryMgmt = [bool]$ExoEntry.RequireSenderAuthenticationEnabled
    }
    elseif ($null -ne $Entry.deliveryManagementEnabled) {
        $deliveryMgmt = [bool]$Entry.deliveryManagementEnabled
    }
    elseif ($null -ne $Entry.requireSenderAuthenticationEnabled) {
        $deliveryMgmt = [bool]$Entry.requireSenderAuthenticationEnabled
    }
    elseif ($null -ne $Entry.hasDeliveryManagement) {
        $deliveryMgmt = [bool]$Entry.hasDeliveryManagement
    }

    $grantSendOnBehalfTo = @()
    if ($null -ne $ExoEntry -and $null -ne $ExoEntry.GrantSendOnBehalfTo) {
        $grantSendOnBehalfTo = ConvertTo-SendOnBehalfList -RawGrants $ExoEntry.GrantSendOnBehalfTo
    }
    elseif ($null -ne $Entry.grantSendOnBehalfTo) {
        $grantSendOnBehalfTo = ConvertTo-SendOnBehalfList -RawGrants $Entry.grantSendOnBehalfTo
    }

    $displayName = if ($Entry.displayName) { [string]$Entry.displayName } else { '' }
    $id = if ($Entry.id) { [string]$Entry.id } else { '' }
    $mail = if ($Entry.mail) { [string]$Entry.mail } else { '' }
    $description = if ($Entry.description) { [string]$Entry.description } else { '' }
    $dynamicRule = if ($Entry.membershipRule) { [string]$Entry.membershipRule } else { '' }

    return [pscustomobject]@{
        id                            = $id
        name                          = $displayName
        displayName                   = $displayName
        description                   = $description
        type                          = $groupType
        groupType                     = $groupType
        membershipCount               = $membershipCount
        ownerCount                    = $ownerCount
        hiddenFromAddressListsEnabled = $hiddenFromGal
        deliveryManagementEnabled     = $deliveryMgmt
        grantSendOnBehalfTo           = @($grantSendOnBehalfTo)
        dynamicRule                   = $dynamicRule
        isDynamic                     = $isDynamic
        mail                          = $mail
    }
}

function Test-GroupFilter {
    <#
    .SYNOPSIS
        Evaluates whether a mapped group row matches the requested filters.
    .PARAMETER Row
        Mapped group row object.
    .PARAMETER Type
        Optional group type filter.
    .PARAMETER Hidden
        Optional GAL visibility filter.
    .PARAMETER Dynamic
        Optional dynamic membership filter.
    .PARAMETER MembershipSize
        Optional membership size bucket filter.
    .PARAMETER Search
        Optional substring search term.
    .EXAMPLE
        Test-GroupFilter -Row $row -Type 'm365'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Row,

        [Parameter()]
        [string]$Type = '',

        [Parameter()]
        [string]$Hidden = '',

        [Parameter()]
        [string]$Dynamic = '',

        [Parameter()]
        [string]$MembershipSize = '',

        [Parameter()]
        [string]$Search = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($Type)) {
        if ($Row.type.ToLowerInvariant() -ne $Type.ToLowerInvariant()) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Hidden)) {
        $h = $Hidden.ToLowerInvariant()
        if ($h -in @('true', '1', 'hidden')) {
            if (-not $Row.hiddenFromAddressListsEnabled) { return $false }
        }
        elseif ($h -in @('false', '0', 'visible')) {
            if ($Row.hiddenFromAddressListsEnabled) { return $false }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Dynamic)) {
        $d = $Dynamic.ToLowerInvariant()
        if ($d -in @('true', '1')) {
            if (-not $Row.isDynamic) { return $false }
        }
        elseif ($d -in @('false', '0')) {
            if ($Row.isDynamic) { return $false }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($MembershipSize)) {
        $s = $MembershipSize.ToLowerInvariant()
        switch ($s) {
            'empty' {
                if ($Row.membershipCount -ne 0) { return $false }
            }
            'small' {
                if ($Row.membershipCount -lt 1 -or $Row.membershipCount -gt 10) { return $false }
            }
            'medium' {
                if ($Row.membershipCount -lt 11 -or $Row.membershipCount -gt 50) { return $false }
            }
            'large' {
                if ($Row.membershipCount -le 50) { return $false }
            }
            default {
                if ($s -match '^(\d+)$') {
                    if ($Row.membershipCount -ne [int]$Matches[1]) { return $false }
                }
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Search)) {
        $term = $Search.ToLowerInvariant()
        $matched = ($Row.name -and $Row.name.ToLowerInvariant().Contains($term)) -or
                   ($Row.mail -and $Row.mail.ToLowerInvariant().Contains($term)) -or
                   ($Row.description -and $Row.description.ToLowerInvariant().Contains($term))
        if (-not $matched) { return $false }
    }

    return $true
}

function Get-Groups {
    <#
    .SYNOPSIS
        Lists tenant groups live from Microsoft Graph (enriched with EXO delivery settings when available).
    .PARAMETER TenantId
        Target tenant identifier.
    .PARAMETER Type
        Optional group type filter.
    .PARAMETER Hidden
        Optional hidden-from-GAL filter.
    .PARAMETER Dynamic
        Optional dynamic membership filter.
    .PARAMETER MembershipSize
        Optional membership size bucket filter.
    .PARAMETER Search
        Optional substring search term.
    .PARAMETER Top
        Page size limit (1-1000).
    .PARAMETER Cursor
        Opaque pagination cursor.
    .EXAMPLE
        Get-Groups -TenantId 'tenant-a' -Type 'distribution'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [ValidateSet('', 'm365', 'security', 'mailEnabledSecurity', 'distribution', 'dynamic')]
        [string]$Type = '',

        [Parameter()]
        [string]$Hidden = '',

        [Parameter()]
        [string]$Dynamic = '',

        [Parameter()]
        [string]$MembershipSize = '',

        [Parameter()]
        [string]$Search = '',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $allRawGroups = [System.Collections.Generic.List[object]]::new()
    $uri = "/v1.0/groups?`$select=id,displayName,description,groupTypes,mailEnabled,securityEnabled,mail,membershipRule,hideFromAddressLists&`$top=999"

    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        if ($null -ne $response -and $null -ne $response.value) {
            foreach ($entry in @($response.value)) {
                if ($null -ne $entry) {
                    $allRawGroups.Add($entry)
                }
            }
        }
        $uri = if ($response.'@odata.nextLink') { $response.'@odata.nextLink' } else { $null }
    } while ($uri)

    $exoMap = Get-ExoGroupSettingsMap -RawGroups @($allRawGroups)

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $allRawGroups) {
        $groupType = Get-DiscriminatedGroupType -GroupEntry $entry
        $exoEntry = $null
        if ($groupType -in @('m365', 'distribution', 'mailEnabledSecurity')) {
            $entryId = if ($entry.id) { ([string]$entry.id).Trim() } else { '' }
            $entryMail = if ($entry.mail) { ([string]$entry.mail).Trim() } else { '' }
            if ($entryId -and $exoMap.ById.ContainsKey($entryId)) {
                $exoEntry = $exoMap.ById[$entryId]
            }
            elseif ($entryMail -and $exoMap.ByMail.ContainsKey($entryMail)) {
                $exoEntry = $exoMap.ByMail[$entryMail]
            }
        }

        $row = ConvertTo-GroupRow -Entry $entry -ExoEntry $exoEntry
        if (Test-GroupFilter -Row $row -Type $Type -Hidden $Hidden -Dynamic $Dynamic -MembershipSize $MembershipSize -Search $Search) {
            $rows.Add($row)
        }
    }

    $offset = ConvertFrom-GroupsCursor -Cursor $Cursor
    if ($offset -lt 0) { $offset = 0 }

    $paged = [System.Collections.Generic.List[object]]::new()
    $end = [System.Math]::Min($offset + $Top, $rows.Count)
    for ($i = $offset; $i -lt $end; $i++) {
        $paged.Add($rows[$i])
    }

    $nextCursor = $null
    if ($end -lt $rows.Count) {
        $nextCursor = ConvertTo-GroupsCursor -Offset $end
    }

    return [pscustomobject]@{
        tenantId   = $TenantId
        totalCount = $rows.Count
        items      = @($paged)
        nextCursor = $nextCursor
    }
}
