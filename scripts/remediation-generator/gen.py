"""Generator for per-check remediation scripts. Specs live in spec_*.py."""
import json, os, textwrap

S = os.path.dirname(os.path.abspath(__file__))  # triage.md lives next to this file
REPO = os.path.abspath(os.path.join(S, '..', '..', 'src', 'M365-Assess'))
OUT = REPO + '/Remediate/Scripts'

_tri = {}
for l in open(S + '/triage.md'):
    if l.startswith('| `'):
        r = l.rstrip('\n').split(' | ')
        _tri[r[0].strip('| `')] = dict(name=r[1], collector=r[2], bucket=r[3], approach=r[4], api=r[5])

CONN_TEXT = {
    'Graph': 'Microsoft Graph (Connect-MgGraph)',
    'ExchangeOnline': 'Exchange Online (Connect-ExchangeOnline)',
    'SecurityCompliance': 'Security & Compliance PowerShell (Connect-IPPSSession)',
    'SharePoint': 'SharePoint Online (Connect-SPOService)',
    'Teams': 'Microsoft Teams (Connect-MicrosoftTeams)',
    'PowerBI': 'Power BI (Connect-PowerBIServiceAccount) as a Fabric administrator',
    'Azure': 'Azure Resource Manager (Connect-AzAccount)',
}


def ind(text, n):
    return textwrap.indent(textwrap.dedent(text).strip('\n'), ' ' * n)


def emit(cid, *, desc, desired, services, steps, scopes=(), params=(), prelude='',
         notes='', example_args='', folder=None):
    """params: list of (name, decl, help). decl is the full PS parameter text
    without the $name, e.g. "[Parameter(Mandatory)]\n[string[]]". steps: list of
    dict(target, desired, get, test, set, skipverify=False)."""
    t = _tri[cid]
    folder = folder or t['collector']
    conn = ', '.join(CONN_TEXT[s] for s in services)
    if scopes:
        conn += '; Graph scopes: ' + ', '.join(scopes)
    lines = ['<#', '.SYNOPSIS', f"    Remediates {cid}: {t['name']}", '.DESCRIPTION']
    lines += [ind(desc, 4), '', f'    Desired state: {desired}', f'    Requires: {conn}.']
    if notes:
        lines += ['', ind(notes, 4)]
    lines += ['',
              f"    Triage bucket: {t['bucket']} ({t['approach']}).",
              '    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant',
              '    and not registered in Remediate/Get-RemediationCommand.ps1. Run with',
              '    -WhatIf first, then re-run the assessment to confirm the check passes.']
    for name, _decl, hlp in params:
        lines += [f".PARAMETER {name.split(' ')[0]}", ind(hlp, 4)]
    lines += ['.EXAMPLE', f'    PS> ./Remediate/Scripts/{folder}/{cid}.ps1 {example_args}'.rstrip() + ' -WhatIf',
              '    Shows what would change without changing anything.',
              '.EXAMPLE', f'    PS> ./Remediate/Scripts/{folder}/{cid}.ps1 {example_args}'.rstrip(),
              '    Applies the change after a confirmation prompt and verifies it.',
              '.OUTPUTS',
              '    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.',
              '#>',
              "[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]",
              '[OutputType([PSCustomObject])]']
    if params:
        lines.append('param(')
        blocks = []
        for name, decl, _h in params:
            d = textwrap.dedent(decl).strip('\n').split('\n')
            d[-1] = d[-1] + f'${name}'
            blocks.append('\n'.join('    ' + x for x in d))
        lines.append(',\n\n'.join(blocks))
        lines.append(')')
    else:
        lines.append('param()')
    lines += ['', "$ErrorActionPreference = 'Stop'",
              ". (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')"]
    svc = ', '.join(f"'{s}'" for s in services)
    a = f'Assert-RemediationConnection -Service {svc}'
    if scopes:
        a += ' -GraphScope ' + ', '.join(f"'{s}'" for s in scopes)
    lines.append(a)
    if prelude:
        lines += ['', textwrap.dedent(prelude).strip('\n')]
    for i, st in enumerate(steps, 1):
        var = '$step' if len(steps) == 1 else f'$step{i}'
        lines += ['', f'{var} = @{{',
                  f"    CheckId   = '{cid}'",
                  f"    Target    = {psq(st['target'])}",
                  f"    Desired   = {psq(st['desired'])}",
                  '    GetState  = {', ind(st['get'], 8), '    }',
                  '    TestState = {', '        param($State)', ind(st['test'], 8), '    }',
                  '    SetState  = {', '        param($State)', ind(st['set'], 8), '    }']
        if st.get('skipverify'):
            lines.append('    SkipVerify = $true')
        lines += ['}', f'Invoke-RemediationStep -Cmdlet $PSCmdlet @{var[1:]}']
    path = f'{OUT}/{folder}/{cid}.ps1'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    body = '\n'.join(lines) + '\n'
    open(path, 'w', encoding='utf-8').write(body)
    return path


def psq(s):
    """PowerShell single-quoted string literal, or pass through an expression
    when it starts with '(' or '$' or '"'."""
    if s.startswith(('(', '$', '"')):
        return s
    return "'" + s.replace("'", "''") + "'"


def pslit(v, depth=0):
    """Python value -> PowerShell literal."""
    if isinstance(v, bool):
        return '$true' if v else '$false'
    if v is None:
        return '$null'
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        if v.startswith('$'):
            return v
        return "'" + v.replace("'", "''") + "'"
    if isinstance(v, (list, tuple)):
        return '@(' + ', '.join(pslit(x) for x in v) + ')'
    if isinstance(v, dict):
        pad = '    ' * (depth + 1)
        inner = '\n'.join(f"{pad}{k if k.replace('_','').isalnum() else pslit(k)} = {pslit(x, depth + 1)}" for k, x in v.items())
        return '@{\n' + inner + '\n' + '    ' * depth + '}'
    raise TypeError(v)


def flat(d, prefix=''):
    out = {}
    for k, v in d.items():
        if isinstance(v, dict):
            out.update(flat(v, prefix + k + '.'))
        else:
            out[prefix + k] = v
    return out


def graph_props(cid, *, uri, body, scopes, desc, notes='', params=(), expected=None, method='PATCH',
                desired=None, target=None, prelude=''):
    """Single Graph resource: GET uri, compare body (flattened), PATCH body."""
    expected = expected if expected is not None else flat(body)
    desired = desired or ', '.join(f'{k} = {pslit(v)}' for k, v in expected.items())
    exp_ps = '@{\n' + '\n'.join(f"    {pslit(k)} = {pslit(v)}" for k, v in expected.items()) + '\n}'
    prelude = (prelude + '\n' if prelude else '') + f"$expected = {exp_ps}\n$body = {pslit(body)}"
    return emit(cid, desc=desc, desired=desired, services=['Graph'], scopes=scopes, params=params, notes=notes,
                prelude=prelude,
                steps=[dict(target=target or f'Microsoft Graph {uri}', desired=desired,
                            get=f"Get-RemediationGraphObject -Uri '{uri}'",
                            test='Test-RemediationProperty -State $State -Expected $expected',
                            set=f"Set-RemediationGraphObject -Uri '{uri}' -Body $body" + ('' if method == 'PATCH' else f" -Method {method}"))])


def cmdlet_step(*, get, setcmd, expected, target, test=None, desired=None, settings=None, var='settings'):
    """A Get-X / Set-X @settings step. expected: dict prop->value used both for
    the test (unless test given) and as the splatted Set parameters (unless
    settings given)."""
    settings = settings if settings is not None else expected
    desired = desired or ', '.join(f'{k} = {pslit(v)}' for k, v in expected.items())
    exp_ps = '@{\n' + '\n'.join(f"    {k} = {pslit(v)}" for k, v in expected.items()) + '\n}'
    return dict(target=target, desired=desired, get=get,
                test=test or f'Test-RemediationProperty -State $State -Expected {exp_ps}',
                set=f'${var} = {pslit(settings)}\n{setcmd} @{var}')


def cmdlet_props(cid, *, service, get, setcmd, expected, desc, target, test=None, notes='', params=(),
                 desired=None, settings=None, prelude=''):
    st = cmdlet_step(get=get, setcmd=setcmd, expected=expected, target=target, test=test, desired=desired,
                     settings=settings)
    return emit(cid, desc=desc, desired=st['desired'], services=[service], params=params, notes=notes,
                prelude=prelude, steps=[st])


CA_SCOPES = ['Policy.ReadWrite.ConditionalAccess', 'Policy.Read.All', 'Application.Read.All']
CA_STATE = ("PolicyState = 'enabledForReportingButNotEnforced'",
            "[Parameter()]\n[ValidateSet('enabledForReportingButNotEnforced', 'enabled', 'disabled')]\n[string]",
            "Policy state. Defaults to report-only (enabledForReportingButNotEnforced) so you can review\nsign-in impact in the CA insights workbook first. The assessment check only passes once the\npolicy is 'enabled'.")
CA_BREAKGLASS = ('BreakGlassAccountId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]",
                 'Object IDs of emergency-access (break-glass) accounts to exclude, so a misconfiguration\ncannot lock every administrator out.')
CA_EXCLUDEGROUP = ('ExcludeGroupId', "[Parameter()]\n[string[]]", 'Object IDs of groups to exclude (pilot exceptions, service accounts).')


def ca_emit(cid, *, name, desc, policy, params=(), notes='', breakglass=True, extra_prelude='', example_args=None,
            extra_steps=()):
    """policy: PowerShell hashtable literal text for conditions/grant/session
    (without displayName/state, which are added). It may reference $excludeUsers
    and $excludeGroups."""
    ps = list(params)
    if breakglass:
        ps = [CA_BREAKGLASS] + ps
    ps += [CA_EXCLUDEGROUP, CA_STATE, (f"PolicyName = '{name}'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]",
                                       'Display name of the policy to create or update.')]
    prelude = ("$excludeUsers = @($BreakGlassAccountId | Where-Object { $_ })\n" if breakglass else "$excludeUsers = @()\n") + \
        "$excludeGroups = @($ExcludeGroupId | Where-Object { $_ })\n" + (extra_prelude + '\n' if extra_prelude else '') + \
        "$policy = " + policy.strip() + "\n$policy['displayName'] = $PolicyName\n$policy['state'] = $PolicyState"
    n = ('New policies are created in report-only mode by default. Review the sign-in impact\n'
         '(Entra admin center > Conditional Access > Insights and reporting), then re-run with\n'
         "-PolicyState enabled.")
    if notes:
        n += '\n' + notes
    if example_args is None:
        example_args = "-BreakGlassAccountId '00000000-0000-0000-0000-000000000001'" if breakglass else ''
    return emit(cid, desc=desc, desired='"Conditional Access policy ' + "'$PolicyName' in state $PolicyState" + '"', services=['Graph'],
                scopes=CA_SCOPES, params=ps, notes=n, prelude=prelude, example_args=example_args,
                steps=list(extra_steps) + [dict(target='"Conditional Access policy $PolicyName"', desired='"$PolicyState, settings as defined"',
                            get='Get-RemediationCaPolicy -DisplayName $PolicyName',
                            test='Test-RemediationCaPolicy -State $State -Policy $policy',
                            set='Set-RemediationCaPolicy -Existing $State -Policy $policy')])


def ca_users(include="@('All')", roles=None):
    """conditions.users block text."""
    inner = f"includeUsers  = {include}\n            excludeUsers  = $excludeUsers\n            excludeGroups = $excludeGroups"
    if roles:
        inner = f"includeRoles  = {roles}\n            excludeUsers  = $excludeUsers\n            excludeGroups = $excludeGroups"
    return "users = @{\n            " + inner + "\n        }"


def graph_step(*, uri, body, target, expected=None, method='PATCH', desired=None, test=None):
    expected = expected if expected is not None else flat(body)
    desired = desired or ', '.join(f'{k} = {pslit(v)}' for k, v in expected.items())
    exp_ps = '@{\n' + '\n'.join(f"    {pslit(k)} = {pslit(v)}" for k, v in expected.items()) + '\n}'
    return dict(target=target, desired=desired, get=f"Get-RemediationGraphObject -Uri '{uri}'",
                test=test or f'Test-RemediationProperty -State $State -Expected {exp_ps}',
                set=f"$body = {pslit(body)}\nSet-RemediationGraphObject -Uri '{uri}' -Body $body" + ('' if method == 'PATCH' else f' -Method {method}'))
