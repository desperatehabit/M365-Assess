# Queue-IntuneAppUpload.ps1 - EPIC-017 app upload queue worker (SPEC section 3.2, section 4.1, section 9; T-0323).
#
# Runs one queued AppDeployment for one tenant:
# - store (winGetApp): creates the app; Intune fetches the package itself.
# - win32 (win32LobApp): downloads the .intunewin from the BFF's signed, short-lived URL,
#   then runs the Graph content-upload sequence: create app -> content version -> content
#   file -> wait for the Azure upload URI -> upload blocks -> commit with the package's
#   encryption info -> wait for commit -> set committedContentVersion.
# - Re-runnable: given resumeAppId from a failed attempt, it reuses that app and starts a
#   fresh content version rather than creating a duplicate app.
#
# The BFF records state on the AppDeployment row from this worker's result. The result
# and every error message carry ids only: the Azure SAS URI, the package URL signature,
# and the package's encryption keys never leave this process.

$script:AppUploadGraphBase = '/beta/deviceAppManagement/mobileApps'
$script:AppUploadBlockBytes = 6 * 1024 * 1024
$script:Win32DefaultReturnCodes = @(
    @{ returnCode = 0; type = 'success' }
    @{ returnCode = 1707; type = 'success' }
    @{ returnCode = 3010; type = 'softReboot' }
    @{ returnCode = 1641; type = 'hardReboot' }
    @{ returnCode = 1618; type = 'retry' }
)

function Read-IntuneAppUploadJob {
    <#
    .SYNOPSIS
        Parses a job document for Queue-IntuneAppUpload.
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

    foreach ($field in @('tenantId', 'deploymentId', 'appType', 'app')) {
        if (-not $json[$field]) { throw "job envelope '$Path' is missing mandatory '$field'" }
    }
    if (@('win32', 'store') -notcontains $json['appType']) {
        throw "job envelope '$Path' has unsupported appType '$($json['appType'])'"
    }
    if ($json['appType'] -eq 'win32' -and -not $json['packageUrl']) {
        throw "job envelope '$Path' is missing mandatory 'packageUrl' for a win32 app"
    }

    return @{
        TenantId      = [string]$json['tenantId']
        DeploymentId  = [string]$json['deploymentId']
        AppType       = [string]$json['appType']
        App           = $json['app']
        PackageUrl    = [string]$json['packageUrl']
        PackageSize   = if ($null -ne $json['packageSize']) { [long]$json['packageSize'] } else { -1 }
        PackageSha256 = [string]$json['packageSha256']
        ResumeAppId   = [string]$json['resumeAppId']
        Actor         = if ($json['actor']) { [string]$json['actor'] } else { 'system' }
    }
}

function Get-AppUploadValue {
    # Reads a property from a hashtable or a PSCustomObject.
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function Protect-AppUploadText {
    <#
    .SYNOPSIS
        Strips URL query strings (SAS tokens, package URL signatures) from text bound for results.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([string]$Text = '')
    return ($Text -replace '(https?://[^\s"''?]+)\?[^\s"'']*', '$1?[redacted]')
}

function ConvertTo-Win32DetectionRule {
    <#
    .SYNOPSIS
        Maps a portal detection rule to a Graph win32LobAppRule (ruleType detection).
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][object]$Rule)

    $v = { param($name, $default) $x = Get-AppUploadValue -Object $Rule -Name $name; if ($null -eq $x -or $x -eq '') { $default } else { $x } }
    switch ([string](Get-AppUploadValue -Object $Rule -Name 'type')) {
        'file' {
            return @{
                '@odata.type'        = '#microsoft.graph.win32LobAppFileSystemRule'
                ruleType             = 'detection'
                path                 = [string](& $v 'path' '')
                fileOrFolderName     = [string](& $v 'fileOrFolderName' '')
                check32BitOn64System = [bool](& $v 'check32BitOn64System' $false)
                operationType        = [string](& $v 'operationType' 'exists')
                operator             = [string](& $v 'operator' 'notConfigured')
                comparisonValue      = & $v 'comparisonValue' $null
            }
        }
        'registry' {
            return @{
                '@odata.type'        = '#microsoft.graph.win32LobAppRegistryRule'
                ruleType             = 'detection'
                keyPath              = [string](& $v 'keyPath' '')
                valueName            = & $v 'valueName' $null
                check32BitOn64System = [bool](& $v 'check32BitOn64System' $false)
                operationType        = [string](& $v 'operationType' 'exists')
                operator             = [string](& $v 'operator' 'notConfigured')
                comparisonValue      = & $v 'comparisonValue' $null
            }
        }
        'msi' {
            return @{
                '@odata.type'           = '#microsoft.graph.win32LobAppProductCodeRule'
                ruleType                = 'detection'
                productCode             = [string](& $v 'productCode' '')
                productVersionOperator  = [string](& $v 'productVersionOperator' 'notConfigured')
                productVersion          = & $v 'productVersion' $null
            }
        }
        'script' {
            $script = [string](& $v 'scriptContent' '')
            return @{
                '@odata.type'         = '#microsoft.graph.win32LobAppPowerShellScriptRule'
                ruleType              = 'detection'
                scriptContent         = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
                enforceSignatureCheck = [bool](& $v 'enforceSignatureCheck' $false)
                runAs32Bit            = [bool](& $v 'runAs32Bit' $false)
                operationType         = 'notConfigured'
                operator              = 'notConfigured'
            }
        }
        default { throw "unsupported detection rule type '$(Get-AppUploadValue -Object $Rule -Name 'type')'" }
    }
}

function Read-IntuneWinPackage {
    <#
    .SYNOPSIS
        Reads Detection.xml from a .intunewin and extracts the encrypted content to a file.
    .OUTPUTS
        Hashtable: FileName, SetupFile, UnencryptedSize, EncryptedPath, EncryptedSize, EncryptionInfo.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$WorkDir
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $detectionEntry = $zip.Entries | Where-Object { $_.FullName -match '(^|/)Metadata/Detection\.xml$' } | Select-Object -First 1
        if (-not $detectionEntry) { throw 'package is not a .intunewin: Metadata/Detection.xml is missing' }
        $reader = [System.IO.StreamReader]::new($detectionEntry.Open())
        try { [xml]$detection = $reader.ReadToEnd() } finally { $reader.Dispose() }

        $info = $detection.ApplicationInfo
        $enc = $info.EncryptionInfo
        if (-not $enc -or -not $enc.EncryptionKey) { throw 'package Detection.xml has no EncryptionInfo' }
        $contentName = [string]$info.FileName
        $contentEntry = $zip.Entries | Where-Object { $_.FullName -match "(^|/)Contents/$([regex]::Escape($contentName))$" } | Select-Object -First 1
        if (-not $contentEntry) { throw "package content '$contentName' is missing" }

        $encryptedPath = Join-Path -Path $WorkDir -ChildPath 'content.bin'
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($contentEntry, $encryptedPath, $true)

        return @{
            FileName        = $contentName
            SetupFile       = [string]$info.SetupFile
            UnencryptedSize = [long]$info.UnencryptedContentSize
            EncryptedPath   = $encryptedPath
            EncryptedSize   = (Get-Item -LiteralPath $encryptedPath).Length
            EncryptionInfo  = @{
                encryptionKey        = [string]$enc.EncryptionKey
                macKey               = [string]$enc.MacKey
                initializationVector = [string]$enc.InitializationVector
                mac                  = [string]$enc.Mac
                profileIdentifier    = [string]$enc.ProfileIdentifier
                fileDigest           = [string]$enc.FileDigest
                fileDigestAlgorithm  = [string]$enc.FileDigestAlgorithm
            }
        }
    }
    finally {
        $zip.Dispose()
    }
}

function Wait-IntuneContentFileState {
    <#
    .SYNOPSIS
        Polls a content file until uploadState reaches <Stage>Success; throws on failure or timeout.
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][ValidateSet('azureStorageUriRequest', 'commitFile')][string]$Stage,
        [int]$MaxAttempts = 60,
        [int]$DelaySeconds = 5
    )

    for ($i = 1; $i -le $MaxAttempts; $i++) {
        $file = Invoke-MgGraphRequest -Method GET -Uri $Uri
        $state = [string](Get-AppUploadValue -Object $file -Name 'uploadState')
        if ($state -eq "${Stage}Success") { return $file }
        if ($state -eq "${Stage}Failed" -or $state -eq "${Stage}TimedOut") {
            throw "content file reached '$state'"
        }
        if ($i -lt $MaxAttempts -and $DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }
    }
    throw "content file did not reach '${Stage}Success' after $MaxAttempts checks"
}

function Send-AzureBlobBlock {
    <#
    .SYNOPSIS
        Uploads a file to an Azure Storage SAS URI as block-blob blocks, then commits the block list.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SasUri,
        [Parameter(Mandatory)][string]$Path,
        [int]$BlockBytes = $script:AppUploadBlockBytes
    )

    $ids = [System.Collections.Generic.List[string]]::new()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $buffer = [byte[]]::new($BlockBytes)
        $index = 0
        while (($read = $stream.Read($buffer, 0, $BlockBytes)) -gt 0) {
            $chunk = if ($read -eq $BlockBytes) { $buffer } else { $buffer[0..($read - 1)] }
            $id = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($index.ToString('0000')))
            $blockParams = @{
                Method      = 'PUT'
                Uri         = "$SasUri&comp=block&blockid=$([uri]::EscapeDataString($id))"
                Headers     = @{ 'x-ms-blob-type' = 'BlockBlob' }
                Body        = [byte[]]$chunk
                ContentType = 'application/octet-stream'
            }
            $null = Invoke-RestMethod @blockParams
            $ids.Add($id)
            $index++
        }
    }
    finally {
        $stream.Dispose()
    }

    $latest = ($ids | ForEach-Object { "<Latest>$_</Latest>" }) -join ''
    $listParams = @{
        Method      = 'PUT'
        Uri         = "$SasUri&comp=blocklist"
        Body        = "<?xml version=`"1.0`" encoding=`"utf-8`"?><BlockList>$latest</BlockList>"
        ContentType = 'application/xml'
    }
    $null = Invoke-RestMethod @listParams
    return $ids.Count
}

function New-IntuneAppBody {
    # Builds the Graph mobileApp create body for a job's app metadata.
    param([Parameter(Mandatory)][string]$AppType, [Parameter(Mandatory)][object]$App, [hashtable]$Package)

    $runAs = [string](Get-AppUploadValue -Object $App -Name 'runAsAccount')
    if (-not $runAs) { $runAs = 'system' }
    $common = @{
        displayName = [string](Get-AppUploadValue -Object $App -Name 'displayName')
        description = [string](Get-AppUploadValue -Object $App -Name 'description')
        publisher   = [string](Get-AppUploadValue -Object $App -Name 'publisher')
    }
    if (-not $common.description) { $common.description = $common.displayName }

    if ($AppType -eq 'store') {
        return $common + @{
            '@odata.type'     = '#microsoft.graph.winGetApp'
            packageIdentifier = [string](Get-AppUploadValue -Object $App -Name 'packageIdentifier')
            installExperience = @{ '@odata.type' = '#microsoft.graph.winGetAppInstallExperience'; runAsAccount = $runAs }
        }
    }

    $restart = [string](Get-AppUploadValue -Object $App -Name 'deviceRestartBehavior')
    if (-not $restart) { $restart = 'basedOnReturnCode' }
    $architectures = @(Get-AppUploadValue -Object $App -Name 'applicableArchitectures') | Where-Object { $_ }
    if (-not $architectures) { $architectures = @('x64') }
    $release = [string](Get-AppUploadValue -Object $App -Name 'minimumSupportedWindowsRelease')
    if (-not $release) { $release = '1607' }

    return $common + @{
        '@odata.type'                  = '#microsoft.graph.win32LobApp'
        fileName                       = $Package.FileName
        setupFilePath                  = $Package.SetupFile
        installCommandLine             = [string](Get-AppUploadValue -Object $App -Name 'installCommandLine')
        uninstallCommandLine           = [string](Get-AppUploadValue -Object $App -Name 'uninstallCommandLine')
        applicableArchitectures        = ($architectures -join ',')
        minimumSupportedWindowsRelease = $release
        installExperience              = @{
            '@odata.type'         = '#microsoft.graph.win32LobAppInstallExperience'
            runAsAccount          = $runAs
            deviceRestartBehavior = $restart
        }
        rules                          = @(foreach ($rule in @(Get-AppUploadValue -Object $App -Name 'detectionRules')) { ConvertTo-Win32DetectionRule -Rule $rule })
        returnCodes                    = $script:Win32DefaultReturnCodes
    }
}

function Invoke-IntuneAppUpload {
    <#
    .SYNOPSIS
        Creates (or reuses) an Intune app and, for win32, uploads and commits its package.
    .PARAMETER PollDelaySeconds
        Seconds between upload-state checks; tests pass 0.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [Parameter(Mandatory)][string]$DeploymentId,
        [Parameter(Mandatory)][ValidateSet('win32', 'store')][string]$AppType,
        [Parameter(Mandatory)][object]$App,
        [string]$PackageUrl = '',
        [long]$PackageSize = -1,
        [string]$PackageSha256 = '',
        [string]$ResumeAppId = '',
        [string]$Actor = 'system',
        [int]$PollDelaySeconds = 5,
        [int]$PollAttempts = 60
    )

    $steps = [System.Collections.Generic.List[hashtable]]::new()
    $audit = [System.Collections.Generic.List[hashtable]]::new()
    $appId = $null
    $contentVersionId = $null
    $current = 'start'
    $workDir = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath "app-upload-$([guid]::NewGuid())"
    $displayName = [string](Get-AppUploadValue -Object $App -Name 'displayName')

    $newAudit = {
        param($action, $targetId, $after)
        $audit.Add(@{
                id         = [guid]::NewGuid().ToString()
                tenantId   = $TenantId
                action     = $action
                targetId   = $targetId
                targetName = $displayName
                deployment = $DeploymentId
                actor      = $Actor
                timestamp  = (Get-Date).ToUniversalTime().ToString('o')
                after      = $after
            })
    }

    try {
        $package = $null
        if ($AppType -eq 'win32') {
            $null = New-Item -ItemType Directory -Path $workDir -Force
            # Download first: a bad package must not leave a half-made app behind.
            $current = 'downloadPackage'
            $packagePath = Join-Path -Path $workDir -ChildPath 'package.intunewin'
            $null = Invoke-WebRequest -Uri $PackageUrl -OutFile $packagePath -UseBasicParsing
            $downloaded = Get-Item -LiteralPath $packagePath
            if ($PackageSize -ge 0 -and $downloaded.Length -ne $PackageSize) {
                throw "downloaded package is $($downloaded.Length) bytes; expected $PackageSize"
            }
            if ($PackageSha256 -and (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash -ne $PackageSha256.ToUpperInvariant()) {
                throw 'downloaded package does not match its recorded sha256'
            }
            $package = Read-IntuneWinPackage -Path $packagePath -WorkDir $workDir
            $steps.Add(@{ step = 'downloadPackage'; status = 'succeeded' })
        }

        if ($ResumeAppId) {
            $current = 'reuseApp'
            $existing = Invoke-MgGraphRequest -Method GET -Uri "$script:AppUploadGraphBase/$([uri]::EscapeDataString($ResumeAppId))"
            $appId = [string](Get-AppUploadValue -Object $existing -Name 'id')
            $steps.Add(@{ step = 'reuseApp'; status = 'succeeded' })
        }
        else {
            $current = 'createApp'
            $body = New-IntuneAppBody -AppType $AppType -App $App -Package $package
            $created = Invoke-MgGraphRequest -Method POST -Uri $script:AppUploadGraphBase -Body ($body | ConvertTo-Json -Depth 20 -Compress)
            $appId = [string](Get-AppUploadValue -Object $created -Name 'id')
            $steps.Add(@{ step = 'createApp'; status = 'succeeded' })
            & $newAudit 'intune.app.create' $appId $body
        }

        if ($AppType -eq 'win32') {
            $appUri = "$script:AppUploadGraphBase/$appId/microsoft.graph.win32LobApp"

            $current = 'createContentVersion'
            $version = Invoke-MgGraphRequest -Method POST -Uri "$appUri/contentVersions" -Body '{}'
            $contentVersionId = [string](Get-AppUploadValue -Object $version -Name 'id')
            $steps.Add(@{ step = 'createContentVersion'; status = 'succeeded' })

            $current = 'createContentFile'
            $fileBody = @{
                '@odata.type' = '#microsoft.graph.mobileAppContentFile'
                name          = $package.FileName
                size          = $package.UnencryptedSize
                sizeEncrypted = $package.EncryptedSize
                manifest      = $null
                isDependency  = $false
            } | ConvertTo-Json -Compress
            $file = Invoke-MgGraphRequest -Method POST -Uri "$appUri/contentVersions/$contentVersionId/files" -Body $fileBody
            $fileUri = "$appUri/contentVersions/$contentVersionId/files/$(Get-AppUploadValue -Object $file -Name 'id')"
            $steps.Add(@{ step = 'createContentFile'; status = 'succeeded' })

            $current = 'uploadContent'
            $ready = Wait-IntuneContentFileState -Uri $fileUri -Stage azureStorageUriRequest -DelaySeconds $PollDelaySeconds -MaxAttempts $PollAttempts
            $sasUri = [string](Get-AppUploadValue -Object $ready -Name 'azureStorageUri')
            if (-not $sasUri) { throw 'Graph returned no upload URI' }
            $null = Send-AzureBlobBlock -SasUri $sasUri -Path $package.EncryptedPath
            $steps.Add(@{ step = 'uploadContent'; status = 'succeeded' })

            $current = 'commitContentFile'
            $commitBody = @{ fileEncryptionInfo = $package.EncryptionInfo } | ConvertTo-Json -Compress
            $null = Invoke-MgGraphRequest -Method POST -Uri "$fileUri/commit" -Body $commitBody
            $null = Wait-IntuneContentFileState -Uri $fileUri -Stage commitFile -DelaySeconds $PollDelaySeconds -MaxAttempts $PollAttempts
            $steps.Add(@{ step = 'commitContentFile'; status = 'succeeded' })

            $current = 'setCommittedContentVersion'
            $patch = @{ '@odata.type' = '#microsoft.graph.win32LobApp'; committedContentVersion = $contentVersionId }
            $null = Invoke-MgGraphRequest -Method PATCH -Uri "$script:AppUploadGraphBase/$appId" -Body ($patch | ConvertTo-Json -Compress)
            $steps.Add(@{ step = 'setCommittedContentVersion'; status = 'succeeded' })
            & $newAudit 'intune.app.content.commit' $appId @{ committedContentVersion = $contentVersionId; fileName = $package.FileName; size = $package.UnencryptedSize }
        }

        return @{
            deploymentId     = $DeploymentId
            state            = 'succeeded'
            appId            = $appId
            contentVersionId = $contentVersionId
            steps            = @($steps)
            error            = $null
            auditEvents      = @($audit)
        }
    }
    catch {
        $message = Protect-AppUploadText -Text $_.ToString()
        $steps.Add(@{ step = $current; status = 'failed'; error = $message })
        return @{
            deploymentId     = $DeploymentId
            state            = 'failed'
            appId            = if ($appId) { $appId } elseif ($ResumeAppId) { $ResumeAppId } else { $null }
            contentVersionId = $contentVersionId
            steps            = @($steps)
            error            = $message
            auditEvents      = @($audit)
        }
    }
    finally {
        if (Test-Path -LiteralPath $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
