// Progress SSE stream route (EPIC-003 SPEC.md §4.2, §6, §11.2, T-0044).
// Streams ordered, versioned events until the run is terminal.
// Subscriptions are RBAC-checked, tenant-scoped, and audited.

import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { AppError, ErrorCodes } from "../errors.js";
import {
  requirePermission,
  requireTenantInScope,
  type Caller,
} from "../rbac/authorize.js";
import { RunPermissions } from "../rbac/roles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type { ProgressEvent } from "@m365-assess/contracts/events";
import type { RunStatus } from "../domain/runs/run-lifecycle.js";
import { ProgressEventHub, isTerminalRunState } from "../sse/hub.js";

export const RUNS_EVENTS_PATH = "/v1/runs/:runId/events";
export const RUNS_EVENTS_PERMISSION = RunPermissions.read;

export const RUNS_EVENTS_UNAUTHENTICATED = "request.unauthenticated";
export const RUN_NOT_FOUND = "run.not_found";
export const RUN_FORBIDDEN = "auth.forbidden";

export interface RunEventsRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly status: RunStatus;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
}

export interface RunAuditEventInput {
  readonly id: string;
  readonly timestamp: string;
  readonly actorUserId: string | null;
  readonly actorType: string;
  readonly tenantId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly result: string;
  readonly error: string | null;
  readonly source: string;
  readonly correlationId: string | null;
  readonly createdAt: string;
}

export interface RunEventsStore {
  getRunById(runId: string): Promise<RunEventsRecord | undefined>;
  appendAuditEvent?(event: RunAuditEventInput): Promise<unknown>;
}

export interface RunsEventsRouteOptions {
  readonly hub: ProgressEventHub;
  readonly store: RunEventsStore;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly now?: () => string;
}

export function formatSseEvent(event: ProgressEvent, eventName: string = "progress"): string {
  return `id: ${event.sequence}\nevent: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
}

export interface ParsedSseEvent {
  id?: string;
  event?: string;
  data: string;
}

export function parseSseStream(text: string): ParsedSseEvent[] {
  const blocks = text.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
  const results: ParsedSseEvent[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let id: string | undefined;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("id:")) {
        id = line.slice(3).trim();
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length > 0 || id !== undefined || event !== undefined) {
      results.push({
        id,
        event,
        data: dataLines.join("\n"),
      });
    }
  }
  return results;
}

export function createRunsEventsRoute(options: RunsEventsRouteOptions): Route {
  return {
    method: "GET",
    path: RUNS_EVENTS_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = options.resolveCaller(ctx);
      if (!caller) {
        throw new AppError(RUNS_EVENTS_UNAUTHENTICATED, "authentication required", 401);
      }

      if (options.authorize) {
        await options.authorize(caller, RUNS_EVENTS_PERMISSION);
      } else {
        requirePermission(caller, RUNS_EVENTS_PERMISSION);
      }

      const runId = ctx.params["runId"];
      if (!runId) {
        throw new AppError("run.invalid_id", "runId is required", 400);
      }

      const run = await options.store.getRunById(runId);
      if (!run) {
        throw new AppError(RUN_NOT_FOUND, `Run '${runId}' not found`, 404);
      }

      // Intersect with caller's RBAC tenant scope (403 if outside scope)
      requireTenantInScope(caller, run.tenantId);

      // Audit subscription to the stream
      if (options.store.appendAuditEvent) {
        const callerRecord = caller as unknown as Record<string, unknown>;
        const nowIso = options.now ? options.now() : new Date().toISOString();
        await options.store.appendAuditEvent({
          id: randomUUID(),
          timestamp: nowIso,
          actorUserId:
            typeof callerRecord["userId"] === "string"
              ? callerRecord["userId"]
              : typeof callerRecord["id"] === "string"
                ? callerRecord["id"]
                : null,
          actorType: "user",
          tenantId: run.tenantId,
          action: "runs.events.subscribe",
          targetType: "run",
          targetId: run.id,
          before: null,
          after: null,
          result: "success",
          error: null,
          source: "bff",
          correlationId: ctx.correlationId,
          createdAt: nowIso,
        });
      }

      // The server pipes this stream to the client and destroys it when the
      // connection closes, so events reach the client as the hub publishes them
      // and a disconnect ends the subscription.
      const stream = new Readable({ read() {} });
      const unsubscribe = options.hub.subscribe(runId, {
        onEvent: (event: ProgressEvent) => {
          stream.push(formatSseEvent(event));
        },
        onComplete: () => {
          stream.push(null);
        },
        onError: (err: unknown) => {
          stream.destroy(err instanceof Error ? err : new Error(String(err)));
        },
      });
      stream.on("close", unsubscribe);

      return {
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        headers: {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        stream,
      };
    },
  };
}

export const RUNS_EVENTS_OPENAPI = {
  "/v1/runs/{runId}/events": {
    get: {
      tags: ["Runs"],
      summary: "Stream progress events for a run via Server-Sent Events (SSE)",
      description:
        "Streams ordered, versioned progress events until the run reaches a terminal state (succeeded, failed, cancelled). Replays past events if subscribing mid-run.",
      operationId: "getRunEvents",
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "ID of the run to stream progress events for.",
        },
      ],
      responses: {
        "200": {
          description: "Server-Sent Events stream of progress events.",
          content: {
            "text/event-stream": {
              schema: {
                type: "string",
                description: "SSE formatted stream with event: progress",
              },
            },
          },
        },
        "401": { description: "Authentication required." },
        "403": { description: "Tenant is outside the caller scope." },
        "404": { description: "Run not found." },
      },
    },
  },
} as const;
