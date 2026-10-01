"use client";

// Domains page (EPIC-034 SPEC.md §3.1, §4.1; T-0668).
// Nav: Tenant Administration → Domains. Table of domains with row actions.
// Add domain opens a wizard (add → get verification records → verify).
// Set as default, Verify, and Remove route through T-0663 (EPIC-006 writes).
// Check DNS and View hand off to the T-0669 analyser.
// Strictly uses report theme tokens with zero colour literals.

import React, { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { DomainsTable } from "../../components/domains/DomainsTable";
import { AddDomainWizard } from "../../components/domains/AddDomainWizard";
import {
  addDomain,
  checkDomainDns,
  listDomains,
  removeDomain,
  setDefaultDomain,
  verifyDomain,
  type DomainItem,
} from "../../lib/domainsApi";

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1400px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--text-soft)",
  fontSize: "14px",
};

const primaryButtonStyle: CSSProperties = {
  padding: "10px 18px",
  background: "var(--accent)",
  color: "var(--on-accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  fontWeight: 600,
  fontSize: "14px",
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: "8px",
  cursor: "pointer",
};

const warningBannerStyle: CSSProperties = {
  padding: "12px 16px",
  background: "var(--warning-soft, var(--accent-soft))",
  border: "1px solid var(--warning, var(--accent))",
  borderRadius: "6px",
  color: "var(--warning-text, var(--accent-text, var(--accent)))",
  fontSize: "14px",
};

export default function DomainsPage(): ReactElement {
  const [domains, setDomains] = useState<readonly DomainItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [writeWarning, setWriteWarning] = useState<string | null>(null);

  const fetchDomains = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await listDomains("current");
      setDomains(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchDomains();
  }, []);

  const handleAddComplete = async (): Promise<void> => {
    setShowWizard(false);
    await fetchDomains();
  };

  const handleVerify = async (domain: DomainItem): Promise<void> => {
    setWriteWarning(
      `Verify is a write routed through the remediation engine (EPIC-006).`,
    );
    try {
      await verifyDomain("current", domain.domain);
      await fetchDomains();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSetDefault = async (domain: DomainItem): Promise<void> => {
    setWriteWarning(
      `Set as default is a write routed through the remediation engine (EPIC-006).`,
    );
    try {
      await setDefaultDomain("current", domain.domain);
      await fetchDomains();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemove = async (domain: DomainItem): Promise<void> => {
    setWriteWarning(
      `Remove is a write routed through the remediation engine (EPIC-006).`,
    );
    try {
      await removeDomain("current", domain.domain);
      await fetchDomains();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCheckDns = async (domain: DomainItem): Promise<void> => {
    try {
      await checkDomainDns("current", domain.domain);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleView = (domain: DomainItem): void => {
    window.location.href = `/tools/domain-check?domain=${encodeURIComponent(domain.domain)}`;
  };

  return (
    <div style={pageStyle} data-testid="domains-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Domains</h1>
          <p style={subtitleStyle}>
            Manage tenant domains, verification, and DNS health.
          </p>
        </div>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={() => setShowWizard(true)}
          data-testid="add-domain-btn"
        >
          Add domain
        </button>
      </div>

      {writeWarning && (
        <div style={warningBannerStyle} data-testid="write-warning">
          {writeWarning}
        </div>
      )}

      <DomainsTable
        domains={domains}
        loading={loading}
        error={error}
        onView={handleView}
        onCheckDns={handleCheckDns}
        onVerify={handleVerify}
        onSetDefault={handleSetDefault}
        onRemove={handleRemove}
      />

      {showWizard && (
        <AddDomainWizard
          onComplete={() => void handleAddComplete()}
          onCancel={() => setShowWizard(false)}
          onAddDomain={async (domain) => {
            return addDomain("current", domain);
          }}
          onVerifyDomain={async (domain) => {
            await verifyDomain("current", domain);
          }}
        />
      )}
    </div>
  );
}
