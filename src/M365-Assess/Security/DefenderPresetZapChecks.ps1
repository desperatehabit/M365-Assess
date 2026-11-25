# -------------------------------------------------------------------
# Defender -- Priority Account & Zero-Hour Auto Purge Checks
# Extracted from Get-DefenderSecurityConfig.ps1 (#257)
# Runs in shared scope: $settings, $checkIdCounter, Add-Setting,
#   Test-PresetPolicy, $script:eopRules
# -------------------------------------------------------------------
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseDeclaredVarsMoreThanAssignments', '')]
param()

# ------------------------------------------------------------------
# 9. Priority Account Protection (CIS 2.4.1, 2.4.2)
# ------------------------------------------------------------------
try {
    if ($script:eopRules.Count -gt 0) {
        Write-Verbose "Checking priority account protection (using cached preset rules)..."
        $eopRules = $script:eopRules

        # CIS 2.4.1 - Priority account protection is configured
        $strictRule = $eopRules | Where-Object { $_.Identity -match 'Strict' }
        $standardRule = $eopRules | Where-Object { $_.Identity -match 'Standard' }
        $hasPreset = ($null -ne $strictRule) -or ($null -ne $standardRule)

        $settingParams = @{
            Category         = 'Priority Accounts'
            Setting          = 'Preset Security Policies Configured'
            CurrentValue     = $(if ($hasPreset) { 'Preset policies found' } else { 'No preset policies' })
            RecommendedValue = 'Strict or Standard preset policy configured'
            Status           = if ($hasPreset) { 'Pass' } else { 'Fail' }
            CheckId          = 'DEFENDER-PRIORITY-001'
            Remediation      = 'Configure preset security policies in Security admin center > Preset security policies > Strict or Standard protection > Assign users/groups.'
        }
        Add-Setting @settingParams

        # CIS 2.4.2 - Strict preset applies to priority-tagged users
        if ($strictRule) {
            $hasSentTo = ($strictRule.SentTo.Count -gt 0) -or
                         ($strictRule.SentToMemberOf.Count -gt 0) -or
                         ($strictRule.RecipientDomainIs.Count -gt 0)
            $settingParams = @{
                Category         = 'Priority Accounts'
                Setting          = 'Strict Preset Covers Priority Users'
                CurrentValue     = $(if ($hasSentTo) { 'Strict policy has targeted users/groups' } else { 'Strict policy has no targeted recipients' })
                RecommendedValue = 'Strict preset targets priority accounts'
                Status           = if ($hasSentTo) { 'Pass' } else { 'Warning' }
                CheckId          = 'DEFENDER-PRIORITY-002'
                Remediation      = 'Assign priority account users to the Strict preset policy. Security admin center > Preset security policies > Strict protection > Manage protection settings > Add users or groups.'
            }
            Add-Setting @settingParams
        }
        else {
            $settingParams = @{
                Category         = 'Priority Accounts'
                Setting          = 'Strict Preset Covers Priority Users'
                CurrentValue     = 'No strict preset policy found'
                RecommendedValue = 'Strict preset targets priority accounts'
                Status           = 'Fail'
                CheckId          = 'DEFENDER-PRIORITY-002'
                Remediation      = 'Enable the Strict preset security policy and assign priority accounts. Security admin center > Preset security policies > Strict protection.'
            }
            Add-Setting @settingParams
        }
    }
    else {
        $settingParams = @{
            Category         = 'Priority Accounts'
            Setting          = 'Preset Security Policies Configured'
            CurrentValue     = 'No preset policy rules found'
            RecommendedValue = 'Strict or Standard preset policy'
            Status           = 'Review'
            CheckId          = 'DEFENDER-PRIORITY-001'
            Remediation      = 'Connect to Exchange Online PowerShell to check preset security policy rules.'
        }
        Add-Setting @settingParams
        $settingParams = @{
            Category         = 'Priority Accounts'
            Setting          = 'Strict Preset Covers Priority Users'
            CurrentValue     = 'No preset policy rules found'
            RecommendedValue = 'Strict preset targets priority accounts'
            Status           = 'Review'
            CheckId          = 'DEFENDER-PRIORITY-002'
            Remediation      = 'Connect to Exchange Online PowerShell to check preset security policy rules.'
        }
        Add-Setting @settingParams
    }
}
catch {
    Write-Warning "Could not check priority account protection: $_"
}

# ------------------------------------------------------------------
# 10. ZAP for Teams (CIS 2.4.4)
# ------------------------------------------------------------------
try {
    # Teams ZAP is ZapEnabled on the Teams protection policy (T-0952). Get-AtpPolicyForO365
    # has no ZapEnabled property, so reading it there always looked unlicensed.
    $teamsProtectionAvailable = Get-Command -Name Get-TeamsProtectionPolicy -ErrorAction SilentlyContinue
    if ($teamsProtectionAvailable) {
        $teamsProtection = @(Get-TeamsProtectionPolicy -ErrorAction Stop) | Select-Object -First 1
        if ($null -ne $teamsProtection -and $null -ne $teamsProtection.ZapEnabled) {
            $settingParams = @{
                Category         = 'Zero-Hour Auto Purge'
                Setting          = 'ZAP for Teams'
                CurrentValue     = "ZapEnabled: $($teamsProtection.ZapEnabled)"
                RecommendedValue = 'True'
                Status           = if ($teamsProtection.ZapEnabled -eq $true) { 'Pass' } else { 'Fail' }
                CheckId          = 'DEFENDER-ZAP-001'
                Remediation      = 'Microsoft Defender portal > Settings > Email & collaboration > Microsoft Teams protection > Zero-hour auto purge (ZAP): On. PowerShell: Set-TeamsProtectionPolicy -Identity "Teams Protection Policy" -ZapEnabled $true'
            }
            Add-Setting @settingParams
        }
        else {
            $settingParams = @{
                Category         = 'Zero-Hour Auto Purge'
                Setting          = 'ZAP for Teams'
                CurrentValue     = 'No Teams protection policy returned'
                RecommendedValue = 'Defender for Office 365 with Teams ZAP'
                Status           = 'NotLicensed'
                CheckId          = 'DEFENDER-ZAP-001'
                Remediation      = 'ZAP for Teams requires Defender for Office 365 Plan 2. Verify license and check Security admin center > Settings > Zero-hour auto purge.'
            }
            Add-Setting @settingParams
        }
    }
    else {
        $settingParams = @{
            Category         = 'Zero-Hour Auto Purge'
            Setting          = 'ZAP for Teams'
            CurrentValue     = 'Not licensed (Defender for Office 365 required)'
            RecommendedValue = 'Defender for Office 365 with Teams ZAP'
            Status           = 'NotLicensed'
            CheckId          = 'DEFENDER-ZAP-001'
            Remediation      = 'ZAP for Teams requires Defender for Office 365. Upgrade license to enable this capability.'
        }
        Add-Setting @settingParams
    }
}
catch {
    Write-Warning "Could not check ZAP for Teams: $_"
}
