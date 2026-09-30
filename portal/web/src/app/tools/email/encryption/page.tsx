"use client";

// Message encryption (EPIC-024 SPEC.md §2 US-5, §3.5, §4.3, §6, §8; T-0469).
// Nav: Tools → Email Tools → Message Encryption. Title "Message Encryption"
// with the IRM/OME configuration and OME template settings read from the BFF,
// plus the OME template editor: plan preview (dry run) then apply with
// confirmation. Every read and write goes through the BFF; no browser call
// reaches a tenant directly. Write controls are disabled unless `canWrite`
// (RBAC) is set.

import React, { useCallback, useEffect, useState, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import {
  EncryptionPanel,
  type EncryptionTemplateOutcome,
  type MessageEncryptionConfig,
} from "../../../../components/email-tools/EncryptionPanel";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";

export type Fetcher = typeof fetch;

async function readMessageEncryption(tenantId: string, fetcher: Fetcher = fetch): Promise<MessageEncryptionConfig> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/mail/encryption`);
  if (!response.ok) {
    throw new Error(`Read message encryption failed: HTTP ${response.status}`);
  }
  return (await response.json()) as MessageEncryptionConfig;
}

async function previewMessageEncryptionTemplate(
  tenantId: string,
  templateId: string,
  settings: Record<string, string>,
  fetcher: Fetcher = fetch,
): Promise<EncryptionTemplateOutcome> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/mail/encryption`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId, settings, preview: true }),
  });
  if (!response.ok) {
    throw new Error(`Preview OME template change failed: HTTP ${response.status}`);
  }
  return (await response.json()) as EncryptionTemplateOutcome;
}

async function applyMessageEncryptionTemplate(
  tenantId: string,
  templateId: string,
  settings: Record<string, string>,
  fetcher: Fetcher = fetch,
): Promise<EncryptionTemplateOutcome> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/mail/encryption`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId, settings, confirm: true }),
  });
  if (!response.ok) {
    throw new Error(`Apply OME template change failed: HTTP ${response.status}`);
  }
  return (await response.json()) as EncryptionTemplateOutcome;
}

export default function MessageEncryptionPage(): ReactElement {
  const searchParams = useSearchParams();
  const currentTenantId = useCurrentTenantId();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), currentTenantId);

  const [config, setConfig] = useState<MessageEncryptionConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setConfig(await readMessageEncryption(tenantId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <RequireTenant tenantId={tenantId}>
      <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "20px" }}>
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Tools &gt; Email Tools &gt; Message Encryption</div>
          <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0" }}>Message Encryption</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            View the IRM/OME configuration and OME template settings; preview then apply OME template changes.
          </p>
        </div>
        <EncryptionPanel
          config={config}
          loading={loading}
          error={error}
          canWrite={true}
          onPreview={(templateId, settings) => previewMessageEncryptionTemplate(tenantId, templateId, settings)}
          onApply={(templateId, settings) => applyMessageEncryptionTemplate(tenantId, templateId, settings)}
        />
      </div>
    </RequireTenant>
  );
}
