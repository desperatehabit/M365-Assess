# ENTRA-SECDEFAULT-001 — Ensure Security Defaults are enabled

- **Mode:** manual
- **Severity:** High
- **License:** E3
- **Collector:** Entra
- **Category:** SECDEFAULT
- **Registry:** `src/M365-Assess/controls/registry.json` → checkId `ENTRA-SECDEFAULT-001`

## When this applies

The tenant does not use Conditional Access (or is a baseline tenant without Entra ID P1/P2)
and Security Defaults are disabled. Security Defaults provide a free baseline of identity
protections (MFA for admins, blocking legacy auth, requiring MFA registration).

**Do not recommend enabling Security Defaults if the tenant has Conditional Access
policies** — the two are mutually exclusive and enabling Security Defaults disables all CA
policies. In that case the remediation is to review CA coverage instead, not this control.

## Steps

1. Sign in to the **Microsoft Entra admin center** (https://entra.microsoft.com).
2. Go to **Entra ID → Overview → Properties → Manage security defaults**.
3. Set **Security defaults** to **Enabled**.
4. (Recommended) Expand **My organization is using Conditional Access** only if you intend
   to migrate to CA — this is the opt-out path, not the fix for this finding.
5. Select **Save**.

## Verification

- Re-run the `Entra` collector and confirm `ENTRA-SECDEFAULT-001` reports `Pass`.
- Confirm no Conditional Access policies exist that would conflict (if they do, stop and
  reassess — see "When this applies").

## Notes / caveats

- Enabling Security Defaults is tenant-wide and immediate; it can disrupt users relying on
  legacy authentication. Communicate before applying.
- Manual because the correct action depends on whether CA is in use — a context judgment
  the tool cannot make from the check result alone.
- Registry carries a PowerShell alternative
  (`Update-MgPolicyIdentitySecurityDefaultsEnforcementPolicy -IsEnabled $true`) but it is
  classified manual because of the CA-conflict judgment; it is an `auto-candidate` only for
  tenants confirmed to be CA-free.
