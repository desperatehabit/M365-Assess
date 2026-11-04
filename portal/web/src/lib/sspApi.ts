// Typed client for the CMMC Level 2 SSP questionnaire routes (bff/src/routes/ssp.ts).
// A `fetcher` seam keeps it testable without a live BFF.
import type {
  SspDocumentView,
  SspPracticeResponse,
  SspPracticeResponseInput,
  SspSystemProfile,
  SspSystemProfileInput,
} from "@m365-assess/contracts/ssp";

export type Fetcher = typeof fetch;

function base(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/ssp`;
}

async function expectOk(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string; error?: { message?: string } };
      detail = body?.error?.message ?? body?.message ?? detail;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`${what} failed: ${response.status} ${detail}`);
  }
  return response.status === 204 ? null : response.json();
}

export async function getSsp(tenantId: string, fetcher: Fetcher = fetch): Promise<SspDocumentView> {
  return (await expectOk(await fetcher(base(tenantId)), "Load SSP")) as SspDocumentView;
}

export async function saveSspProfile(
  tenantId: string,
  profile: SspSystemProfileInput,
  fetcher: Fetcher = fetch,
): Promise<SspSystemProfile> {
  const response = await fetcher(`${base(tenantId)}/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  return ((await expectOk(response, "Save system profile")) as { profile: SspSystemProfile }).profile;
}

export async function saveSspPractice(
  tenantId: string,
  practiceId: string,
  answer: SspPracticeResponseInput,
  fetcher: Fetcher = fetch,
): Promise<SspPracticeResponse> {
  const response = await fetcher(`${base(tenantId)}/practices/${encodeURIComponent(practiceId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(answer),
  });
  return ((await expectOk(response, `Save practice ${practiceId}`)) as { response: SspPracticeResponse }).response;
}

export async function clearSspPractice(tenantId: string, practiceId: string, fetcher: Fetcher = fetch): Promise<void> {
  const response = await fetcher(`${base(tenantId)}/practices/${encodeURIComponent(practiceId)}`, { method: "DELETE" });
  await expectOk(response, `Clear practice ${practiceId}`);
}

export function sspDocumentHref(tenantId: string, format: "docx" | "html"): string {
  return `${base(tenantId)}/document?format=${format}`;
}
