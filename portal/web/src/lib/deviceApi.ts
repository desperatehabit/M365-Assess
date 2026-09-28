// deviceApi.ts — Client API helpers for managed devices (EPIC-018 SPEC.md §3.1, §6; T-0348).

export interface DeviceItem {
  readonly id: string;
  readonly deviceName: string;
  readonly name: string;
  readonly ownerUpn: string;
  readonly platform: string;
  readonly compliance: string;
  readonly ownership: string;
  readonly lastCheckIn: string;
  readonly enrolled: string;
  readonly serial: string;
  readonly encrypted: boolean;
  readonly osVersion: string;
}

export interface DevicesPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly DeviceItem[];
  readonly nextCursor: string | null;
}

export interface DevicesFilter {
  readonly platform?: string;
  readonly compliance?: string;
  readonly ownership?: string;
  readonly lastCheckIn?: "7d" | "30d" | "90d";
  readonly encrypted?: boolean;
  readonly search?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export class DeviceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DeviceApiError";
  }
}

async function throwApiError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
  throw new DeviceApiError(body.message || `${fallback}: HTTP ${res.status}`, res.status, body.code);
}

export async function fetchDevices(
  tenantId: string,
  filter?: DevicesFilter,
  baseUrl = "",
): Promise<DevicesPage> {
  const params = new URLSearchParams();
  if (filter?.platform) params.set("platform", filter.platform);
  if (filter?.compliance) params.set("compliance", filter.compliance);
  if (filter?.ownership) params.set("ownership", filter.ownership);
  if (filter?.lastCheckIn) params.set("lastCheckIn", filter.lastCheckIn);
  if (filter?.encrypted !== undefined) params.set("encrypted", String(filter.encrypted));
  if (filter?.search) params.set("search", filter.search);
  if (filter?.cursor) params.set("cursor", filter.cursor);
  if (filter?.limit !== undefined) params.set("limit", String(filter.limit));

  const query = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(
    `${baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/devices${query}`,
  );
  if (!res.ok) await throwApiError(res, "Failed to list devices");
  return res.json() as Promise<DevicesPage>;
}

export interface DeviceOverview {
  readonly deviceName: string;
  readonly ownerUpn: string;
  readonly platform: string;
  readonly osVersion: string;
  readonly compliance: string;
  readonly ownership: string;
  readonly lastCheckIn: string;
  readonly enrolled: string;
  readonly serial: string;
  readonly encrypted: boolean;
  readonly deviceType: string;
  readonly managementState: string;
}

export interface DeviceHardware {
  readonly model: string;
  readonly manufacturer: string;
  readonly serialNumber: string;
  readonly storageSpace: number;
  readonly totalStorage: number;
  readonly phoneNumber: string;
  readonly imei: string;
}

export interface DeviceSoftware {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly publisher: string;
}

export interface DevicePolicy {
  readonly id: string;
  readonly displayName: string;
  readonly state: string;
  readonly lastReported: string;
  readonly type: string;
}

export interface DeviceEncryption {
  readonly encrypted: boolean;
  readonly keyType: string;
}

export interface DeviceDetail {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly overview: DeviceOverview;
  readonly hardware: DeviceHardware;
  readonly software: readonly DeviceSoftware[];
  readonly policies: readonly DevicePolicy[];
  readonly encryption: DeviceEncryption;
  readonly retrievedAt: string;
}

export interface DeviceAction {
  readonly id: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly action: string;
  readonly reason: string | null;
  readonly state: string;
  readonly appliedAt: string;
  readonly appliedBy: string;
  readonly result: string;
}

export async function fetchDeviceDetail(
  tenantId: string,
  deviceId: string,
  baseUrl = "",
): Promise<DeviceDetail> {
  const res = await fetch(
    `${baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/devices/${encodeURIComponent(deviceId)}`,
  );
  if (!res.ok) await throwApiError(res, "Failed to get device detail");
  return res.json() as Promise<DeviceDetail>;
}

export async function fetchDeviceActions(
  tenantId: string,
  deviceId: string,
  baseUrl = "",
): Promise<readonly DeviceAction[]> {
  const res = await fetch(
    `${baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/devices/${encodeURIComponent(deviceId)}/actions`,
  );
  if (!res.ok) await throwApiError(res, "Failed to get device actions");
  const body = (await res.json()) as { actions: DeviceAction[] };
  return body.actions ?? [];
}
