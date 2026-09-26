// SSE event hub for assessment runs (EPIC-003 SPEC.md §4.2, §11.2, T-0044).
// Fans structured progress events to subscribers, manages monotonic sequence per run,
// updates Run and RunSection state via the repository, and closes streams on terminal state.
// Events strictly adhere to the T-0014 progress event contract and sanitize any secrets or PII.

import { randomUUID } from "node:crypto";
import {
  PROGRESS_EVENT_SCHEMA_VERSION,
  parseProgressEvent,
  type ProgressEvent,
  type ProgressEventSchemaVersion,
  type RunState,
  type SectionState,
  RUN_STATES,
} from "@m365-assess/contracts/events";
import type { JobType } from "@m365-assess/contracts";
import type { RunStatus } from "../domain/runs/run-lifecycle.js";

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "succeeded",
  "failed",
  "cancelled",
]);

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

export interface RunProgressRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly status: RunStatus;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
}

export interface RunSectionInput {
  readonly id: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly section: string;
  readonly collector?: string | null;
  readonly status: string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface RunProgressStore {
  getRunById?(runId: string): Promise<RunProgressRecord | undefined>;
  updateRun?(
    tenantId: string,
    runId: string,
    update: {
      status?: RunStatus;
      startedAt?: string | null;
      finishedAt?: string | null;
      updatedAt?: string;
    },
  ): Promise<unknown>;
  createRunSection?(input: RunSectionInput): Promise<unknown>;
  updateRunSection?(
    tenantId: string,
    runId: string,
    section: string,
    update: {
      status?: string;
      startedAt?: string | null;
      finishedAt?: string | null;
      updatedAt?: string;
    },
  ): Promise<unknown>;
  recordRunSection?(input: RunSectionInput): Promise<unknown>;
}

export type HubEventListener = (event: ProgressEvent) => void;

export interface HubSubscriberOptions {
  readonly onEvent: HubEventListener;
  readonly onComplete?: () => void;
  readonly onError?: (err: unknown) => void;
  readonly replayHistory?: boolean;
}

export interface ProgressEventInput {
  readonly schemaVersion?: ProgressEventSchemaVersion;
  readonly sequence?: number;
  readonly eventId?: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly jobType?: JobType;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly at?: string;
  readonly state: RunState;
  readonly section?: string;
  readonly sectionState?: SectionState;
  readonly completed?: number;
  readonly total?: number;
  readonly message?: string;
}

export interface ProgressEventHubOptions {
  readonly store?: RunProgressStore;
  readonly now?: () => string;
}

// Secret and PII patterns to sanitize from event messages
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const BEARER_PATTERN = /bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const CLIENT_SECRET_PATTERN = /(?:client_secret|clientsecret|password|secret)\s*[:=]\s*[^\s,]+/gi;

export function sanitizeMessage(message?: string): string | undefined {
  if (!message) return message;
  return message
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(BEARER_PATTERN, "Bearer [redacted-token]")
    .replace(CLIENT_SECRET_PATTERN, "$1=[redacted-secret]");
}

export function sanitizeEventPayload(input: Record<string, unknown>): Record<string, unknown> {
  const allowedKeys = new Set([
    "schemaVersion",
    "sequence",
    "eventId",
    "runId",
    "tenantId",
    "jobId",
    "jobType",
    "requestId",
    "correlationId",
    "at",
    "state",
    "section",
    "sectionState",
    "completed",
    "total",
    "message",
  ]);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (allowedKeys.has(key)) {
      if (key === "message" && typeof value === "string") {
        sanitized[key] = sanitizeMessage(value);
      } else {
        sanitized[key] = value;
      }
    }
  }
  return sanitized;
}

export class ProgressEventHub {
  private readonly store?: RunProgressStore;
  private readonly now: () => string;
  private readonly sequences = new Map<string, number>();
  private readonly runStates = new Map<string, RunState>();
  private readonly history = new Map<string, ProgressEvent[]>();
  private readonly subscribers = new Map<string, Set<HubSubscriberOptions>>();
  private readonly terminalRuns = new Set<string>();

  constructor(options: ProgressEventHubOptions = {}) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  getEvents(runId: string): readonly ProgressEvent[] {
    return this.history.get(runId) ?? [];
  }

  isTerminal(runId: string): boolean {
    return this.terminalRuns.has(runId);
  }

  async publish(rawInput: ProgressEventInput | ProgressEvent | Record<string, unknown>): Promise<ProgressEvent> {
    const rawRecord = rawInput as Record<string, unknown>;
    const runId = String(rawRecord["runId"] ?? "");
    const tenantId = String(rawRecord["tenantId"] ?? "");

    // Monotonic sequence per run
    const currentSeq = this.sequences.get(runId) ?? 0;
    this.sequences.set(runId, currentSeq + 1);

    const nowIso = this.now();
    const eventCandidate: Record<string, unknown> = {
      schemaVersion: rawRecord["schemaVersion"] ?? PROGRESS_EVENT_SCHEMA_VERSION,
      sequence: currentSeq,
      eventId: rawRecord["eventId"] ?? randomUUID(),
      runId,
      tenantId,
      jobId: rawRecord["jobId"] ?? randomUUID(),
      jobType: rawRecord["jobType"] ?? "assessment",
      requestId: rawRecord["requestId"] ?? randomUUID(),
      correlationId: rawRecord["correlationId"] ?? randomUUID(),
      at: rawRecord["at"] ?? nowIso,
      state: rawRecord["state"] ?? "running",
    };

    if (rawRecord["section"] !== undefined) eventCandidate["section"] = rawRecord["section"];
    if (rawRecord["sectionState"] !== undefined) eventCandidate["sectionState"] = rawRecord["sectionState"];
    if (rawRecord["completed"] !== undefined) eventCandidate["completed"] = rawRecord["completed"];
    if (rawRecord["total"] !== undefined) eventCandidate["total"] = rawRecord["total"];
    if (rawRecord["message"] !== undefined) eventCandidate["message"] = rawRecord["message"];

    const sanitized = sanitizeEventPayload(eventCandidate);
    const event = parseProgressEvent(sanitized);

    // Save event in history
    let events = this.history.get(runId);
    if (!events) {
      events = [];
      this.history.set(runId, events);
    }
    events.push(event);

    // Update store state if store provided
    await this.updateStore(event);

    const terminal = isTerminalRunState(event.state);
    if (terminal) {
      this.terminalRuns.add(runId);
    }

    // Fan-out to subscribers
    const activeSubscribers = this.subscribers.get(runId);
    if (activeSubscribers && activeSubscribers.size > 0) {
      const subs = Array.from(activeSubscribers);
      for (const sub of subs) {
        try {
          sub.onEvent(event);
          if (terminal) {
            sub.onComplete?.();
          }
        } catch (err) {
          sub.onError?.(err);
        }
      }
      if (terminal) {
        this.subscribers.delete(runId);
      }
    }

    return event;
  }

  subscribe(
    runId: string,
    subscriberOrFn: HubEventListener | HubSubscriberOptions,
  ): () => void {
    const subscriber: HubSubscriberOptions =
      typeof subscriberOrFn === "function"
        ? { onEvent: subscriberOrFn }
        : subscriberOrFn;

    const replay = subscriber.replayHistory !== false;
    const historyEvents = this.history.get(runId) ?? [];

    if (replay) {
      for (const pastEvent of historyEvents) {
        try {
          subscriber.onEvent(pastEvent);
        } catch (err) {
          subscriber.onError?.(err);
        }
      }
    }

    // If run is already terminal, complete immediately and return no-op
    if (this.terminalRuns.has(runId)) {
      try {
        subscriber.onComplete?.();
      } catch (err) {
        subscriber.onError?.(err);
      }
      return () => {};
    }

    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(subscriber);

    return () => {
      const currentSet = this.subscribers.get(runId);
      if (currentSet) {
        currentSet.delete(subscriber);
        if (currentSet.size === 0) {
          this.subscribers.delete(runId);
        }
      }
    };
  }

  async *stream(runId: string, signal?: AbortSignal): AsyncIterable<ProgressEvent> {
    type StreamQueueItem =
      | { type: "event"; event: ProgressEvent }
      | { type: "complete" }
      | { type: "error"; err: unknown };

    const queue: StreamQueueItem[] = [];
    let notify: (() => void) | null = null;
    let done = false;

    const push = (item: StreamQueueItem) => {
      queue.push(item);
      if (notify) {
        const fn = notify;
        notify = null;
        fn();
      }
    };

    const unsubscribe = this.subscribe(runId, {
      onEvent: (event) => push({ type: "event", event }),
      onComplete: () => push({ type: "complete" }),
      onError: (err) => push({ type: "error", err }),
    });

    const onAbort = () => {
      done = true;
      unsubscribe();
      push({ type: "complete" });
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      while (!done) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
        while (queue.length > 0) {
          const item = queue.shift()!;
          if (item.type === "event") {
            yield item.event;
          } else if (item.type === "error") {
            throw item.err;
          } else if (item.type === "complete") {
            done = true;
            break;
          }
        }
      }
    } finally {
      unsubscribe();
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  private async updateStore(event: ProgressEvent): Promise<void> {
    if (!this.store) return;

    try {
      const previousState = this.runStates.get(event.runId);
      const stateChanged = previousState !== event.state;
      this.runStates.set(event.runId, event.state);

      if (this.store.updateRun && stateChanged) {
        const update: {
          status?: RunStatus;
          startedAt?: string | null;
          finishedAt?: string | null;
          updatedAt?: string;
        } = { updatedAt: event.at };

        if (event.state === "running") {
          update.status = "running";
          update.startedAt = event.at;
        } else if (isTerminalRunState(event.state)) {
          update.status = event.state as RunStatus;
          update.finishedAt = event.at;
        }

        await this.store.updateRun(event.tenantId, event.runId, update);
      }

      if (event.section) {
        const sectionStatus = event.sectionState ?? (event.state === "running" ? "running" : "pending");
        const startedAt = event.sectionState === "running" ? event.at : null;
        const finishedAt = ["succeeded", "failed", "cancelled", "skipped"].includes(sectionStatus)
          ? event.at
          : null;

        if (this.store.recordRunSection) {
          await this.store.recordRunSection({
            id: randomUUID(),
            runId: event.runId,
            tenantId: event.tenantId,
            section: event.section,
            status: sectionStatus,
            startedAt,
            finishedAt,
            createdAt: event.at,
            updatedAt: event.at,
          });
        } else if (this.store.updateRunSection) {
          await this.store.updateRunSection(event.tenantId, event.runId, event.section, {
            status: sectionStatus,
            startedAt,
            finishedAt,
            updatedAt: event.at,
          });
        } else if (this.store.createRunSection) {
          await this.store.createRunSection({
            id: randomUUID(),
            runId: event.runId,
            tenantId: event.tenantId,
            section: event.section,
            collector: null,
            status: sectionStatus,
            startedAt,
            finishedAt,
            createdAt: event.at,
            updatedAt: event.at,
          });
        }
      }
    } catch {
      // Store update failures shouldn't crash the event stream fan-out
    }
  }
}
