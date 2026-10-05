import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  CONTACTS_READ_PERMISSION,
  RESOURCES_PATH,
  RESOURCES_READ_PERMISSION,
  createResourcesRoutes,
  parseResourcesFilter,
  type ResourceItem,
  type ResourcesCaller,
  type ResourcesFilter,
  type ResourcesPage,
  type ResourcesProvider,
} from "./resources.js";

const TENANT = "tenant-test";

const ROOM: ResourceItem = {
  id: "room-1",
  name: "Board Room",
  primarySmtpAddress: "board.room@example.com",
  capacity: 12,
  location: "Building A",
  type: "room",
  hidden: false,
  members: [],
};

const EQUIPMENT: ResourceItem = {
  id: "equip-1",
  name: "Projector Cart",
  primarySmtpAddress: "projector.cart@example.com",
  capacity: null,
  location: null,
  type: "equipment",
  hidden: true,
  members: [],
};

const ROOM_LIST: ResourceItem = {
  id: "rl-1",
  name: "Building A Rooms",
  primarySmtpAddress: "building.a.rooms@example.com",
  capacity: null,
  location: null,
  type: "roomlist",
  hidden: false,
  members: [
    { name: "Board Room", primarySmtpAddress: "board.room@example.com" },
    { name: "Focus Room", primarySmtpAddress: "focus.room@example.com" },
  ],
};

class FakeResourcesProvider implements ResourcesProvider {
  readonly calls: Array<{ tenantId: string; kind: string; filter: ResourcesFilter }> = [];

  constructor(private readonly items: readonly ResourceItem[] = [ROOM, EQUIPMENT, ROOM_LIST]) {}

  async listResources(tenantId: string, kind: string, filter: ResourcesFilter): Promise<ResourcesPage> {
    this.calls.push({ tenantId, kind, filter });
    return {
      tenantId,
      kind: kind as ResourcesPage["kind"],
      totalCount: this.items.length,
      items: this.items,
      nextCursor: null,
    };
  }
}

function makeCtx(tenantId: string, kind: string, query = ""): RequestContext {
  return {
    correlationId: "corr-test",
    method: "GET",
    path: `/v1/tenants/${tenantId}/resources/${kind}`,
    params: { tenantId, kind },
    query: new URLSearchParams(query),
    headers: {},
  };
}

describe("Resource routes (T-0448)", () => {
  it("exposes GET /v1/tenants/:tenantId/resources/:kind", () => {
    const routes = createResourcesRoutes({
      provider: new FakeResourcesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [RESOURCES_READ_PERMISSION],
      }),
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([`GET ${RESOURCES_PATH}`]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createResourcesRoutes({
      provider: new FakeResourcesProvider(),
      resolveCaller: () => undefined,
    });

    await expect(routes[0]!.handler(makeCtx(TENANT, "rooms"))).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createResourcesRoutes({
      provider: new FakeResourcesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [RESOURCES_READ_PERMISSION],
      }),
    });

    await expect(routes[0]!.handler(makeCtx(TENANT, "rooms"))).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Exchange.Resource.Read and Exchange.Contact.Read with 403", async () => {
    const routes = createResourcesRoutes({
      provider: new FakeResourcesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(routes[0]!.handler(makeCtx(TENANT, "rooms"))).rejects.toMatchObject({ status: 403 });
  });

  it("accepts Exchange.Contact.Read as an alternate read permission", async () => {
    const provider = new FakeResourcesProvider();
    const routes = createResourcesRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [CONTACTS_READ_PERMISSION],
      }),
    });

    const response = await routes[0]!.handler(makeCtx(TENANT, "rooms"));

    expect(response.status).toBe(200);
    expect(provider.calls).toHaveLength(1);
  });

  it("returns a structured 400 for an unknown kind", async () => {
    const routes = createResourcesRoutes({
      provider: new FakeResourcesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [RESOURCES_READ_PERMISSION],
      }),
    });

    const error: AppError = await routes[0]!
      .handler(makeCtx(TENANT, "mailboxes"))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(400);
    expect(error.code).toBe("resources.kind_unknown");
    expect(error.details).toEqual([{ field: "kind", reason: "unknown" }]);
  });

  it("returns the §3.3 columns for rooms, equipment, and room lists", async () => {
    const provider = new FakeResourcesProvider();
    const caller: ResourcesCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [RESOURCES_READ_PERMISSION],
    };
    const routes = createResourcesRoutes({ provider, resolveCaller: () => caller });

    for (const kind of ["rooms", "equipment", "roomlists"] as const) {
      const response = await routes[0]!.handler(makeCtx(TENANT, kind));

      expect(response.status).toBe(200);
      const body = response.body as ResourcesPage;
      expect(body.tenantId).toBe(TENANT);
      expect(body.kind).toBe(kind);
      expect(body.totalCount).toBe(3);
      expect(body.nextCursor).toBeNull();
    }

    expect(provider.calls.map((call) => call.kind)).toEqual(["rooms", "equipment", "roomlists"]);
  });

  it("carries room-list membership through to the response", async () => {
    const routes = createResourcesRoutes({
      provider: new FakeResourcesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [RESOURCES_READ_PERMISSION],
      }),
    });

    const response = await routes[0]!.handler(makeCtx(TENANT, "roomlists"));
    const body = response.body as ResourcesPage;
    const roomList = body.items.find((item) => item.type === "roomlist");

    expect(roomList?.members).toHaveLength(2);
    expect(roomList?.members[0]).toMatchObject({
      name: "Board Room",
      primarySmtpAddress: "board.room@example.com",
    });
  });

  it("passes the search filter and pagination through to the provider", async () => {
    const provider = new FakeResourcesProvider();
    const routes = createResourcesRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [RESOURCES_READ_PERMISSION],
      }),
    });

    const response = await routes[0]!.handler(makeCtx(TENANT, "rooms", "search=board&limit=25"));

    expect(response.status).toBe(200);
    expect(provider.calls[0]?.filter.search).toBe("board");
    expect(provider.calls[0]?.filter.limit).toBe(25);
    expect(provider.calls[0]?.filter.cursor).toBeNull();
  });

  it("validates the search filter parameters", () => {
    expect(() => parseResourcesFilter(new URLSearchParams("search=board"))).not.toThrow();
    expect(parseResourcesFilter(new URLSearchParams("limit=500")).limit).toBe(500);
  });
});
