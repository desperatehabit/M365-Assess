import { randomUUID } from "node:crypto";
import {
  parseJobEnvelope,
  type JobEnvelope,
  type ResultEnvelope,
} from "@m365-assess/contracts";
import {
  PROGRESS_EVENT_SCHEMA_VERSION,
  type ProgressEvent,
} from "@m365-assess/contracts/events";
import { DEFAULT_WORKER_POOL_SIZE } from "../config.js";
import { JobCancelledError } from "./supervisor.js";

export type QueuedJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type PersistedJobState = "queued" | "running" | "done" | "failed";

export interface PersistedJobInput {
  readonly id: string;
  readonly type: string;
  readonly tenantId: string | null;
  readonly payload: Record<string, unknown>;
  readonly state: PersistedJobState;
  readonly attempts: number;
  readonly progress: Record<string, unknown> | null;
}

export interface PersistedJobStateUpdate {
  readonly progress?: Record<string, unknown> | null;
  readonly attempts?: number;
}

export interface PersistedJobRecord {
  readonly state: string;
  readonly progress: Record<string, unknown> | null;
}

// Minimal structural seam over the repository's job methods (T-0009). The
// real Repository satisfies this shape: createJob accepts this input,
// getJob returns state/progress, updateJobState takes this state/update.
// Depending on the seam instead of the engine keeps SQL out of the BFF.
export interface JobStatePersistence {
  createJob(input: PersistedJobInput): Promise<unknown>;
  getJob(jobId: string): Promise<PersistedJobRecord | undefined>;
  updateJobState(
    jobId: string,
    state: PersistedJobState,
    update?: PersistedJobStateUpdate,
  ): Promise<unknown>;
}

export type RunWorkerFn = (
  envelope: JobEnvelope,
  signal: AbortSignal,
) => Promise<ResultEnvelope>;

export interface JobQueueOptions {
  readonly persistence: JobStatePersistence;
  readonly runWorker: RunWorkerFn;
  readonly poolSize?: number;
  readonly onProgress?: (event: ProgressEvent) => void;
}

interface WaitingEntry {
  readonly envelope: JobEnvelope;
}

interface ActiveEntry {
  readonly envelope: JobEnvelope;
  readonly controller: AbortController;
}

const TERMINAL_COLUMN: Record<PersistedJobState, QueuedJobState | null> = {
  queued: "queued",
  running: "running",
  done: "succeeded",
  failed: "failed",
};

function isQueuedJobState(value: unknown): value is QueuedJobState {
  return (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
  );
}

// The jobs table only carries queued/running/done/failed, so the canonical
// five-state lifecycle rides in progress.queueState with the column as a
// compatible projection (succeeded->done, cancelled->failed).
export function toPersistedState(state: QueuedJobState): PersistedJobState {
  switch (state) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "done";
    case "failed":
    case "cancelled":
      return "failed";
  }
}

export function fromPersistedRecord(
  record: PersistedJobRecord | undefined,
): QueuedJobState | undefined {
  if (record === undefined) {
    return undefined;
  }
  const marker = record.progress?.["queueState"];
  if (isQueuedJobState(marker)) {
    return marker;
  }
  return TERMINAL_COLUMN[record.state as PersistedJobState] ?? undefined;
}

export function normalizePoolSize(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return DEFAULT_WORKER_POOL_SIZE;
  }
  return value;
}

function errorCodeOf(error: unknown): string {
  if (error instanceof JobCancelledError) {
    return error.code;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return "worker.failed";
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class JobQueue {
  private readonly persistence: JobStatePersistence;
  private readonly runWorker: RunWorkerFn;
  private readonly onProgress?: (event: ProgressEvent) => void;
  private readonly waiting: WaitingEntry[] = [];
  private readonly active = new Map<string, ActiveEntry>();
  private readonly poolSizeValue: number;
  private sequence = 0;
  private pumpScheduled = false;
  // Jobs dequeued but not yet terminally persisted. drain() waits on this
  // rather than active.size so the persist-then-start window is covered.
  private unfinished = 0;
  // Jobs cancelled after dequeue but before the worker started. startJob
  // honors this instead of clobbering the cancelled marker with running.
  private readonly preempted = new Set<string>();

  constructor(options: JobQueueOptions) {
    this.persistence = options.persistence;
    this.runWorker = options.runWorker;
    this.onProgress = options.onProgress;
    this.poolSizeValue = normalizePoolSize(options.poolSize);
  }

  get poolSize(): number {
    return this.poolSizeValue;
  }

  get depth(): number {
    return this.waiting.length;
  }

  get activeCount(): number {
    return this.active.size;
  }

  // Validates before persisting: a schema mismatch rejects without touching
  // the store or starting a worker.
  async enqueue(envelopeInput: unknown): Promise<string> {
    const envelope = parseJobEnvelope(envelopeInput);
    await this.persistence.createJob({
      id: envelope.jobId,
      type: envelope.jobType,
      tenantId: envelope.tenantId,
      payload: envelope.payload as unknown as Record<string, unknown>,
      state: "queued",
      attempts: 0,
      progress: { queueState: "queued", runId: envelope.runId },
    });
    this.waiting.push({ envelope });
    this.emitLifecycle(envelope, "queued");
    this.schedulePump();
    return envelope.jobId;
  }

  async getState(jobId: string): Promise<QueuedJobState | undefined> {
    if (this.active.has(jobId)) {
      return "running";
    }
    if (this.waiting.some((entry) => entry.envelope.jobId === jobId)) {
      return "queued";
    }
    return fromPersistedRecord(await this.persistence.getJob(jobId));
  }

  async cancel(jobId: string): Promise<boolean> {
    const index = this.waiting.findIndex(
      (entry) => entry.envelope.jobId === jobId,
    );
    if (index >= 0) {
      const [entry] = this.waiting.splice(index, 1);
      if (entry !== undefined) {
        await this.persistState(entry.envelope, "cancelled", {
          reason: "cancelled while queued",
        });
        this.emitLifecycle(entry.envelope, "cancelled");
      }
      return true;
    }
    const running = this.active.get(jobId);
    if (running !== undefined) {
      running.controller.abort();
      return true;
    }
    const state = fromPersistedRecord(await this.persistence.getJob(jobId));
    if (state === "queued") {
      const record = await this.persistence.getJob(jobId);
      if (record !== undefined) {
        await this.persistence.updateJobState(jobId, "failed", {
          progress: { ...(record.progress ?? {}), queueState: "cancelled" },
        });
      }
      this.preempted.add(jobId);
      return true;
    }
    return false;
  }

  // Test and shutdown hook: resolves once every enqueued job has reached
  // a persisted terminal state.
  async drain(): Promise<void> {
    while (this.waiting.length > 0 || this.unfinished > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private schedulePump(): void {
    if (this.pumpScheduled) {
      return;
    }
    this.pumpScheduled = true;
    void this.pumpLoop().finally(() => {
      this.pumpScheduled = false;
      if (this.waiting.length > 0 && this.active.size < this.poolSizeValue) {
        this.schedulePump();
      }
    });
  }

  private async pumpLoop(): Promise<void> {
    while (
      this.active.size < this.poolSizeValue &&
      this.waiting.length > 0
    ) {
      const next = this.waiting.shift();
      if (next === undefined) {
        return;
      }
      this.unfinished += 1;
      try {
        await this.startJob(next);
      } catch {
        this.unfinished -= 1;
      }
    }
  }

  private async startJob(entry: WaitingEntry): Promise<void> {
    const { envelope } = entry;
    await this.persistState(envelope, "running", { attempts: 1 });
    if (this.preempted.has(envelope.jobId)) {
      this.preempted.delete(envelope.jobId);
      await this.persistState(envelope, "cancelled", {
        reason: "cancelled while starting",
      });
      this.emitLifecycle(envelope, "cancelled");
      this.unfinished -= 1;
      return;
    }
    this.emitLifecycle(envelope, "running");
    // No await is allowed between registering active and invoking runWorker:
    // otherwise cancel() could abort before the worker observes the signal.
    const controller = new AbortController();
    this.active.set(envelope.jobId, { envelope, controller });

    const outcome = this.runWorker(envelope, controller.signal).then(
      async (result) => {
        const terminal =
          result.status === "succeeded"
            ? "succeeded"
            : result.status === "cancelled"
              ? "cancelled"
              : "failed";
        await this.persistState(envelope, terminal, {
          exitCode: result.exitCode,
          artifactRefs: result.artifactRefs,
        });
        this.emitLifecycle(envelope, terminal);
      },
      async (error: unknown) => {
        const terminal =
          error instanceof JobCancelledError ? "cancelled" : "failed";
        await this.persistState(envelope, terminal, {
          code: errorCodeOf(error),
          error: errorMessageOf(error),
        });
        this.emitLifecycle(envelope, terminal);
      },
    );

    void outcome
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(envelope.jobId);
        this.unfinished -= 1;
        this.schedulePump();
      });
  }

  private async persistState(
    envelope: JobEnvelope,
    state: QueuedJobState,
    detail?: Record<string, unknown> & { attempts?: number },
  ): Promise<void> {
    const { attempts, ...rest } = detail ?? {};
    const record = await this.persistence.getJob(envelope.jobId);
    const progress = {
      ...(record?.progress ?? {}),
      ...rest,
      queueState: state,
      runId: envelope.runId,
    };
    await this.persistence.updateJobState(
      envelope.jobId,
      toPersistedState(state),
      attempts === undefined
        ? { progress }
        : { progress, attempts },
    );
  }

  private emitLifecycle(envelope: JobEnvelope, state: QueuedJobState): void {
    if (this.onProgress === undefined) {
      return;
    }
    this.onProgress({
      schemaVersion: PROGRESS_EVENT_SCHEMA_VERSION,
      sequence: this.sequence++,
      eventId: randomUUID(),
      runId: envelope.runId,
      tenantId: envelope.tenantId,
      jobId: envelope.jobId,
      jobType: envelope.jobType,
      requestId: envelope.requestId,
      correlationId: envelope.correlationId,
      at: new Date().toISOString(),
      state,
      message: `job ${state}`,
    });
  }
}
