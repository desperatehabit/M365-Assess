// EPIC-027 Sharing & Permissions worker-backed providers (T-0857).
//
// The route factories were written against provider seams but never mounted, and
// no adapter bound them to the PowerShell workers. This module does that:
//
//   sharingReport     get-sharing-report.ps1     (flat job: link/permission/site/date filters)
//   permissionsReport get-permissions-report.ps1 (flat job: role/principalType/top/cursor)
//   externalUsers     get-external-users.ps1     (T-0007 envelope: search / externalUserId)
//   linkRemoval       remove-sharing-links.ps1   (flat job: links/mode/confirmCount)
//
// Every call signs in through the tenant credential block (createTenantWorker) so
// the BFF never calls Graph itself. Link-removal jobs persist through the shared
// repository (migration 0035); sharing reports stay live in Graph.
import { randomUUID } from "node:crypto";
import type { CredentialStoreRow } from "../routes/credentials.js";
import type {
  ExternalUserAccessPage,
  ExternalUsersFilter,
  ExternalUsersPage,
  ExternalUsersProvider,
} from "../routes/sharing-external-users.js";
import type {
  SharingLinkRemovalProvider,
  SharingLinkRef,
} from "../routes/sharing-links-remove.js";
import type {
  SharingPermissionsFilter,
  SharingPermissionsPage,
  SharingPermissionsProvider,
} from "../routes/sharing-permissions.js";
import type {
  SharingReportFilter,
  SharingReportPage,
  SharingReportProvider,
} from "../routes/sharing-report.js";
import {
  asArray,
  createTenantWorker,
  raiseWorkerError,
  type WorkerRunner,
} from "./workers.js";

export interface SharingProviders {
  readonly sharingReport: SharingReportProvider;
  readonly permissionsReport: SharingPermissionsProvider;
  readonly externalUsers: ExternalUsersProvider;
  readonly linkRemoval: SharingLinkRemovalProvider;
}

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cursorOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function createSharingProviders(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
): SharingProviders {
  const call = createTenantWorker(run, credentials);
  const envelope = <T>(entrypoint: string, tenantId: string, payload: Row): Promise<T> =>
    call<T>(entrypoint, tenantId, {
      schemaVersion: "v1",
      correlationId: randomUUID(),
      payload,
    });

  const sharingReport: SharingReportProvider = {
    async listLinks(tenantId: string, filter: SharingReportFilter): Promise<SharingReportPage> {
      const result = await call<unknown>("get-sharing-report.ps1", tenantId, {
        linkType: filter.linkType ?? "",
        permissions: filter.permissions ?? "",
        site: filter.site ?? "",
        createdAfter: filter.createdAfter ?? "",
        anonymousOnly: filter.anonymousOnly,
        top: filter.limit,
        cursor: filter.cursor ?? "",
      });
      raiseWorkerError(result);
      const record = asRecord(result);
      const items = asArray(record["items"]) as SharingReportPage["items"];
      return {
        tenantId: asString(record["tenantId"], tenantId),
        totalCount: asNumber(record["totalCount"], items.length),
        items,
        nextCursor: cursorOrNull(record["nextCursor"]),
      };
    },
  };

  const permissionsReport: SharingPermissionsProvider = {
    async listPermissions(
      tenantId: string,
      filter: SharingPermissionsFilter,
    ): Promise<SharingPermissionsPage> {
      const result = await call<unknown>("get-permissions-report.ps1", tenantId, {
        role: filter.role ?? "",
        principalType: filter.principalType ?? "",
        top: filter.limit,
        cursor: filter.cursor ?? "",
      });
      raiseWorkerError(result);
      const record = asRecord(result);
      const items = asArray(record["items"]) as SharingPermissionsPage["items"];
      return {
        tenantId: asString(record["tenantId"], tenantId),
        totalCount: asNumber(record["totalCount"], items.length),
        items,
        nextCursor: cursorOrNull(record["nextCursor"]),
      };
    },
  };

  const externalUsers: ExternalUsersProvider = {
    async listExternalUsers(tenantId: string, filter: ExternalUsersFilter): Promise<ExternalUsersPage> {
      const result = await envelope<unknown>("get-external-users.ps1", tenantId, {
        search: filter.search ?? "",
        top: filter.limit,
        cursor: filter.cursor ?? "",
      });
      raiseWorkerError(result);
      const record = asRecord(result);
      const items = asArray(record["items"]) as ExternalUsersPage["items"];
      return {
        tenantId: asString(record["tenantId"], tenantId),
        totalCount: asNumber(record["totalCount"], items.length),
        items,
        nextCursor: cursorOrNull(record["nextCursor"]),
      };
    },

    async listExternalUserAccess(
      tenantId: string,
      externalUserId: string,
      pagination: { readonly cursor: string | null; readonly limit: number },
    ): Promise<ExternalUserAccessPage> {
      const result = await envelope<unknown>("get-external-users.ps1", tenantId, {
        externalUserId,
        top: pagination.limit,
        cursor: pagination.cursor ?? "",
      });
      raiseWorkerError(result);
      const record = asRecord(result);
      const items = asArray(record["items"]) as ExternalUserAccessPage["items"];
      return {
        tenantId: asString(record["tenantId"], tenantId),
        externalUserId: asString(record["externalUserId"], externalUserId),
        totalCount: asNumber(record["totalCount"], items.length),
        items,
        nextCursor: cursorOrNull(record["nextCursor"]),
      };
    },
  };

  const linkRemoval: SharingLinkRemovalProvider = {
    async removeLink(
      tenantId: string,
      link: SharingLinkRef,
    ): Promise<{ status: "removed" | "failed"; before: unknown; after: unknown; error?: string | null }> {
      const result = await call<unknown>("remove-sharing-links.ps1", tenantId, {
        links: [link],
        mode: "Apply",
        confirmCount: 1,
        correlationId: randomUUID(),
      });
      raiseWorkerError(result);
      const record = asRecord(result);
      const first = asArray(record["results"])[0];
      const row = asRecord(first);
      const state = asString(row["state"], "failed");
      return {
        status: state === "removed" ? "removed" : "failed",
        before: row["before"] ?? null,
        after: row["after"] ?? null,
        ...(typeof row["error"] === "string" ? { error: row["error"] } : {}),
      };
    },
  };

  return { sharingReport, permissionsReport, externalUsers, linkRemoval };
}
