// CMMC 2.0 Level 2 System Security Plan contracts.
//
// The SSP covers the 110 NIST SP 800-171 Rev. 2 security requirements that make
// up CMMC Level 2 (17 of them are also Level 1). For each practice the portal
// merges three sources into one statement:
//
//   1. automated evidence: M365-Assess findings mapped to the practice through
//      the module registry (controls/registry.json, framework key "cmmc"),
//   2. the customer questionnaire: the consultant's recorded answer
//      (implementation status, responsibility, narrative, evidence, owner), and
//   3. a default responsibility hint for practices Microsoft fully or partly
//      covers (inherited or shared), from the catalog below.
//
// The shape is shared by the BFF (storage, merge, document generation) and the
// web questionnaire, so the catalog and status vocabulary cannot drift.

export const SSP_IMPLEMENTATION_STATUSES = [
  "implemented",
  "partially-implemented",
  "planned",
  "not-implemented",
  "not-applicable",
] as const;
export type SspImplementationStatus = (typeof SSP_IMPLEMENTATION_STATUSES)[number];

/** Who carries the practice: the customer, Microsoft (inherited), or both. */
export const SSP_RESPONSIBILITIES = ["customer", "shared", "inherited"] as const;
export type SspResponsibility = (typeof SSP_RESPONSIBILITIES)[number];

export const SSP_FAMILIES = {
  AC: "Access Control",
  AT: "Awareness and Training",
  AU: "Audit and Accountability",
  CM: "Configuration Management",
  IA: "Identification and Authentication",
  IR: "Incident Response",
  MA: "Maintenance",
  MP: "Media Protection",
  PS: "Personnel Security",
  PE: "Physical Protection",
  RA: "Risk Assessment",
  CA: "Security Assessment",
  SC: "System and Communications Protection",
  SI: "System and Information Integrity",
} as const;
export type SspFamily = keyof typeof SSP_FAMILIES;

export interface SspPractice {
  /** NIST SP 800-171 Rev. 2 requirement number, for example "3.1.1". */
  readonly id: string;
  readonly family: SspFamily;
  /** CMMC 2.0 practice id, for example "AC.L2-3.1.1". */
  readonly cmmcId: string;
  /** FAR 52.204-21 (CMMC Level 1) practice id when the practice is also Level 1. */
  readonly level1Id?: string;
  /** The requirement statement. */
  readonly requirement: string;
  /** Questionnaire prompt for practices no automated check covers. */
  readonly question?: string;
  /** Evidence an assessor will ask for. */
  readonly evidenceHint?: string;
  /** Suggested responsibility when nothing has been recorded. */
  readonly defaultResponsibility?: SspResponsibility;
  /** Why the default responsibility applies (shown in the questionnaire and SSP). */
  readonly inheritanceNote?: string;
}

/** The customer's answer for one practice. */
export interface SspPracticeResponse {
  readonly tenantId: string;
  readonly practiceId: string;
  readonly implementationStatus: SspImplementationStatus;
  readonly responsibility: SspResponsibility;
  readonly narrative: string;
  /** Evidence references: document names, links, ticket ids. */
  readonly evidence: readonly string[];
  readonly owner: string | null;
  /** ISO date a planned or partial practice is due to be complete (POA&M). */
  readonly plannedCompletion: string | null;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export type SspPracticeResponseInput = Omit<SspPracticeResponse, "tenantId" | "practiceId" | "updatedBy" | "updatedAt">;

/** System-level SSP fields (SSP sections 1-3). */
export interface SspSystemProfile {
  readonly tenantId: string;
  readonly organizationName: string;
  readonly systemName: string;
  readonly systemOwner: string;
  readonly securityContact: string;
  readonly description: string;
  /** Authorization boundary: what is in scope, including on-premises and cloud components. */
  readonly boundary: string;
  /** Operating environment: locations, users, endpoints, network. */
  readonly environment: string;
  /** Connections to external systems and service providers. */
  readonly interconnections: string;
  /** CUI categories processed, stored, or transmitted. */
  readonly cuiCategories: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export type SspSystemProfileInput = Omit<SspSystemProfile, "tenantId" | "updatedBy" | "updatedAt">;

export type SspAutomatedOutcome = "pass" | "fail" | "partial" | "review" | "not-assessed" | "none";

export interface SspAutomatedFinding {
  readonly checkId: string;
  readonly status: string;
  readonly controlName: string | null;
  readonly currentValue: string | null;
}

export interface SspAutomatedEvidence {
  /** Registry check ids mapped to the practice. */
  readonly checkIds: readonly string[];
  /** Findings from the tenant's latest run for those checks. */
  readonly findings: readonly SspAutomatedFinding[];
  readonly outcome: SspAutomatedOutcome;
  readonly runId: string | null;
}

export type SspStatusSource = "response" | "automated" | "none";

/** One practice as the questionnaire and the SSP show it. */
export interface SspPracticeView {
  readonly practice: SspPractice;
  readonly automated: SspAutomatedEvidence;
  readonly response: SspPracticeResponse | null;
  readonly effectiveStatus: SspImplementationStatus | "not-assessed";
  readonly effectiveResponsibility: SspResponsibility;
  readonly statusSource: SspStatusSource;
}

export interface SspSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<SspImplementationStatus | "not-assessed", number>>;
  /** Practices with neither an automated result nor a recorded answer. */
  readonly unanswered: number;
  readonly level1Implemented: number;
  readonly level1Total: number;
}

export interface SspDocumentView {
  readonly tenantId: string;
  readonly profile: SspSystemProfile | null;
  readonly practices: readonly SspPracticeView[];
  readonly summary: SspSummary;
  readonly generatedAt: string;
}

const MS_INHERITED = "Microsoft 365 (FedRAMP High / GCC High where applicable) implements this; the customer documents the inheritance.";

function practice(
  id: string,
  family: SspFamily,
  requirement: string,
  extra: Partial<Omit<SspPractice, "id" | "family" | "cmmcId" | "requirement">> = {},
): SspPractice {
  return Object.freeze({ id, family, cmmcId: `${family}.L2-${id}`, requirement, ...extra });
}

/**
 * The 110 NIST SP 800-171 Rev. 2 requirements (CMMC 2.0 Level 2). Level 1
 * practices carry their FAR 52.204-21 id. Practices with a `question` are the
 * ones no M365-Assess check covers: physical, personnel, process, and
 * Microsoft-inherited controls the questionnaire records.
 */
export const SSP_PRACTICES: readonly SspPractice[] = Object.freeze([
  // 3.1 Access Control
  practice("3.1.1", "AC", "Limit system access to authorized users, processes acting on behalf of authorized users, and devices (including other systems).", { level1Id: "AC.L1-B.1.I" }),
  practice("3.1.2", "AC", "Limit system access to the types of transactions and functions that authorized users are permitted to execute.", { level1Id: "AC.L1-B.1.II" }),
  practice("3.1.3", "AC", "Control the flow of CUI in accordance with approved authorizations."),
  practice("3.1.4", "AC", "Separate the duties of individuals to reduce the risk of malevolent activity without collusion."),
  practice("3.1.5", "AC", "Employ the principle of least privilege, including for specific security functions and privileged accounts."),
  practice("3.1.6", "AC", "Use non-privileged accounts or roles when accessing nonsecurity functions."),
  practice("3.1.7", "AC", "Prevent non-privileged users from executing privileged functions and capture the execution of such functions in audit logs."),
  practice("3.1.8", "AC", "Limit unsuccessful logon attempts."),
  practice("3.1.9", "AC", "Provide privacy and security notices consistent with applicable CUI rules."),
  practice("3.1.10", "AC", "Use session lock with pattern-hiding displays to prevent access and viewing of data after a period of inactivity."),
  practice("3.1.11", "AC", "Terminate (automatically) a user session after a defined condition."),
  practice("3.1.12", "AC", "Monitor and control remote access sessions."),
  practice("3.1.13", "AC", "Employ cryptographic mechanisms to protect the confidentiality of remote access sessions."),
  practice("3.1.14", "AC", "Route remote access via managed access control points."),
  practice("3.1.15", "AC", "Authorize remote execution of privileged commands and remote access to security-relevant information."),
  practice("3.1.16", "AC", "Authorize wireless access prior to allowing such connections."),
  practice("3.1.17", "AC", "Protect wireless access using authentication and encryption."),
  practice("3.1.18", "AC", "Control connection of mobile devices."),
  practice("3.1.19", "AC", "Encrypt CUI on mobile devices and mobile computing platforms."),
  practice("3.1.20", "AC", "Verify and control/limit connections to and use of external systems.", { level1Id: "AC.L1-B.1.III" }),
  practice("3.1.21", "AC", "Limit use of portable storage devices on external systems."),
  practice("3.1.22", "AC", "Control CUI posted or processed on publicly accessible systems.", { level1Id: "AC.L1-B.1.IV" }),

  // 3.2 Awareness and Training
  practice("3.2.1", "AT", "Ensure that managers, system administrators, and users of organizational systems are made aware of the security risks associated with their activities and of the applicable policies, standards, and procedures related to the security of those systems."),
  practice("3.2.2", "AT", "Ensure that personnel are trained to carry out their assigned information security-related duties and responsibilities.", {
    question: "How are administrators and other people with security duties trained for those duties, and how often?",
    evidenceHint: "Role-based training plan, course list, completion records for each privileged user.",
    defaultResponsibility: "customer",
  }),
  practice("3.2.3", "AT", "Provide security awareness training on recognizing and reporting potential indicators of insider threat.", {
    question: "Does security awareness training cover recognizing and reporting insider threat indicators? Who delivers it and how is completion tracked?",
    evidenceHint: "Training content covering insider threat, completion records, reporting procedure.",
    defaultResponsibility: "customer",
  }),

  // 3.3 Audit and Accountability
  practice("3.3.1", "AU", "Create and retain system audit logs and records to the extent needed to enable the monitoring, analysis, investigation, and reporting of unlawful or unauthorized system activity."),
  practice("3.3.2", "AU", "Ensure that the actions of individual system users can be uniquely traced to those users, so they can be held accountable for their actions."),
  practice("3.3.3", "AU", "Review and update logged events."),
  practice("3.3.4", "AU", "Alert in the event of an audit logging process failure."),
  practice("3.3.5", "AU", "Correlate audit record review, analysis, and reporting processes for investigation and response to indications of unlawful, unauthorized, suspicious, or unusual activity."),
  practice("3.3.6", "AU", "Provide audit record reduction and report generation to support on-demand analysis and reporting."),
  practice("3.3.7", "AU", "Provide a system capability that compares and synchronizes internal system clocks with an authoritative source to generate time stamps for audit records.", {
    question: "Do on-premises servers, network devices, and endpoints synchronize time with an authoritative source? Which source?",
    evidenceHint: "NTP/w32time configuration (domain hierarchy or time.windows.com); Microsoft 365 services are time-synchronized by Microsoft.",
    defaultResponsibility: "shared",
    inheritanceNote: "Microsoft 365 and Entra ID timestamp audit records from Microsoft-synchronized clocks; on-premises and endpoint clocks remain the customer's.",
  }),
  practice("3.3.8", "AU", "Protect audit information and audit logging tools from unauthorized access, modification, and deletion."),
  practice("3.3.9", "AU", "Limit management of audit logging functionality to a subset of privileged users."),

  // 3.4 Configuration Management
  practice("3.4.1", "CM", "Establish and maintain baseline configurations and inventories of organizational systems (including hardware, software, firmware, and documentation) throughout the respective system development life cycles."),
  practice("3.4.2", "CM", "Establish and enforce security configuration settings for information technology products employed in organizational systems."),
  practice("3.4.3", "CM", "Track, review, approve or disapprove, and log changes to organizational systems."),
  practice("3.4.4", "CM", "Analyze the security impact of changes prior to implementation."),
  practice("3.4.5", "CM", "Define, document, approve, and enforce physical and logical access restrictions associated with changes to organizational systems."),
  practice("3.4.6", "CM", "Employ the principle of least functionality by configuring organizational systems to provide only essential capabilities."),
  practice("3.4.7", "CM", "Restrict, disable, or prevent the use of nonessential programs, functions, ports, protocols, and services."),
  practice("3.4.8", "CM", "Apply deny-by-exception (blacklisting) policy to prevent the use of unauthorized software or deny-all, permit-by-exception (whitelisting) policy to allow the execution of authorized software."),
  practice("3.4.9", "CM", "Control and monitor user-installed software."),

  // 3.5 Identification and Authentication
  practice("3.5.1", "IA", "Identify system users, processes acting on behalf of users, and devices.", { level1Id: "IA.L1-B.1.V" }),
  practice("3.5.2", "IA", "Authenticate (or verify) the identities of users, processes, or devices, as a prerequisite to allowing access to organizational systems.", { level1Id: "IA.L1-B.1.VI" }),
  practice("3.5.3", "IA", "Use multifactor authentication for local and network access to privileged accounts and for network access to non-privileged accounts."),
  practice("3.5.4", "IA", "Employ replay-resistant authentication mechanisms for network access to privileged and non-privileged accounts."),
  practice("3.5.5", "IA", "Prevent reuse of identifiers for a defined period."),
  practice("3.5.6", "IA", "Disable identifiers after a defined period of inactivity."),
  practice("3.5.7", "IA", "Enforce a minimum password complexity and change of characters when new passwords are created."),
  practice("3.5.8", "IA", "Prohibit password reuse for a specified number of generations."),
  practice("3.5.9", "IA", "Allow temporary password use for system logons with an immediate change to a permanent password."),
  practice("3.5.10", "IA", "Store and transmit only cryptographically-protected passwords.", {
    question: "Are any passwords for in-scope systems stored or sent outside Entra ID (on-premises AD, local accounts, applications, scripts)? How are they protected?",
    evidenceHint: "Entra ID stores salted password hashes and uses TLS; list any other credential stores and their protection.",
    defaultResponsibility: "shared",
    inheritanceNote: MS_INHERITED,
  }),
  practice("3.5.11", "IA", "Obscure feedback of authentication information.", {
    question: "Do all in-scope sign-in prompts outside Microsoft 365 (on-premises, line-of-business apps, devices) mask passwords as they are typed?",
    evidenceHint: "Entra ID and Microsoft 365 sign-in mask input by design; screenshots for other systems.",
    defaultResponsibility: "inherited",
    inheritanceNote: MS_INHERITED,
  }),

  // 3.6 Incident Response
  practice("3.6.1", "IR", "Establish an operational incident-handling capability for organizational systems that includes preparation, detection, analysis, containment, recovery, and user response activities."),
  practice("3.6.2", "IR", "Track, document, and report incidents to designated officials and/or authorities both internal and external to the organization."),
  practice("3.6.3", "IR", "Test the organizational incident response capability.", {
    question: "When was the incident response plan last tested (tabletop or live exercise), who took part, and what changed afterwards?",
    evidenceHint: "Exercise schedule, after-action report, updated IR plan.",
    defaultResponsibility: "customer",
  }),

  // 3.7 Maintenance
  practice("3.7.1", "MA", "Perform maintenance on organizational systems.", {
    question: "How is maintenance of in-scope systems scheduled, performed, and recorded (patching windows, hardware service)?",
    evidenceHint: "Maintenance procedure and records or tickets.",
    defaultResponsibility: "shared",
    inheritanceNote: "Microsoft maintains the Microsoft 365 service; customer-owned endpoints and on-premises systems remain the customer's.",
  }),
  practice("3.7.2", "MA", "Provide controls on the tools, techniques, mechanisms, and personnel used to conduct system maintenance.", {
    question: "Which maintenance tools (remote support, diagnostic software) are approved, and who may use them?",
    evidenceHint: "Approved tools list, access list for maintenance personnel.",
    defaultResponsibility: "customer",
  }),
  practice("3.7.3", "MA", "Ensure equipment removed for off-site maintenance is sanitized of any CUI."),
  practice("3.7.4", "MA", "Check media containing diagnostic and test programs for malicious code before the media are used in organizational systems.", {
    question: "Are diagnostic and test media scanned for malware before use? By what tool and procedure?",
    evidenceHint: "Procedure, scan records.",
    defaultResponsibility: "customer",
  }),
  practice("3.7.5", "MA", "Require multifactor authentication to establish nonlocal maintenance sessions via external network connections and terminate such connections when nonlocal maintenance is complete."),
  practice("3.7.6", "MA", "Supervise the maintenance activities of maintenance personnel without required access authorization.", {
    question: "How are vendors or technicians without authorization escorted or supervised while working on in-scope systems?",
    evidenceHint: "Escort procedure, visitor and maintenance logs.",
    defaultResponsibility: "customer",
  }),

  // 3.8 Media Protection
  practice("3.8.1", "MP", "Protect (i.e., physically control and securely store) system media containing CUI, both paper and digital."),
  practice("3.8.2", "MP", "Limit access to CUI on system media to authorized users."),
  practice("3.8.3", "MP", "Sanitize or destroy system media containing CUI before disposal or release for reuse.", { level1Id: "MP.L1-B.1.VII" }),
  practice("3.8.4", "MP", "Mark media with necessary CUI markings and distribution limitations."),
  practice("3.8.5", "MP", "Control access to media containing CUI and maintain accountability for media during transport outside of controlled areas.", {
    question: "How is physical media containing CUI (drives, paper) tracked and protected when it leaves controlled areas?",
    evidenceHint: "Media transport procedure, chain-of-custody log, approved couriers.",
    defaultResponsibility: "customer",
  }),
  practice("3.8.6", "MP", "Implement cryptographic mechanisms to protect the confidentiality of CUI stored on digital media during transport unless otherwise protected by alternative physical safeguards."),
  practice("3.8.7", "MP", "Control the use of removable media on system components."),
  practice("3.8.8", "MP", "Prohibit the use of portable storage devices when such devices have no identifiable owner."),
  practice("3.8.9", "MP", "Protect the confidentiality of backup CUI at storage locations."),

  // 3.9 Personnel Security
  practice("3.9.1", "PS", "Screen individuals prior to authorizing access to organizational systems containing CUI.", {
    question: "What screening (background checks, references) happens before someone is given access to CUI, and who approves it?",
    evidenceHint: "HR screening policy, records for a sample of users.",
    defaultResponsibility: "customer",
  }),
  practice("3.9.2", "PS", "Ensure that organizational systems containing CUI are protected during and after personnel actions such as terminations and transfers."),

  // 3.10 Physical Protection
  practice("3.10.1", "PE", "Limit physical access to organizational systems, equipment, and the respective operating environments to authorized individuals.", {
    level1Id: "PE.L1-B.1.VIII",
    question: "How is physical access to offices, server rooms, and equipment limited to authorized people (badges, keys, locks)?",
    evidenceHint: "Facility access policy, badge or key access list.",
    defaultResponsibility: "shared",
    inheritanceNote: "Microsoft protects its datacenters; the customer protects its own facilities and endpoints.",
  }),
  practice("3.10.2", "PE", "Protect and monitor the physical facility and support infrastructure for organizational systems.", {
    question: "How are the facility and its support infrastructure (power, cameras, alarms) protected and monitored?",
    evidenceHint: "Camera and alarm coverage, monitoring contract.",
    defaultResponsibility: "shared",
    inheritanceNote: "Microsoft protects its datacenters; the customer protects its own facilities and endpoints.",
  }),
  practice("3.10.3", "PE", "Escort visitors and monitor visitor activity.", {
    level1Id: "PE.L1-B.1.IX",
    question: "Are visitors signed in, escorted, and monitored in areas where CUI is handled?",
    evidenceHint: "Visitor procedure, visitor log.",
    defaultResponsibility: "customer",
  }),
  practice("3.10.4", "PE", "Maintain audit logs of physical access.", {
    level1Id: "PE.L1-B.1.IX",
    question: "Where are physical access logs kept (badge system, sign-in sheets), and how long are they retained?",
    evidenceHint: "Badge system export or visitor log, retention period.",
    defaultResponsibility: "customer",
  }),
  practice("3.10.5", "PE", "Control and manage physical access devices.", {
    level1Id: "PE.L1-B.1.IX",
    question: "How are keys, badges, and access codes issued, inventoried, and revoked?",
    evidenceHint: "Key and badge inventory, revocation records.",
    defaultResponsibility: "customer",
  }),
  practice("3.10.6", "PE", "Enforce safeguarding measures for CUI at alternate work sites.", {
    question: "What rules apply to working with CUI from home or other alternate sites, and how are they enforced?",
    evidenceHint: "Telework policy, signed acknowledgements, device controls.",
    defaultResponsibility: "customer",
  }),

  // 3.11 Risk Assessment
  practice("3.11.1", "RA", "Periodically assess the risk to organizational operations (including mission, functions, image, or reputation), organizational assets, and individuals, resulting from the operation of organizational systems and the associated processing, storage, or transmission of CUI."),
  practice("3.11.2", "RA", "Scan for vulnerabilities in organizational systems and applications periodically and when new vulnerabilities affecting those systems and applications are identified."),
  practice("3.11.3", "RA", "Remediate vulnerabilities in accordance with risk assessments."),

  // 3.12 Security Assessment
  practice("3.12.1", "CA", "Periodically assess the security controls in organizational systems to determine if the controls are effective in their application."),
  practice("3.12.2", "CA", "Develop and implement plans of action designed to correct deficiencies and reduce or eliminate vulnerabilities in organizational systems.", {
    question: "Is there a plan of action and milestones (POA&M) for open deficiencies? Who owns it and how often is it reviewed?",
    evidenceHint: "POA&M (the SSP export lists planned and partial practices with dates).",
    defaultResponsibility: "customer",
  }),
  practice("3.12.3", "CA", "Monitor security controls on an ongoing basis to ensure the continued effectiveness of the controls."),
  practice("3.12.4", "CA", "Develop, document, and periodically update system security plans that describe system boundaries, system environments of operation, how security requirements are implemented, and the relationships with or connections to other systems.", {
    question: "Who maintains this SSP, how often is it reviewed, and when was it last approved?",
    evidenceHint: "This SSP with its review and approval record.",
    defaultResponsibility: "customer",
  }),

  // 3.13 System and Communications Protection
  practice("3.13.1", "SC", "Monitor, control, and protect communications (i.e., information transmitted or received by organizational systems) at the external boundaries and key internal boundaries of organizational systems.", { level1Id: "SC.L1-B.1.X" }),
  practice("3.13.2", "SC", "Employ architectural designs, software development techniques, and systems engineering principles that promote effective information security within organizational systems.", {
    question: "How are security principles applied when designing or changing in-scope systems (architecture review, secure configuration standards, change control)?",
    evidenceHint: "Architecture diagram, design review checklist, change records.",
    defaultResponsibility: "shared",
    inheritanceNote: "Microsoft engineers the Microsoft 365 platform; the customer's own architecture and configuration remain the customer's.",
  }),
  practice("3.13.3", "SC", "Separate user functionality from system management functionality."),
  practice("3.13.4", "SC", "Prevent unauthorized and unintended information transfer via shared system resources.", {
    question: "Do any in-scope on-premises or shared systems (file servers, shared workstations, VDI) reuse memory or storage between users? How is residual data cleared?",
    evidenceHint: "Microsoft 365 tenant isolation is Microsoft's; describe controls for any customer-shared resources.",
    defaultResponsibility: "inherited",
    inheritanceNote: MS_INHERITED,
  }),
  practice("3.13.5", "SC", "Implement subnetworks for publicly accessible system components that are physically or logically separated from internal networks.", { level1Id: "SC.L1-B.1.XI" }),
  practice("3.13.6", "SC", "Deny network communications traffic by default and allow network communications traffic by exception (i.e., deny all, permit by exception)."),
  practice("3.13.7", "SC", "Prevent remote devices from simultaneously establishing non-remote connections with organizational systems and communicating via some other connection to resources in external networks (i.e., split tunneling)."),
  practice("3.13.8", "SC", "Implement cryptographic mechanisms to prevent unauthorized disclosure of CUI during transmission unless otherwise protected by alternative physical safeguards."),
  practice("3.13.9", "SC", "Terminate network connections associated with communications sessions at the end of the sessions or after a defined period of inactivity."),
  practice("3.13.10", "SC", "Establish and manage cryptographic keys for cryptography employed in organizational systems.", {
    question: "Which encryption keys does the organization manage itself (BitLocker recovery keys, customer keys, certificates, VPN keys)? How are they generated, stored, rotated, and recovered?",
    evidenceHint: "Key inventory, BitLocker key escrow to Entra ID, certificate lifecycle procedure.",
    defaultResponsibility: "shared",
    inheritanceNote: "Microsoft manages the service encryption keys for Microsoft 365; customer-managed keys and certificates remain the customer's.",
  }),
  practice("3.13.11", "SC", "Employ FIPS-validated cryptography when used to protect the confidentiality of CUI."),
  practice("3.13.12", "SC", "Prohibit remote activation of collaborative computing devices and provide indication of devices in use to users present at the device."),
  practice("3.13.13", "SC", "Control and monitor the use of mobile code."),
  practice("3.13.14", "SC", "Control and monitor the use of Voice over Internet Protocol (VoIP) technologies.", {
    question: "Which VoIP services are in use (Teams Phone, other systems)? How are calling, external federation, and recording controlled and monitored?",
    evidenceHint: "Teams calling and external access policies, call quality and usage reports, any third-party VoIP configuration.",
    defaultResponsibility: "shared",
    inheritanceNote: "Microsoft operates the Teams service; the customer configures calling, federation, and monitoring.",
  }),
  practice("3.13.15", "SC", "Protect the authenticity of communications sessions."),
  practice("3.13.16", "SC", "Protect the confidentiality of CUI at rest."),

  // 3.14 System and Information Integrity
  practice("3.14.1", "SI", "Identify, report, and correct system flaws in a timely manner.", { level1Id: "SI.L1-B.1.XII" }),
  practice("3.14.2", "SI", "Provide protection from malicious code at designated locations within organizational systems.", { level1Id: "SI.L1-B.1.XIII" }),
  practice("3.14.3", "SI", "Monitor system security alerts and advisories and take action in response."),
  practice("3.14.4", "SI", "Update malicious code protection mechanisms when new releases are available.", { level1Id: "SI.L1-B.1.XIV" }),
  practice("3.14.5", "SI", "Perform periodic scans of organizational systems and real-time scans of files from external sources as files are downloaded, opened, or executed.", { level1Id: "SI.L1-B.1.XV" }),
  practice("3.14.6", "SI", "Monitor organizational systems, including inbound and outbound communications traffic, to detect attacks and indicators of potential attacks."),
  practice("3.14.7", "SI", "Identify unauthorized use of organizational systems."),
]);

const PRACTICES_BY_ID: ReadonlyMap<string, SspPractice> = new Map(SSP_PRACTICES.map((entry) => [entry.id, entry]));

export function getSspPractice(practiceId: string): SspPractice | undefined {
  return PRACTICES_BY_ID.get(practiceId);
}

export function isSspImplementationStatus(value: unknown): value is SspImplementationStatus {
  return typeof value === "string" && (SSP_IMPLEMENTATION_STATUSES as readonly string[]).includes(value);
}

export function isSspResponsibility(value: unknown): value is SspResponsibility {
  return typeof value === "string" && (SSP_RESPONSIBILITIES as readonly string[]).includes(value);
}
