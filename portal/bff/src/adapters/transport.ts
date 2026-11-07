// EPIC-021 Transport & Connectors worker-backed providers (T-0851).
//
// The route factories were written against provider seams but never mounted, and
// no adapter bound them to the PowerShell workers. This module does that:
//
//   rules        get-transport-rules.ps1  (list)
//   rulesWrite   set-transport-rule.ps1   (create/edit/delete; preview = dry run)
//   connectors   get-connectors.ps1       (list)
//                set-connector.ps1        (create/edit/enable/disable/delete)
//   deploy       deploy-transport-template.ps1 (one target per call)
//
// Reads and writes run in the tenant child process with its credential block, so
// the BFF never calls Exchange Online itself. Template stores live in SQLite; this
// adapter only supplies the worker seams.
import type { CredentialStoreRow } from "../routes/credentials.js";
import type {
  CreateTransportRuleInput,
  EditTransportRuleInput,
  TransportRulePlan,
  TransportRuleResult,
  TransportRulesFilter,
  TransportRulesPage,
  TransportRulesProvider,
  TransportRulesWriteProvider,
} from "../routes/transport-rules.js";
import type {
  ConnectorsFilter,
  ConnectorsPage,
  ConnectorsProvider,
  ConnectorPlan,
  ConnectorResult,
  CreateConnectorInput,
  EditConnectorInput,
} from "../routes/connectors.js";
import type {
  TransportTemplateApplyOutcome,
  TransportTemplateApplyRequest,
  TransportTemplateDeployExecutor,
} from "../domain/transport/template-deploy.js";
import { AppError } from "../errors.js";
import {
  asArray,
  createTenantWorker,
  raiseWorkerError,
  type WorkerRunner,
} from "./workers.js";

export interface TransportProviders {
  readonly rules: TransportRulesProvider;
  readonly rulesWrite: TransportRulesWriteProvider;
  readonly connectors: ConnectorsProvider;
  readonly deploy: TransportTemplateDeployExecutor;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function fieldJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value);
}

function ruleWriteFields(input: CreateTransportRuleInput | EditTransportRuleInput): Record<string, unknown> {
  const conditionsJson = fieldJson(input.conditions);
  const actionsJson = fieldJson(input.actions);
  const exceptionsJson = fieldJson(input.exceptions);
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(conditionsJson !== undefined ? { conditionsJson } : {}),
    ...(actionsJson !== undefined ? { actionsJson } : {}),
    ...(exceptionsJson !== undefined ? { exceptionsJson } : {}),
  };
}

function connectorWriteFields(input: CreateConnectorInput | EditConnectorInput): Record<string, unknown> {
  return {
    ...("action" in input && input.action !== undefined ? { action: input.action } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...("type" in input && input.type !== undefined ? { type: input.type } : {}),
    ...(input.senderDomains !== undefined ? { senderDomains: input.senderDomains } : {}),
    ...(input.recipientDomains !== undefined ? { recipientDomains: input.recipientDomains } : {}),
    ...(input.requireTls !== undefined ? { requireTls: input.requireTls } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.secretRef !== undefined ? { secretRef: input.secretRef } : {}),
  };
}

function asRulesPage(value: unknown, tenantId: string): TransportRulesPage {
  const record = asRecord(value);
  const items = asArray(record["items"]);
  return {
    tenantId: typeof record["tenantId"] === "string" ? record["tenantId"] : tenantId,
    totalCount: typeof record["totalCount"] === "number" ? record["totalCount"] : items.length,
    items: items as TransportRulesPage["items"],
    nextCursor: typeof record["nextCursor"] === "string" && record["nextCursor"].length > 0
      ? record["nextCursor"]
      : null,
  };
}

function asConnectorsPage(value: unknown, tenantId: string): ConnectorsPage {
  const record = asRecord(value);
  const items = asArray(record["items"]);
  return {
    tenantId: typeof record["tenantId"] === "string" ? record["tenantId"] : tenantId,
    totalCount: typeof record["totalCount"] === "number" ? record["totalCount"] : items.length,
    items: items as ConnectorsPage["items"],
    nextCursor: typeof record["nextCursor"] === "string" && record["nextCursor"].length > 0
      ? record["nextCursor"]
      : null,
  };
}

export function createTransportProviders(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
): TransportProviders {
  const call = createTenantWorker(run, credentials);

  function rulesFilter(f: TransportRulesFilter): Record<string, unknown> {
    return {
      ...(f.search ? { search: f.search } : {}),
      ...(f.state ? { state: f.state } : {}),
      top: f.limit,
      ...(f.cursor ? { cursor: f.cursor } : {}),
    };
  }

  function connectorsFilter(f: ConnectorsFilter): Record<string, unknown> {
    return {
      ...(f.search ? { search: f.search } : {}),
      ...(f.type ? { type: f.type } : {}),
      ...(f.state ? { state: f.state } : {}),
      top: f.limit,
      ...(f.cursor ? { cursor: f.cursor } : {}),
    };
  }

  const rules: TransportRulesProvider = {
    async listTransportRules(tenantId, filter) {
      const result = await call<unknown>("get-transport-rules.ps1", tenantId, rulesFilter(filter));
      raiseWorkerError(result);
      return asRulesPage(result, tenantId);
    },
  };

  const rulesWrite: TransportRulesWriteProvider = {
    async createRule(tenantId, input, preview): Promise<TransportRuleResult | TransportRulePlan> {
      const result = await call<unknown>("set-transport-rule.ps1", tenantId, {
        action: "create",
        ...ruleWriteFields(input),
        dryRun: preview,
        confirmed: !preview,
      });
      raiseWorkerError(result);
      return result as TransportRuleResult | TransportRulePlan;
    },

    async editRule(tenantId, ruleId, input, preview): Promise<TransportRuleResult | TransportRulePlan> {
      const result = await call<unknown>("set-transport-rule.ps1", tenantId, {
        action: "edit",
        ruleId,
        ...ruleWriteFields(input),
        dryRun: preview,
        confirmed: !preview,
      });
      raiseWorkerError(result);
      return result as TransportRuleResult | TransportRulePlan;
    },

    async deleteRule(tenantId, ruleId, preview): Promise<TransportRuleResult | TransportRulePlan> {
      const result = await call<unknown>("set-transport-rule.ps1", tenantId, {
        action: "delete",
        ruleId,
        dryRun: preview,
        confirmed: !preview,
      });
      raiseWorkerError(result);
      return result as TransportRuleResult | TransportRulePlan;
    },
  };

  const connectors: ConnectorsProvider = {
    async listConnectors(tenantId, filter) {
      const result = await call<unknown>("get-connectors.ps1", tenantId, connectorsFilter(filter));
      raiseWorkerError(result);
      return asConnectorsPage(result, tenantId);
    },

    async createConnector(
      tenantId,
      input,
      preview,
    ): Promise<ConnectorResult | ConnectorPlan> {
      const result = await call<unknown>("set-connector.ps1", tenantId, {
        action: "create",
        ...connectorWriteFields(input),
        dryRun: preview,
        confirmed: !preview,
      });
      raiseWorkerError(result);
      return result as ConnectorResult | ConnectorPlan;
    },

    async editConnector(
      tenantId,
      connectorId,
      input,
      preview,
    ): Promise<ConnectorResult | ConnectorPlan> {
      const result = await call<unknown>("set-connector.ps1", tenantId, {
        action: input.action ?? "edit",
        connectorId,
        ...connectorWriteFields(input),
        dryRun: preview,
        confirmed: !preview,
      });
      raiseWorkerError(result);
      return result as ConnectorResult | ConnectorPlan;
    },

    async deleteConnector(
      tenantId,
      connectorId,
      preview,
    ): Promise<ConnectorResult | ConnectorPlan> {
      const result = await call<unknown>("set-connector.ps1", tenantId, {
        action: "delete",
        connectorId,
        dryRun: preview,
        confirmed: !preview,
      });
      raiseWorkerError(result);
      return result as ConnectorResult | ConnectorPlan;
    },
  };

  const deploy: TransportTemplateDeployExecutor = {
    async apply(request: TransportTemplateApplyRequest): Promise<TransportTemplateApplyOutcome> {
      const kind = request.kind === "transport-rule" ? "rule" : "connector";
      const result = await call<unknown>("deploy-transport-template.ps1", request.tenantId, {
        kind,
        template: request.payload,
        variables: {},
        actor: request.actor,
        confirmed: true,
        dryRun: false,
      });
      raiseWorkerError(result);
      const record = asRecord(result);
      if (record["success"] === false) {
        const detail = typeof record["error"] === "string" ? record["error"] : "template deploy failed";
        throw new AppError("transport.template_deploy_failed", detail, 502);
      }
      const event = asRecord(record["auditEvent"]);
      const auditEvent = Object.keys(event).length > 0
        ? event
        : {
            id: globalThis.crypto.randomUUID(),
            tenantId: request.tenantId,
            action: `transport.template.deploy.${kind}`,
            targetId: request.templateId,
            targetName: request.name,
            actor: request.actor,
            timestamp: new Date().toISOString(),
            before: null,
            after: request.payload,
          };
      return {
        before: (auditEvent["before"] as Record<string, unknown> | null | undefined) ?? null,
        after: (auditEvent["after"] as Record<string, unknown> | null | undefined) ?? null,
        auditEvent,
      };
    },
  };

  return { rules, rulesWrite, connectors, deploy };
}
