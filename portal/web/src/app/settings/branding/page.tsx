"use client";

// Branding page (EPIC-037 SPEC.md §3.2, §4.2, §9; T-0729). Edit -> live preview -> save
// against the T-0724 API. The preview posts the unsaved draft to
// POST /v1/branding/preview, so the operator sees the renderer's own fragments before
// saving. Uploads go through POST /v1/branding/assets/:kind and surface the T-0723
// validator's message verbatim on rejection.

import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import BrandingForm, {
  type BrandingAssetKind,
  type BrandingConfig,
} from "../../../components/settings/BrandingForm";
import BrandingPreview, {
  type BrandingPreviewFragments,
} from "../../../components/settings/BrandingPreview";

export const BRANDING_API_PATH = "/v1/branding";
export const BRANDING_PREVIEW_API_PATH = "/v1/branding/preview";
export const BRANDING_ASSET_API_PATH = "/v1/branding/assets";

export type BrandingView = BrandingConfig & {
  readonly logoUrl?: string | null;
  readonly coverUrl?: string | null;
};

export type Fetcher = typeof fetch;

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    if (typeof body.message === "string" && body.message.length > 0) return body.message;
  } catch {
    // non-JSON error body; keep the fallback
  }
  return fallback;
}

export async function loadBranding(fetcher: Fetcher = fetch): Promise<BrandingView> {
  const response = await fetcher(BRANDING_API_PATH);
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Failed to load branding (HTTP ${response.status})`));
  }
  const body = (await response.json()) as { branding: BrandingView };
  return body.branding;
}

export async function previewBranding(
  draft: BrandingConfig,
  reportKind: string,
  fetcher: Fetcher = fetch,
): Promise<BrandingPreviewFragments> {
  const query = reportKind.trim().length > 0 ? `?reportKind=${encodeURIComponent(reportKind.trim())}` : "";
  const response = await fetcher(`${BRANDING_PREVIEW_API_PATH}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Preview failed (HTTP ${response.status})`));
  }
  return (await response.json()) as BrandingPreviewFragments;
}

export async function saveBranding(
  draft: BrandingConfig,
  fetcher: Fetcher = fetch,
): Promise<BrandingView> {
  const response = await fetcher(BRANDING_API_PATH, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Save failed (HTTP ${response.status})`));
  }
  const body = (await response.json()) as { branding: BrandingView };
  return body.branding;
}

export interface UploadedAsset {
  readonly ref: string;
  readonly url: string | null;
}

export async function uploadBrandingAsset(
  kind: BrandingAssetKind,
  file: File,
  fetcher: Fetcher = fetch,
): Promise<UploadedAsset> {
  const response = await fetcher(
    `${BRANDING_ASSET_API_PATH}/${kind}?fileName=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    },
  );
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Upload failed (HTTP ${response.status})`));
  }
  return (await response.json()) as UploadedAsset;
}

const pageStyle: CSSProperties = {
  padding: "28px 40px",
  maxWidth: "1800px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
};

const breadcrumbStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted)",
  marginBottom: "12px",
  fontFamily: "var(--font-mono, monospace)",
};

const headingStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  marginBottom: "20px",
  color: "var(--text)",
};

const layoutStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(320px, 1fr) minmax(280px, 1fr)",
  gap: "24px",
  alignItems: "start",
};

export default function BrandingPage(): ReactElement {
  const [draft, setDraft] = useState<BrandingConfig | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [fragments, setFragments] = useState<BrandingPreviewFragments | null>(null);
  const [reportKind, setReportKind] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await loadBranding();
        if (!active) return;
        setDraft(loaded);
        setLogoUrl(loaded.logoUrl ?? null);
        setCoverUrl(loaded.coverUrl ?? null);
      } catch (cause) {
        if (active) {
          setValidationError(cause instanceof Error ? cause.message : "Failed to load branding.");
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (draft === null) return;
    let active = true;
    setPreviewLoading(true);
    void (async () => {
      try {
        const next = await previewBranding(draft, reportKind);
        if (!active) return;
        setFragments(next);
        setPreviewError(null);
      } catch (cause) {
        if (active) setPreviewError(cause instanceof Error ? cause.message : "Preview failed.");
      } finally {
        if (active) setPreviewLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [draft, reportKind]);

  const handleUpload = useCallback(async (kind: BrandingAssetKind, file: File) => {
    setUploadError(null);
    try {
      const uploaded = await uploadBrandingAsset(kind, file);
      setDraft((current) =>
        current === null
          ? current
          : kind === "logo"
            ? { ...current, logoRef: uploaded.ref }
            : { ...current, coverRef: uploaded.ref },
      );
      if (kind === "logo") setLogoUrl(uploaded.url);
      else setCoverUrl(uploaded.url);
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : "Upload failed.");
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (draft === null) return;
    setSaving(true);
    setValidationError(null);
    setStatus(null);
    try {
      const saved = await saveBranding(draft);
      setDraft(saved);
      setLogoUrl(saved.logoUrl ?? logoUrl);
      setCoverUrl(saved.coverUrl ?? coverUrl);
      setStatus("Branding saved.");
    } catch (cause) {
      setValidationError(cause instanceof Error ? cause.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }, [draft, logoUrl, coverUrl]);

  return (
    <div style={pageStyle} data-testid="branding-page">
      <div style={breadcrumbStyle}>Application Settings &rarr; Branding</div>
      <h1 style={headingStyle}>Branding</h1>

      {loading || draft === null ? (
        <p data-testid="branding-loading" style={{ color: "var(--muted)" }}>
          Loading branding...
        </p>
      ) : (
        <div style={layoutStyle}>
          <BrandingForm
            value={draft}
            onChange={(next) => {
              setDraft(next);
              setStatus(null);
            }}
            onUpload={(kind, file) => void handleUpload(kind, file)}
            uploadError={uploadError}
            validationError={validationError}
            reportKind={reportKind}
            onReportKindChange={setReportKind}
            onSave={() => void handleSave()}
            saving={saving}
            status={status}
          />
          <BrandingPreview
            draft={draft}
            fragments={fragments}
            logoUrl={logoUrl}
            coverUrl={coverUrl}
            reportKind={reportKind}
            loading={previewLoading}
            error={previewError}
          />
        </div>
      )}
    </div>
  );
}
