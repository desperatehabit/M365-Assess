# Set-IntuneApp.ps1 - EPIC-017 app detail, update, and delete worker (SPEC section 3.1, section 8; T-0843).
#
# Actions (job field 'action'), for Win32 and Store apps (the T-0321 registry's v1 types):
#   get    - one app's configuration in the portal shape the upload wizard and templates use
#            (commands, install experience, architectures, detection rules mapped back from
#            Graph rules), with its assignment count.
#   update - previews or applies a metadata/command/rule change as a PATCH, with before/after.
#   delete - previews or applies a delete; applying needs the exact app name typed back.
# Graph requires @odata.type on a mobileApp PATCH, so every update carries it.
# Depends on ConvertTo-Win32DetectionRule from Queue-IntuneAppUpload.ps1 (dot-sourced first).

$script:IntuneAppBase = '/beta/deviceAppManagement/mobileApps'
$script:IntuneAppTypes = @{
    '#microsoft.graph.win32LobApp'                  = 'win32'
    '#microsoft.graph.winGetApp'                    = 'store'
    '#microsoft.graph.microsoftStoreForBusinessApp' = 'store'
}
$script:IntuneAppCommonFields = @('displayName', 'description', 'publisher')
$script:IntuneAppWin32Fields = @('installCommandLine', 'uninstallCommandLine', 'applicableArchitectures', 'minimumSupportedWindowsRelease')

function Read-IntuneAppJob {
    <#
    .SYNOPSIS
        Parses a job document for Set-IntuneApp.
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
    foreach ($field in @('tenantId', 'appId')) {
        if (-not $json[$field]) { throw "job envelope '$Path' is missing mandatory '$field'" }
    }
    if (@('get', 'update', 'delete') -notcontains [string]$json['action']) {
        throw "job envelope '$Path' has unknown action '$($json['action'])'"
    }
    return $json
}

function Get-IntuneAppField {
    # Reads a property from a hashtable or a PSCustomObject.
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function ConvertFrom-Win32DetectionRule {
    <#
    .SYNOPSIS
        Maps a Graph win32LobAppRule (detection) back to the portal rule shape.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][object]$Rule)

    $f = { param($n) Get-IntuneAppField -Object $Rule -Name $n }
    switch ([string](& $f '@odata.type')) {
        '#microsoft.graph.win32LobAppFileSystemRule' {
            return @{ type = 'file'; path = & $f 'path'; fileOrFolderName = & $f 'fileOrFolderName'; operationType = & $f 'operationType'; operator = & $f 'operator'; comparisonValue = & $f 'comparisonValue'; check32BitOn64System = & $f 'check32BitOn64System' }
        }
        '#microsoft.graph.win32LobAppRegistryRule' {
            return @{ type = 'registry'; keyPath = & $f 'keyPath'; valueName = & $f 'valueName'; operationType = & $f 'operationType'; operator = & $f 'operator'; comparisonValue = & $f 'comparisonValue'; check32BitOn64System = & $f 'check32BitOn64System' }
        }
        '#microsoft.graph.win32LobAppProductCodeRule' {
            return @{ type = 'msi'; productCode = & $f 'productCode'; productVersionOperator = & $f 'productVersionOperator'; productVersion = & $f 'productVersion' }
        }
        '#microsoft.graph.win32LobAppPowerShellScriptRule' {
            $encoded = [string](& $f 'scriptContent')
            $script = if ($encoded) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) } else { '' }
            return @{ type = 'script'; scriptContent = $script; enforceSignatureCheck = & $f 'enforceSignatureCheck'; runAs32Bit = & $f 'runAs32Bit' }
        }
        default { return $null }
    }
}

function Get-IntuneAppDetail {
    <#
    .SYNOPSIS
        Reads one app in the portal shape; returns a structured error for a missing or unsupported app.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][string]$AppId)

    try {
        $app = Invoke-MgGraphRequest -Method GET -Uri "$script:IntuneAppBase/$([uri]::EscapeDataString($AppId))?`$expand=assignments"
    }
    catch {
        if ($_.Exception.Message -match '404|NotFound|ResourceNotFound') {
            return @{ error = 'intune.app.not_found'; message = "app '$AppId' not found"; statusCode = 404 }
        }
        throw
    }
    $odataType = [string](Get-IntuneAppField -Object $app -Name '@odata.type')
    $appType = $script:IntuneAppTypes[$odataType]
    if (-not $appType) {
        return @{ error = 'intune.app-type.unsupported'; message = "app type '$odataType' is not managed in v1"; statusCode = 501 }
    }

    $experience = Get-IntuneAppField -Object $app -Name 'installExperience'
    $detail = @{
        id              = [string](Get-IntuneAppField -Object $app -Name 'id')
        appType         = $appType
        odataType       = $odataType
        displayName     = [string](Get-IntuneAppField -Object $app -Name 'displayName')
        description     = [string](Get-IntuneAppField -Object $app -Name 'description')
        publisher       = [string](Get-IntuneAppField -Object $app -Name 'publisher')
        runAsAccount    = [string](Get-IntuneAppField -Object $experience -Name 'runAsAccount')
        assignmentCount = @(Get-IntuneAppField -Object $app -Name 'assignments' | Where-Object { $_ }).Count
    }
    if ($appType -eq 'store') {
        $detail.packageIdentifier = [string](Get-IntuneAppField -Object $app -Name 'packageIdentifier')
        return $detail
    }
    $detail.installCommandLine = [string](Get-IntuneAppField -Object $app -Name 'installCommandLine')
    $detail.uninstallCommandLine = [string](Get-IntuneAppField -Object $app -Name 'uninstallCommandLine')
    $detail.deviceRestartBehavior = [string](Get-IntuneAppField -Object $experience -Name 'deviceRestartBehavior')
    $detail.applicableArchitectures = @(([string](Get-IntuneAppField -Object $app -Name 'applicableArchitectures')).Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -ne 'none' })
    $detail.minimumSupportedWindowsRelease = [string](Get-IntuneAppField -Object $app -Name 'minimumSupportedWindowsRelease')
    $detail.detectionRules = @(foreach ($r in @(Get-IntuneAppField -Object $app -Name 'rules' | Where-Object { $_ })) {
            if ([string](Get-IntuneAppField -Object $r -Name 'ruleType') -ne 'requirement') { ConvertFrom-Win32DetectionRule -Rule $r }
        }) | Where-Object { $_ }
    $detail.detectionRules = @($detail.detectionRules)
    return $detail
}

function Invoke-IntuneAppChange {
    <#
    .SYNOPSIS
        Previews or applies an app update or delete, returning the plan and, when applied, an audit event.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][ValidateSet('update', 'delete')][string]$Action,
        [System.Collections.IDictionary]$Changes = @{},
        [string]$ConfirmName = '',
        [switch]$Preview,
        [string]$Actor = 'system'
    )

    $before = Get-IntuneAppDetail -AppId $AppId
    if ($before.error) { return $before }

    $after = $null
    $patch = $null
    if ($Action -eq 'update') {
        $allowed = $script:IntuneAppCommonFields + @('runAsAccount')
        if ($before.appType -eq 'win32') { $allowed += $script:IntuneAppWin32Fields + @('deviceRestartBehavior', 'detectionRules') }
        $unknown = @($Changes.Keys | Where-Object { $allowed -notcontains $_ })
        if ($unknown.Count -gt 0) {
            return @{ error = 'request.validation_failed'; message = "cannot change $($unknown -join ', ') on a $($before.appType) app"; statusCode = 400 }
        }
        if ($Changes.Count -eq 0) {
            return @{ error = 'request.validation_failed'; message = 'no changes supplied'; statusCode = 400 }
        }

        $after = @{} + $before
        foreach ($key in $Changes.Keys) { $after[$key] = $Changes[$key] }
        $patch = @{ '@odata.type' = $before.odataType }
        foreach ($key in $Changes.Keys) {
            switch ($key) {
                'runAsAccount' { }
                'deviceRestartBehavior' { }
                'applicableArchitectures' { $patch.applicableArchitectures = (@($Changes[$key]) -join ',') }
                'detectionRules' {
                    try { $patch.rules = @(foreach ($r in @($Changes[$key])) { ConvertTo-Win32DetectionRule -Rule $r }) }
                    catch { return @{ error = 'request.validation_failed'; message = $_.Exception.Message; statusCode = 400 } }
                }
                default { $patch[$key] = $Changes[$key] }
            }
        }
        if ($Changes.Contains('runAsAccount') -or $Changes.Contains('deviceRestartBehavior')) {
            $patch.installExperience = if ($before.appType -eq 'store') {
                @{ '@odata.type' = '#microsoft.graph.winGetAppInstallExperience'; runAsAccount = $after.runAsAccount }
            }
            else {
                @{ '@odata.type' = '#microsoft.graph.win32LobAppInstallExperience'; runAsAccount = $after.runAsAccount; deviceRestartBehavior = $after.deviceRestartBehavior }
            }
        }
    }

    $changed = if ($Action -eq 'update') { @($Changes.Keys | Where-Object { ($before[$_] | ConvertTo-Json -Depth 10 -Compress) -ne ($after[$_] | ConvertTo-Json -Depth 10 -Compress) } | Sort-Object) } else { @() }
    $plan = @{
        action               = $Action
        appId                = $AppId
        appName              = $before.displayName
        appType              = $before.appType
        assignmentCount      = $before.assignmentCount
        changedFields        = $changed
        before               = $before
        after                = $after
        requiresConfirmation = ($Action -eq 'delete')
    }

    if ($Action -eq 'delete' -and -not $Preview -and $ConfirmName -cne $before.displayName) {
        return @{ error = 'intune.app.confirmation_required'; message = "type the app name '$($before.displayName)' to confirm deletion"; statusCode = 400; plan = $plan }
    }
    if ($Preview -or ($Action -eq 'update' -and $changed.Count -eq 0) -or -not $PSCmdlet.ShouldProcess($before.displayName, "$Action Intune app")) {
        return @{ tenantId = $TenantId; preview = [bool]$Preview; applied = $false; plan = $plan; auditEvent = $null }
    }

    $uri = "$script:IntuneAppBase/$([uri]::EscapeDataString($AppId))"
    try {
        if ($Action -eq 'update') { $null = Invoke-MgGraphRequest -Method PATCH -Uri $uri -Body ($patch | ConvertTo-Json -Depth 20 -Compress) }
        else { $null = Invoke-MgGraphRequest -Method DELETE -Uri $uri }
        $result = 'success'
        $errorText = $null
    }
    catch {
        $result = 'failure'
        $errorText = $_.ToString()
    }

    return @{
        tenantId   = $TenantId
        preview    = $false
        applied    = ($result -eq 'success')
        plan       = $plan
        error      = $errorText
        auditEvent = @{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = "intune.app.$Action"
            targetId   = $AppId
            targetName = $before.displayName
            actor      = $Actor
            timestamp  = (Get-Date).ToUniversalTime().ToString('o')
            before     = $before
            after      = $after
            result     = $result
            error      = $errorText
        }
    }
}
