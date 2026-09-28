// AppDeployment persistence (EPIC-017 SPEC §5, §4.1, §9, §11.2; T-0322).
//
// One record per queued app upload. Every read and write is scoped by tenantId, so
// a caller cannot reach another tenant's rows. State moves only along the queue's
// transitions; a failed upload may be re-queued (SPEC §9 "re-runnable queue items").
//
// The payload holds the package *id* on the artifact tier, never package bytes or
// credentials: the repository rejects oversized payloads and credential-like keys
// before anything reaches the database. The storage engine is kept behind this
// interface (ADR-0015): callers pass an opened connection, never SQL.
import { supportedAppTypes } from "../domain/intune-app-types.js";

type Row = Record<string, unknown>;

export type AppDeploymentState =
  | "queued"
  | "uploading"
  | "committing"
  | "succeeded"
  | "failed"
  | "cancelled";

export const APP_DEPLOYMENT_STATES: readonly AppDeploymentState[] = Object.freeze([
  "queued",
  "uploading",
  "committing",
  "succeeded",
  "failed",
  "cancelled",
]);

/** Allowed state moves. `failed → queued` is the re-run path. */
export const APP_DEPLOYMENT_TRANSITIONS: Readonly<Record<AppDeploymentState, readonly AppDeploymentState[]>> =
  Object.freeze({
    queued: ["uploading", "failed", "cancelled"],
    uploading: ["committing", "failed"],
    committing: ["succeeded", "failed"],
    succeeded: [],
    failed: ["queued"],
    cancelled: [],
  });

/** Upper bound on a stored payload or results document, in bytes of JSON. */
export const MAX_APP_DEPLOYMENT_JSON_BYTES = 64 * 1024;

const CREDENTIAL_KEY = /secret|password|passwd|token|credential|privatekey|certificate|apikey/i;

export interface AppDeployment {
  readonly id: string;
  readonly tenantId: string;
  readonly appType: string;
  readonly state: AppDeploymentState;
  readonly payload: Record<string, unknown>;
  readonly results: Record<string, unknown> | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AppDeploymentInput {
  readonly id: string;
  readonly tenantId: string;
  readonly appType: string;
  readonly payload: Record<string, unknown>;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface AppDeploymentListFilter {
  readonly state?: AppDeploymentState;
}

export interface AppDeploymentStatement {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

// Minimal structural view of a SQLite connection so this module names no engine
// package; the caller's better-sqlite3 Database satisfies it.
export interface AppDeploymentDatabase {
  prepare(sql: string): AppDeploymentStatement;
  close?(): void;
}

export interface AppDeploymentRepository {
  readonly schemaVersion: number;
  close(): void;
  createDeployment(input: AppDeploymentInput): Promise<AppDeployment>;
  getDeployment(tenantId: string, id: string): Promise<AppDeployment | undefined>;
  listDeployments(tenantId: string, filter?: AppDeploymentListFilter): Promise<AppDeployment[]>;
  /**
   * Moves a deployment to `state`, optionally recording worker results. Throws when
   * the move is not an allowed transition; returns undefined when the row is absent.
   */
  transitionDeployment(
    tenantId: string,
    id: string,
    state: AppDeploymentState,
    at: string,
    results?: Record<string, unknown> | null,
  ): Promise<AppDeployment | undefined>;
}

export class AppDeploymentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppDeploymentValidationError";
  }
}

function findCredentialKey(value: unknown, path: string): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findCredentialKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (CREDENTIAL_KEY.test(key)) return childPath;
      const hit = findCredentialKey(child, childPath);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Serialises a payload/results document, refusing credentials and blob-sized content. */
export function serializeAppDeploymentJson(label: string, value: Record<string, unknown>): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppDeploymentValidationError(`${label} must be a JSON object`);
  }
  const credentialPath = findCredentialKey(value, "");
  if (credentialPath) {
    throw new AppDeploymentValidationError(`${label} must not carry credentials (found '${credentialPath}')`);
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_APP_DEPLOYMENT_JSON_BYTES) {
    throw new AppDeploymentValidationError(
      `${label} exceeds ${MAX_APP_DEPLOYMENT_JSON_BYTES} bytes; package content belongs on the artifact tier`,
    );
  }
  return json;
}

function parseJson(value: unknown): Record<string, unknown> {
  return JSON.parse(String(value)) as Record<string, unknown>;
}

export class SqliteAppDeploymentRepository implements AppDeploymentRepository {
  readonly schemaVersion: number;

  constructor(
    private readonly db: AppDeploymentDatabase,
    schemaVersion: number,
  ) {
    this.schemaVersion = schemaVersion;
  }

  close(): void {
    this.db.close?.();
  }

  private map(row: Row): AppDeployment {
    return {
      id: String(row["id"]),
      tenantId: String(row["tenantId"]),
      appType: String(row["appType"]),
      state: String(row["state"]) as AppDeploymentState,
      payload: parseJson(row["payload"]),
      results: row["results"] === null || row["results"] === undefined ? null : parseJson(row["results"]),
      createdBy: String(row["createdBy"]),
      createdAt: String(row["createdAt"]),
      updatedAt: String(row["updatedAt"]),
    };
  }

  private select(tenantId: string, id: string): AppDeployment | undefined {
    const row = this.db
      .prepare("SELECT * FROM app_deployments WHERE tenantId = ? AND id = ?")
      .get(tenantId, id) as Row | undefined;
    return row ? this.map(row) : undefined;
  }

  async createDeployment(input: AppDeploymentInput): Promise<AppDeployment> {
    if (!supportedAppTypes().includes(input.appType as never)) {
      throw new AppDeploymentValidationError(`app type '${input.appType}' is not supported for deployment`);
    }
    const payload = serializeAppDeploymentJson("payload", input.payload);
    this.db
      .prepare(
        `INSERT INTO app_deployments
           (id, tenantId, appType, state, payload, results, createdBy, createdAt, updatedAt)
         VALUES (?, ?, ?, 'queued', ?, NULL, ?, ?, ?)`,
      )
      .run(input.id, input.tenantId, input.appType, payload, input.createdBy, input.createdAt, input.createdAt);
    const saved = this.select(input.tenantId, input.id);
    if (!saved) throw new Error(`app deployment ${input.id} was not persisted`);
    return saved;
  }

  async getDeployment(tenantId: string, id: string): Promise<AppDeployment | undefined> {
    return this.select(tenantId, id);
  }

  async listDeployments(tenantId: string, filter: AppDeploymentListFilter = {}): Promise<AppDeployment[]> {
    const rows = filter.state
      ? this.db
          .prepare(
            `SELECT * FROM app_deployments WHERE tenantId = ? AND state = ?
             ORDER BY createdAt DESC, rowid DESC`,
          )
          .all(tenantId, filter.state)
      : this.db
          .prepare("SELECT * FROM app_deployments WHERE tenantId = ? ORDER BY createdAt DESC, rowid DESC")
          .all(tenantId);
    return (rows as Row[]).map((row) => this.map(row));
  }

  async transitionDeployment(
    tenantId: string,
    id: string,
    state: AppDeploymentState,
    at: string,
    results?: Record<string, unknown> | null,
  ): Promise<AppDeployment | undefined> {
    const current = this.select(tenantId, id);
    if (!current) return undefined;
    if (!APP_DEPLOYMENT_TRANSITIONS[current.state].includes(state)) {
      throw new AppDeploymentValidationError(`cannot move app deployment from '${current.state}' to '${state}'`);
    }
    const resultsJson =
      results === undefined
        ? current.results === null
          ? null
          : JSON.stringify(current.results)
        : results === null
          ? null
          : serializeAppDeploymentJson("results", results);
    // The state guard in WHERE makes a concurrent transition lose rather than overwrite.
    const { changes } = this.db
      .prepare(
        `UPDATE app_deployments SET state = ?, results = ?, updatedAt = ?
         WHERE tenantId = ? AND id = ? AND state = ?`,
      )
      .run(state, resultsJson, at, tenantId, id, current.state);
    if (changes === 0) {
      throw new AppDeploymentValidationError(`app deployment ${id} changed state concurrently`);
    }
    return this.select(tenantId, id);
  }
}
