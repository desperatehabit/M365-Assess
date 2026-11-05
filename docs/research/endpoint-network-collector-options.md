# Endpoint and network collection: build vs. reuse

**Status:** research, 2026-11-05. Recommends what to reuse before writing an endpoint or
network agent. Licenses were checked against each project's repository metadata or its own
documentation (sources at the end); anything marked *verify* still needs a look at the
LICENSE file or legal review before shipping.

## Decision (2026-11-05)

**Endpoint collection will use NinjaOne (formerly NinjaRMM)** for customers who want it,
rather than a new or open-source agent. NinjaOne is already the agent on those endpoints. The
remaining work is ingestion, deferred and tracked in T-0905, by one of two routes:

- **API:** pull device and script results from the NinjaOne API into the portal on a schedule
  or on demand, and turn them into `WIN-*` findings for the report and SSP.
- **Export/import:** export from NinjaOne and import the file into the portal (or into
  `Invoke-M365Assessment`), then produce the same findings.

The options below are kept for reference: the HardeningKitty finding lists can supply the
check logic for a NinjaOne script, the Batfish note still applies to network evidence, and
the licensing cautions still apply.

## What the agent has to read

CheckID's upstream registry already defines the checks. Before #950 partitioned the
registry to M365 collectors, it carried 814 checks this module drops, all attributed to a
collector named `AzAssess`, which has no public repository:

| Family | Checks | Content |
|---|---|---|
| `WIN-CONFIG` | 266 | CIS Windows security options, administrative templates |
| `WIN-AUDIT` | 152 | Advanced audit policy and related security options |
| `WIN-FIREWALL` | 23 | Windows Firewall per profile |
| `WIN-ACCOUNT` | 11 | Password and lockout policy |
| `WIN-SERVICES` | 2 | Service configuration |
| `AZ-*` | 360 | Azure subscription resources (App Service, AKS, storage, network, SQL, …) |

The 454 `WIN-*` checks map to 20 CMMC L2 practices (3.1.3, 3.1.5, 3.3.1, 3.3.3, 3.3.5, 3.3.6,
3.3.8, 3.3.9, 3.4.1, 3.4.2, 3.5.3, 3.5.7–3.5.9, 3.7.5, 3.8.6, 3.13.6, 3.13.10, 3.13.16,
3.14.2). Network segmentation (3.13.1, 3.13.5, 3.13.6) and time sync (3.3.7) also need
network-side evidence that no Microsoft 365 API exposes.

First question for the maintainer: **does `AzAssess` exist privately?** If it does, it is
the collector these checks were written for, and the rest of this note is secondary.

## Options

### 1. Read what Microsoft's agents already collect (no new agent)

Most CMMC customers already run two Microsoft endpoint agents, and M365-Assess already
holds the Graph connection to read them:

- **Microsoft Defender Vulnerability Management security baselines assessment.** It
  evaluates onboarded Windows devices against CIS and STIG benchmarks and exposes results
  per device (Defender API `/api/baselineConfigurations`; per-device results in the
  `DeviceTvmSecurityConfigurationAssessment` advanced hunting table). It requires Defender
  Vulnerability Management premium capabilities, through the add-on or Defender for
  Servers Plan 2.
- **Intune Remediations (device health scripts) and custom compliance.** A detection script
  runs on every managed device through the Intune Management Extension, and its output is
  readable through Graph (`deviceHealthScripts/{id}/deviceRunStates`). The same
  organization already publishes MIT-licensed generators for exactly this:
  `Galvnyz/GPOBaselineForge` (security baselines to Intune custom compliance packages) and
  `Galvnyz/IntuneSCT-Compliance` (ready-made detection scripts for the Windows 11 baseline).

**Pros:** nothing to install, same consent model, and it fits "no data leaves your
machine". **Cons:** it depends on the customer's licensing. Remediations needs Windows
Enterprise E3/E5 (or equivalent), and baseline assessment needs Defender Vulnerability
Management premium. Unmanaged devices are not covered.

### 2. A PowerShell endpoint collector built on HardeningKitty

`scipag/HardeningKitty` (**MIT**) audits a Windows machine against CSV "finding lists"
(CIS benchmarks, Microsoft security baselines, DoD STIG) using the same mechanisms the
`WIN-*` checks need: registry, `secedit`, `auditpol`, firewall, and services. It is
PowerShell, like this module.

Plan: map the finding-list rows to `WIN-*` check ids, run the audit on endpoints as an
Intune Remediation, a GPO startup script, or manually, write JSON results, and have
`Invoke-M365Assessment` import them (for example through an `-EndpointResults` folder) as
an `Endpoint` collector. This reaches devices option 1 cannot, at the cost of a
distribution step.

### 3. A persistent fleet agent (only if the portal needs continuous endpoint monitoring)

| Project | License | Notes |
|---|---|---|
| `osquery/osquery` | Apache-2.0 **or** GPL-2.0 (choose Apache) | SQL over OS state on Windows, macOS, and Linux. Mature, with no server of its own |
| `fleetdm/fleet` | MIT for the free edition; `ee/` code under Fleet's commercial license | osquery manager with policy queries and CIS benchmark policies. *Verify* which CIS policies are in the free tier |
| `wazuh/wazuh` | GPL-2.0 | Full agent and manager with CIS-based SCA policies. Copyleft: fine to run unmodified as a separate service, not to embed. CIS-CAT integration is proprietary |
| `Velocidex/velociraptor` | AGPL-3.0 (per maintainer) | DFIR-oriented collection. AGPL network clause: avoid modifying it inside a hosted service |
| `inspec/inspec` / `cinc-project/auditor` | Apache-2.0 source; Chef binaries need a Progress license | Use Cinc Auditor, the free community build, if InSpec profiles are wanted |
| `OpenSCAP/openscap` | LGPL-2.1 | Strong on Linux; weak Windows coverage |

Recommendation if option 3 is ever needed: **osquery under Apache-2.0 with Fleet free**.
It is cross-platform, permissive, and Fleet's REST API is easy for the portal BFF to read.

### 4. Network evidence

| Project | License | Use |
|---|---|---|
| `batfish/batfish` | Apache-2.0 | Offline analysis of exported firewall and router configs: reachability, deny-by-default, and whether public-facing zones are segmented. Directly evidences 3.13.1, 3.13.5, and 3.13.6 without touching the network |
| `projectdiscovery/nuclei` | MIT | External attack-surface checks against the customer's public IPs and domains |
| `zeek/zeek` | BSD-style (*verify*) | Traffic monitoring (3.14.6). An operations tool, not an assessment input |
| `nmap/nmap` | Nmap Public Source License | Free for end users, but **embedding or redistributing it in a commercial product needs an Nmap OEM license** (and Npcap has its own restriction). Let customers run it; do not bundle it |
| `greenbone/openvas-scanner` | GPL-2.0 | Vulnerability scanning; run as a separate service |

### 5. Azure (`AZ-*`)

`prowler-cloud/prowler` (**Apache-2.0**) has Azure and Microsoft 365 providers with CIS
Azure coverage, and could serve as or seed the `AZ-*` collector. Steampipe (AGPL-3.0) and
ScoutSuite (GPL-2.0) are copyleft alternatives.

## Recommendation

1. **Ask whether `AzAssess` exists.** If it does, use it.
2. **Phase 1, option 1:** read Defender Vulnerability Management baseline results and
   Intune Remediation outputs through the existing Graph and Defender connection, and
   build the detection scripts from `GPOBaselineForge` / `IntuneSCT-Compliance`. This
   needs no new agent and covers most `WIN-*` checks for customers with the licensing.
3. **Phase 2, option 2:** a HardeningKitty-based PowerShell collector, plus a JSON import
   into `Invoke-M365Assessment`, for unmanaged or unlicensed devices.
4. **Network:** a Batfish-based config analysis for segmentation practices, with the
   questionnaire as the fallback when configs are not available. Do not bundle Nmap.
5. **Only if the portal needs continuous monitoring:** osquery (Apache-2.0) with Fleet
   free.

## Licensing risk to raise before building

CIS Benchmark content is published under a non-commercial license for non-members (CC
BY-NC-SA, per CIS's terms; *verify*). Shipping CIS-derived finding lists or check text in a
commercial product, including HardeningKitty's CIS lists or Wazuh's CIS SCA policies, may
need CIS SecureSuite membership. Microsoft security baselines and DISA STIGs do not carry
that restriction. The same question applies to the CIS M365 mappings this module already
ships, so it is worth one legal review covering all of them.

## Sources

- osquery dual license: <https://github.com/facebook/osquery>
- Fleet licensing: <https://chat.osquery.io/t/4554/is-fleet-by-and-large-mit-licensed>
- Wazuh license and SCA: <https://github.com/wazuh/wazuh>,
  <https://documentation.wazuh.com/3.12/user-manual/capabilities/sec-config-assessment/index.html>
- Nmap Public Source License: <https://nmap.org/npsl/>, <https://nmap.org/man/man-legal.html>
- Chef InSpec licensing and Cinc: <https://www.chef.io/licensing-tiers-faq>,
  <https://docs.chef.io/licensing>, <https://cinc.sh/docs/>
- Velociraptor license (maintainer): <https://groups.google.com/g/velociraptor-discuss/c/OrInYpi6sUI>
- Defender Vulnerability Management baselines:
  <https://learn.microsoft.com/en-us/defender-endpoint/api/get-security-baselines-assessment-configurations>,
  <https://learn.microsoft.com/en-au/defender-vulnerability-management/tvm-security-baselines>
- Repository licenses for the other projects (HardeningKitty, Prowler, Batfish, Nuclei,
  OpenSCAP, Cinc Auditor, ScubaGear, Maester, Lynis, Steampipe, ScoutSuite, OpenVAS,
  GPOBaselineForge, IntuneSCT-Compliance): GitHub repository metadata, 2026-11-05.
