function Connect-RequiredService {
    [CmdletBinding()]
    param(
        [string[]]$Services,
        [string]$SectionName,
        [RunContext]$Context
    )

    $isShim = $null -eq $Context

    if ($isShim) {
        # Compatibility shim: read the legacy caller-scope variables exactly once
        # and fold them into a RunContext so the body below has a single source.
        $legacyConnected = $connectedServices
        $legacyFailed = $failedServices
        $legacyIssues = $issues
        $authInput = @{}
        if ($ClientId) { $authInput['ClientId'] = $ClientId }
        if ($CertificateThumbprint) { $authInput['CertificateThumbprint'] = $CertificateThumbprint }
        if ($Certificate) { $authInput['Certificate'] = $Certificate }
        if ($CertificatePath) { $authInput['CertificatePath'] = $CertificatePath }
        if ($CertificatePassword) { $authInput['CertificatePassword'] = $CertificatePassword }
        if ($ClientSecret) { $authInput['ClientSecret'] = $ClientSecret }
        if ($UserPrincipalName) { $authInput['UserPrincipalName'] = $UserPrincipalName }
        if ($ManagedIdentity) { $authInput['ManagedIdentity'] = $true }
        if ($UseDeviceCode) { $authInput['UseDeviceCode'] = $true }
        if ($M365Environment) { $authInput['M365Environment'] = $M365Environment }

        $shimParams = @{ Auth = $authInput }
        if ($TenantId) { $shimParams['TenantId'] = $TenantId }
        if ($graphScopes) { $shimParams['GraphScopes'] = @($graphScopes) }
        if ($sectionScopeMap) { $shimParams['SectionScopeMap'] = $sectionScopeMap }
        if ($QuickScan) { $shimParams['QuickScan'] = $true }
        if ($OutputFolder) { $shimParams['OutputFolder'] = $OutputFolder }
        if ($assessmentFolder) { $shimParams['AssessmentFolder'] = $assessmentFolder }
        if ($timestamp) { $shimParams['Timestamp'] = $timestamp }
        if ($script:domainPrefix) { $shimParams['DomainPrefix'] = $script:domainPrefix }
        if ($script:logFilePath) { $shimParams['LogFilePath'] = $script:logFilePath }
        if ($script:logFileName) { $shimParams['LogFileName'] = $script:logFileName }

        $Context = New-RunContext @shimParams

        $Context.Scope.Sections = if ($Section) { @($Section) } else { @() }
        $Context.Paths.ProjectRoot = [string]$projectRoot
        $Context.Paths.ConnectServicePath = [string]$connectServicePath
        if ($progressRegistry) { $Context.Registry.ControlRegistry = $progressRegistry }
        $Context.Services.PermissionsChecked = [bool]$script:graphPermissionsChecked
        $Context.Services.LicensesResolved = [bool]$script:tenantLicensesResolved
        if ($script:resolvedTenantDomain) { $Context.Tenant.InitialDomain = [string]$script:resolvedTenantDomain }
        if ($script:resolvedTenantDisplayName) { $Context.Tenant.DisplayName = [string]$script:resolvedTenantDisplayName }
        foreach ($s in @($legacyConnected)) { if ($null -ne $s) { [void]$Context.Services.Connected.Add([string]$s) } }
        foreach ($s in @($legacyFailed)) { if ($null -ne $s) { [void]$Context.Services.Failed.Add([string]$s) } }
        foreach ($i in @($legacyIssues)) { if ($null -ne $i) { $Context.Issues.Add($i) } }
    }

    $ctx = $Context

    foreach ($svc in $Services) {
        if ($ctx.Services.Connected.Contains($svc)) { continue }
        if ($ctx.Services.Failed.Contains($svc)) { continue }

        # Friendly display names for host output
        $serviceDisplayName = switch ($svc) {
            'Graph'          { 'Microsoft Graph' }
            'ExchangeOnline' { 'Exchange Online' }
            'Purview'        { 'Purview (Security & Compliance)' }
            'PowerBI'        { 'Power BI' }
            default          { $svc }
        }
        Write-Host "    Connecting to $serviceDisplayName..." -ForegroundColor Yellow
        if (Get-Command -Name Update-ProgressStatus -ErrorAction SilentlyContinue) {
            Update-ProgressStatus -Message "Connecting to $serviceDisplayName..."
        }

        Write-AssessmentLog -Level INFO -Message "Connecting to $svc..." -Section $SectionName
        try {
            # EXO and Purview share the EXO module and conflict if connected simultaneously.
            # Disconnect the other before connecting.
            if ($svc -eq 'ExchangeOnline' -and $ctx.Services.Connected.Contains('Purview')) {
                Write-AssessmentLog -Level INFO -Message "Disconnecting Purview before connecting ExchangeOnline" -Section $SectionName
                Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
                $ctx.Services.Connected.Remove('Purview') | Out-Null
            }
            elseif ($svc -eq 'Purview' -and $ctx.Services.Connected.Contains('ExchangeOnline')) {
                Write-AssessmentLog -Level INFO -Message "Disconnecting ExchangeOnline before connecting Purview" -Section $SectionName
                Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
                $ctx.Services.Connected.Remove('ExchangeOnline') | Out-Null
            }

            $connectParams = @{ Service = $svc }
            if ($ctx.Tenant.TenantId) { $connectParams['TenantId'] = $ctx.Tenant.TenantId }
            if ($ctx.Auth.ClientId) { $connectParams['ClientId'] = $ctx.Auth.ClientId }
            if ($ctx.Auth.CertificateThumbprint) { $connectParams['CertificateThumbprint'] = $ctx.Auth.CertificateThumbprint }
            # Portable app-only certificate inputs (cross-platform Exchange/Purview/Graph).
            if ($ctx.Auth.Certificate) { $connectParams['Certificate'] = $ctx.Auth.Certificate }
            if ($ctx.Auth.CertificatePath) { $connectParams['CertificatePath'] = $ctx.Auth.CertificatePath }
            if ($ctx.Auth.CertificatePassword) { $connectParams['CertificatePassword'] = $ctx.Auth.CertificatePassword }
            if ($ctx.Auth.ClientSecret) { $connectParams['ClientSecret'] = $ctx.Auth.ClientSecret }
            if ($ctx.Auth.UserPrincipalName -and $svc -ne 'Graph') {
                $connectParams['UserPrincipalName'] = $ctx.Auth.UserPrincipalName
            }

            if ($svc -eq 'Graph') {
                $connectParams['Scopes'] = $ctx.Scope.GraphScopes
            }

            if ($ctx.Auth.M365Environment -ne 'commercial') {
                $connectParams['M365Environment'] = $ctx.Auth.M365Environment
            }
            if ($ctx.Auth.ManagedIdentity) {
                $connectParams['ManagedIdentity'] = $true
            }
            if ($ctx.Auth.UseDeviceCode) {
                $connectParams['UseDeviceCode'] = $true
            }

            # Suppress noisy output during connection (skip when device code
            # is active — the user needs to see the code and URL).
            $suppressOutput = -not $ctx.Auth.UseDeviceCode
            $prevConsoleOut = [Console]::Out
            $prevConsoleError = [Console]::Error
            if ($suppressOutput) {
                [Console]::SetOut([System.IO.TextWriter]::Null)
                [Console]::SetError([System.IO.TextWriter]::Null)
            }
            try {
                if ($suppressOutput) {
                    & $ctx.Paths.ConnectServicePath @connectParams 2>$null 6>$null
                }
                else {
                    & $ctx.Paths.ConnectServicePath @connectParams
                }
            }
            finally {
                if ($suppressOutput) {
                    [Console]::SetOut($prevConsoleOut)
                    [Console]::SetError($prevConsoleError)
                }
            }

            $ctx.Services.Connected.Add($svc) | Out-Null
            Write-AssessmentLog -Level INFO -Message "Connected to $svc successfully." -Section $SectionName

            # Warn device code users about token lifetime risk
            if ($svc -eq 'Graph' -and $ctx.Auth.UseDeviceCode) {
                Write-Warning "Device code tokens have a limited lifetime. For multi-section assessments, use Interactive or Certificate auth to avoid mid-run token expiry."
            }

            # Validate Graph scopes once after first connection
            if ($svc -eq 'Graph' -and -not $ctx.Services.PermissionsChecked) {
                $ctx.Services.PermissionsChecked = $true
                if (Get-Command -Name Test-GraphPermissions -ErrorAction SilentlyContinue) {
                    # #812: pass assessment folder so the deficit map is written for
                    # the HTML Permissions panel + the evidence package to consume.
                    Test-GraphPermissions -RequiredScopes $ctx.Scope.GraphScopes -SectionScopeMap $ctx.Scope.SectionScopeMap `
                        -ActiveSections $ctx.Scope.Sections -OutputFolder $ctx.Output.AssessmentFolder
                }
            }

            # Resolve tenant licenses for check gating (first Graph connection only)
            if ($svc -eq 'Graph' -and -not $ctx.Services.LicensesResolved) {
                $ctx.Services.LicensesResolved = $true
                try {
                    $licenseHelper = Join-Path -Path $ctx.Paths.ProjectRoot -ChildPath 'Common\Resolve-TenantLicenses.ps1'
                    if (Test-Path -Path $licenseHelper) {
                        . $licenseHelper
                        $tenantLicenses = Resolve-TenantLicenses
                        if ($tenantLicenses -and $tenantLicenses.ActiveServicePlans.Count -gt 0) {
                            # Re-initialize progress with license data for accurate check gating
                            if (Get-Command -Name Initialize-CheckProgress -ErrorAction SilentlyContinue) {
                                $reInitParams = @{
                                    ControlRegistry = $ctx.Registry.ControlRegistry
                                    ActiveSections  = $ctx.Scope.Sections
                                    TenantLicenses  = $tenantLicenses
                                }
                                if ($ctx.Scope.QuickScan) { $reInitParams['SeverityFilter'] = @('Critical', 'High') }
                                Initialize-CheckProgress @reInitParams
                            }
                        }
                    }
                }
                catch {
                    Write-AssessmentLog -Level WARN -Message "Could not resolve tenant licenses: $($_.Exception.Message). License gating disabled." -Section $SectionName
                }
            }

            # After first Graph connection, capture connected tenant domain for
            # later use (e.g. report headers, logging).
            if ($svc -eq 'Graph' -and -not $ctx.Tenant.InitialDomain) {
                try {
                    $orgInfo = Get-MgOrganization -ErrorAction Stop | Select-Object -First 1
                    $initialDomain = $orgInfo.VerifiedDomains | Where-Object { $_.IsInitial -eq $true } | Select-Object -First 1
                    if ($initialDomain) {
                        $ctx.Tenant.InitialDomain = $initialDomain.Name
                        $ctx.Tenant.TenantId = $orgInfo.Id
                        $ctx.Tenant.DisplayName = $orgInfo.DisplayName
                        Write-AssessmentLog -Level INFO -Message "Connected tenant: $($ctx.Tenant.DisplayName) ($($ctx.Tenant.InitialDomain)) [ID: $($ctx.Tenant.TenantId)]" -Section $SectionName

                        # Prefetch DNS records for all verified domains in background
                        # (runs while auth and other collectors proceed)
                        if ('Email' -in $ctx.Scope.Sections) {
                            $verifiedDomainNames = @($orgInfo.VerifiedDomains | ForEach-Object { $_.Name })
                            Write-AssessmentLog -Level INFO -Message "Prefetching DNS records for $($verifiedDomainNames.Count) verified domain(s) in background" -Section $SectionName
                            $script:dnsPrefetchJobs = @()
                            $dnsHelperPath = Join-Path -Path $ctx.Paths.ProjectRoot -ChildPath 'Common\Resolve-DnsRecord.ps1'
                            foreach ($vdName in $verifiedDomainNames) {
                                $script:dnsPrefetchJobs += Start-ThreadJob -ScriptBlock {
                                    . $using:dnsHelperPath
                                    $d      = $using:vdName
                                    $spf    = Resolve-DnsRecord -Name $d -Type TXT -ErrorAction SilentlyContinue
                                    $dmarc  = Resolve-DnsRecord -Name ('_dmarc.' + $d) -Type TXT -ErrorAction SilentlyContinue
                                    $dkim1  = Resolve-DnsRecord -Name ('selector1._domainkey.' + $d) -Type CNAME -ErrorAction SilentlyContinue
                                    $dkim2  = Resolve-DnsRecord -Name ('selector2._domainkey.' + $d) -Type CNAME -ErrorAction SilentlyContinue
                                    $mtaSts = Resolve-DnsRecord -Name ('_mta-sts.' + $d) -Type TXT -ErrorAction SilentlyContinue
                                    $tlsRpt = Resolve-DnsRecord -Name ('_smtp._tls.' + $d) -Type TXT -ErrorAction SilentlyContinue
                                    [PSCustomObject]@{
                                        Domain = $d; Spf = $spf; Dmarc = $dmarc
                                        Dkim1 = $dkim1; Dkim2 = $dkim2
                                        MtaSts = $mtaSts; TlsRpt = $tlsRpt
                                    }
                                }
                            }
                        }

                        # Phase B: Rename folder/files to include domain prefix if not already set
                        if (-not $ctx.Output.DomainPrefix -and $ctx.Tenant.InitialDomain -match '^([^.]+)\.onmicrosoft\.(com|us)$') {
                            $ctx.Output.DomainPrefix = $Matches[1]
                            try {
                                # Rename assessment folder (updates both local and script scope)
                                $newFolderName = "Assessment_$($ctx.Output.Timestamp)_$($ctx.Output.DomainPrefix)"
                                Rename-Item -Path $ctx.Output.AssessmentFolder -NewName $newFolderName -ErrorAction Stop
                                $ctx.Output.AssessmentFolder = Join-Path -Path $ctx.Output.OutputFolder -ChildPath $newFolderName

                                # Update log path to reflect renamed folder BEFORE renaming the file
                                $oldLogName = Split-Path -Leaf $ctx.Output.LogFilePath
                                $ctx.Output.LogFilePath = Join-Path -Path $ctx.Output.AssessmentFolder -ChildPath $oldLogName

                                # Rename log file
                                $newLogName = "_Assessment-Log_$($ctx.Output.DomainPrefix).txt"
                                Rename-Item -Path $ctx.Output.LogFilePath -NewName $newLogName -ErrorAction Stop
                                $ctx.Output.LogFileName = $newLogName
                                $ctx.Output.LogFilePath = Join-Path -Path $ctx.Output.AssessmentFolder -ChildPath $newLogName

                                # Update log header with resolved domain prefix
                                $logContent = Get-Content -Path $ctx.Output.LogFilePath -Raw
                                $logContent = $logContent -creplace '(?m)(Domain:\s*)(\r?\n)', "`${1}$($ctx.Output.DomainPrefix)`${2}"
                                Set-Content -Path $ctx.Output.LogFilePath -Value $logContent -Encoding UTF8 -NoNewline

                                Write-AssessmentLog -Level INFO -Message "Renamed output to include tenant domain: $($ctx.Output.DomainPrefix)" -Section $SectionName
                            }
                            catch {
                                Write-AssessmentLog -Level WARN -Message "Could not rename output folder/files: $($_.Exception.Message)" -Section $SectionName
                            }
                        }
                    }
                }
                catch {
                    Write-AssessmentLog -Level WARN -Message "Could not resolve tenant info from Graph: $($_.Exception.Message)" -Section $SectionName
                }
            }
        }
        catch {
            $ctx.Services.Failed.Add($svc) | Out-Null

            # Extract clean one-liner for console
            $friendlyMsg = $_.Exception.Message
            if ($friendlyMsg -match '(.*?)(?:\r?\n|$)') {
                $friendlyMsg = $Matches[1]
            }
            if ($friendlyMsg.Length -gt 70) {
                $friendlyMsg = $friendlyMsg.Substring(0, 67) + '...'
            }

            Write-Host "    $([char]0x26A0) $svc connection failed (see log)" -ForegroundColor Yellow
            Write-AssessmentLog -Level ERROR -Message "$svc connection failed: $friendlyMsg" -Section $SectionName -Detail $_.Exception.ToString()

            $ctx.Issues.Add([PSCustomObject]@{
                Severity     = 'ERROR'
                Section      = $SectionName
                Collector    = '(connection)'
                Description  = "$svc connection failed"
                ErrorMessage = $friendlyMsg
                Action       = Get-RecommendedAction -ErrorMessage $_.Exception.ToString()
            })
        }
    }

    if ($isShim) {
        # Reflect the context back onto the legacy caller/script state so the
        # existing orchestrator and its consumers stay unchanged.
        $script:graphPermissionsChecked = $ctx.Services.PermissionsChecked
        $script:tenantLicensesResolved = $ctx.Services.LicensesResolved
        $script:domainPrefix = $ctx.Output.DomainPrefix
        $script:logFilePath = $ctx.Output.LogFilePath
        $script:logFileName = $ctx.Output.LogFileName
        if ($ctx.Output.AssessmentFolder) { $script:assessmentFolder = $ctx.Output.AssessmentFolder }
        if ($ctx.Tenant.InitialDomain) {
            $script:resolvedTenantDomain = $ctx.Tenant.InitialDomain
            $script:resolvedTenantId = $ctx.Tenant.TenantId
            $script:resolvedTenantDisplayName = $ctx.Tenant.DisplayName
        }
        if ($null -ne $legacyConnected) {
            $legacyConnected.Clear()
            foreach ($s in $ctx.Services.Connected) { [void]$legacyConnected.Add($s) }
        }
        if ($null -ne $legacyFailed) {
            $legacyFailed.Clear()
            foreach ($s in $ctx.Services.Failed) { [void]$legacyFailed.Add($s) }
        }
        if ($null -ne $legacyIssues) {
            $legacyIssues.Clear()
            foreach ($i in $ctx.Issues) { $legacyIssues.Add($i) }
        }
    }
}
