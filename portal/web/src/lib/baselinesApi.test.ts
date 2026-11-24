// T-0879 — baseline stage advance client.
import { describe, expect, it } from "vitest";
import { advanceBaselineStage } from "./baselinesApi";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

describe("advanceBaselineStage (T-0879)", () => {
  it("posts the tenant to the stage-advance endpoint and returns the rollout", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return jsonResponse({
        rollout: {
          baselineId: "bl-1",
          tenantId: "tenant-a",
          stage: 1,
          state: "active",
          lastRunAt: "2026-11-07T00:00:00.000Z",
        },
      });
    }) as unknown as typeof fetch;

    const rollout = await advanceBaselineStage("bl-1", 0, "tenant-a", fetcher);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/v1/baselines/bl-1/stages/0/advance");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ tenantId: "tenant-a" });
    expect(rollout).toMatchObject({ baselineId: "bl-1", stage: 1, state: "active" });
  });

  it("surfaces a not-eligible response as an error", async () => {
    const fetcher = (async (): Promise<Response> =>
      jsonResponse({ message: "tenant is not eligible to advance" }, 409)) as unknown as typeof fetch;

    await expect(advanceBaselineStage("bl-1", 0, "tenant-a", fetcher)).rejects.toThrow(
      /not eligible/,
    );
  });
});
