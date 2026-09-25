# First validated typed set (EPIC-006 SPEC.md section 11 item 1). Each entry
# binds a registry check to a typed action implemented in
# Invoke-RemediationAction.ps1 with fixed, code-reviewed parameters. Entries
# are added here only after hand validation against a real tenant
# (SPEC.md section 4.5); everything else refuses with 'not-implemented'.
$script:RemediationTypedCommands = @{
    'ENTRA-SECDEFAULT-001' = @{
        CommandName = 'Set-EntraSecurityDefaultsState'
        Parameters  = @{ IsEnabled = $true }
    }
    'ENTRA-GUEST-001'      = @{
        CommandName = 'Set-EntraGuestUserRole'
        Parameters  = @{ GuestUserRoleId = '2af84b1e-32c8-42b7-82bc-daa82404023b' }
    }
    'ENTRA-GUEST-002'      = @{
        CommandName = 'Set-EntraInvitePolicy'
        Parameters  = @{ AllowInvitesFrom = 'adminsAndGuestInviters' }
    }
    'SPO-SHARING-001'      = @{
        CommandName = 'Set-SpoSharingCapability'
        Parameters  = @{ SharingCapability = 'ExistingExternalUserSharingOnly' }
    }
    'SPO-SHARING-004'      = @{
        CommandName = 'Set-SpoDefaultSharingLinkType'
        Parameters  = @{ DefaultSharingLinkType = 'Direct' }
    }
    'SPO-SHARING-007'      = @{
        CommandName = 'Set-SpoDefaultLinkPermission'
        Parameters  = @{ DefaultLinkPermission = 'View' }
    }
}

function Get-RemediationCommand {
    <#
    .SYNOPSIS
        Maps a finding CheckId to its allowlisted typed command binding.
    .DESCRIPTION
        Allowlisted command-binding layer per EPIC-006 SPEC.md section 11
        item 1 and 06-remediation.md section 2.2: a check id resolves to a
        typed function name plus fixed parameters from the validated set in
        this file, never to an executable string. Registry
        remediation.powershell.command strings are data and are not evaluated
        here; this function performs a hashtable lookup only, so there is no
        string-evaluation path to misuse. Checks outside the validated set
        return Kind 'not-implemented' so the executor refuses them instead of
        running anything.
    .PARAMETER CheckId
        The finding CheckId, with or without the sub-number suffix. The
        trailing .\d+ suffix is stripped to key the binding table, matching
        Resolve-Remediation.
    .OUTPUTS
        [PSCustomObject] with CheckId, RegistryKey, Kind
        (typed | not-implemented), CommandName, Parameters, and Reason.
    .EXAMPLE
        Get-RemediationCommand -CheckId 'SPO-SHARING-001.2'
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [ValidateNotNullOrEmpty()]
        [string]$CheckId
    )

    process {
        $registryKey = $CheckId -replace '\.\d+$', ''
        $binding = $script:RemediationTypedCommands[$registryKey]

        if ($null -eq $binding) {
            [PSCustomObject]@{
                CheckId     = $CheckId
                RegistryKey = $registryKey
                Kind        = 'not-implemented'
                CommandName = $null
                Parameters  = @{}
                Reason      = 'not-implemented'
            }
            return
        }

        [PSCustomObject]@{
            CheckId     = $CheckId
            RegistryKey = $registryKey
            Kind        = 'typed'
            CommandName = $binding.CommandName
            Parameters  = $binding.Parameters.Clone()
            Reason      = $null
        }
    }
}
