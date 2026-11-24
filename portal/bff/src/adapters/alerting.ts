// EPIC-029 alerting stores (T-0859).
//
// The four route groups were written against store seams but never mounted, and
// migration 0037 shipped no repository, so every store was implemented only by test
// fakes. This adapter binds the seams to `SqliteAlertingRepository`, seeds the
// built-in rule catalog and the four notification channels once, and backs the
// dry-run evaluator with the only durable log source the BFF already has: each
// tenant's latest finished run findings. Graph log sources arrive with the
// evaluation worker (T-0564); until then those rules report "No matching data"
// rather than a fabricated match.
import type {
  AlertEventRecord,
  SqliteAlertingRepository,
  SqliteRepository,
  AlertRuleRecord as DbAlertRule,
} from "@m365-assess/db";
import { seedBuiltinRules } from "../domain/alerts/builtin-catalog.js";
import type { AlertRule, AlertRuleView } from "../domain/alerts/builtin-catalog.js";
import { createAlertRuleTestEvaluator } from "../domain/alerts/evaluate.js";
import type { AlertEvent } from "../domain/alerts/snooze.js";
import type {
  AlertEventFilter,
  AlertEventPage,
  AlertEventStore,
} from "../routes/alert-events.js";
import type {
  AlertRuleCreate,
  AlertRulePatch,
  AlertRulesStore,
} from "../routes/alert-rules.js";
import type { TestableAlertRule } from "../routes/alert-rules-test.js";
import type {
  NotificationConfig,
  NotificationConfigStore,
} from "../routes/notifications.js";

export interface AlertingStores {
  readonly rules: AlertRulesStore;
  readonly ruleTests: { getRule(ruleId: string): Promise<TestableAlertRule | undefined> };
  readonly events: AlertEventStore;
  readonly notifications: NotificationConfigStore;
  readonly evaluator: ReturnType<typeof createAlertRuleTestEvaluator>;
}

function toRule(row: DbAlertRule): AlertRule {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    severity: row.severity,
    scope: row.scope,
    channels: row.channels,
    enabled: row.enabled,
    scriptMode: row.scriptMode,
    scheduleId: row.scheduleId,
    lastFiredAt: row.lastFiredAt,
    builtIn: row.builtIn,
  };
}

function toTestableRule(row: DbAlertRule): TestableAlertRule {
  return {
    ...toRule(row),
    tenantId: row.tenantId ?? "all",
    criteria: { conditions: row.conditions, actions: row.actions },
  };
}

function toEvent(row: AlertEventRecord): AlertEvent & { readonly source: string | null } {
  return {
    id: row.id,
    ruleId: row.ruleId,
    tenantId: row.tenantId,
    firedAt: row.firedAt,
    severity: row.severity,
    payload: row.payload ?? {},
    state: row.state,
    snoozeUntil: row.snoozeUntil,
    source: row.source,
  };
}

export interface AlertingStoreOptions {
  readonly repo: SqliteAlertingRepository;
  readonly findings: Pick<SqliteRepository, "listRuns" | "listFindings">;
}

/**
 * The data the built-in catalog seeds on a fresh install: rules start disabled so a
 * new portal raises nothing until an operator opts in (SPEC §4.1), and every
 * notification channel exists so the settings page can configure it.
 */
export async function seedAlertingDefaults(repo: SqliteAlertingRepository): Promise<void> {
  await repo.seedRules(
    seedBuiltinRules(false).map((rule) => ({
      id: rule.id,
      name: rule.name,
      source: rule.source,
      severity: rule.severity,
      scope: rule.scope,
      channels: rule.channels,
      enabled: false,
      scriptMode: false,
      scheduleId: null,
      builtIn: true,
      tenantId: null,
    })),
  );
  await repo.seedChannels();
}

export function createAlertingStores(options: AlertingStoreOptions): AlertingStores {
  const { repo } = options;
  // Seed once per app instance. createApp is synchronous, so the stores await this
  // promise on their first read instead of making app construction async. The
  // extra catch keeps a seeding failure from becoming an unhandled rejection when
  // the app closes (and the database) before the first read.
  const ready = seedAlertingDefaults(repo);
  void ready.catch(() => undefined);

  const rules: AlertRulesStore = {
    async listRules() {
      await ready;
      return (await repo.listRules()).map(toRule);
    },
    async getRule(ruleId) {
      await ready;
      const row = await repo.getRule(ruleId);
      return row === undefined ? undefined : toRule(row);
    },
    async createRule(input: AlertRuleCreate) {
      const row = await repo.createRule({
        id: input.id,
        name: input.name,
        source: input.source,
        severity: input.severity,
        scope: input.scope,
        channels: input.channels,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.scriptMode !== undefined ? { scriptMode: input.scriptMode } : {}),
        ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
        builtIn: false,
        tenantId: null,
      });
      return toRule(row);
    },
    async updateRule(ruleId: string, patch: AlertRulePatch) {
      const row = await repo.updateRule(ruleId, patch);
      return row === undefined ? undefined : toRule(row);
    },
    async deleteRule(ruleId) {
      return repo.deleteRule(ruleId);
    },
    async setRuleEnabled(ruleId, enabled) {
      const row = await repo.setRuleEnabled(ruleId, enabled);
      return row === undefined ? undefined : toRule(row);
    },
  };

  const events: AlertEventStore = {
    async listEvents(filter: AlertEventFilter): Promise<AlertEventPage> {
      const page = await repo.listEvents(filter);
      return {
        totalCount: page.totalCount,
        items: page.items.map(toEvent),
        nextCursor: page.nextCursor,
      };
    },
    async snoozeRuleEvents(ruleId, snoozeUntil) {
      return (await repo.snoozeRuleEvents(ruleId, snoozeUntil)).map(toEvent);
    },
    async returnDueSnoozedEvents(now) {
      return (await repo.returnDueSnoozedEvents(now)).map(toEvent);
    },
  };

  const notifications: NotificationConfigStore = {
    async listChannels(): Promise<readonly NotificationConfig[]> {
      await ready;
      return (await repo.listChannels()).map((channel) => ({
        id: channel.id,
        channel: channel.channel,
        target: channel.target,
        enabled: channel.enabled,
      }));
    },
    async getChannel(id) {
      const channel = await repo.getChannel(id);
      return channel === undefined
        ? undefined
        : { id: channel.id, channel: channel.channel, target: channel.target, enabled: channel.enabled };
    },
    async updateChannel(id, patch) {
      const channel = await repo.updateChannel(id, patch);
      return channel === undefined
        ? undefined
        : { id: channel.id, channel: channel.channel, target: channel.target, enabled: channel.enabled };
    },
  };

  const ruleTests = {
    async getRule(ruleId: string): Promise<TestableAlertRule | undefined> {
      await ready;
      const row = await repo.getRule(ruleId);
      return row === undefined ? undefined : toTestableRule(row);
    },
  };

  const evaluator = createAlertRuleTestEvaluator({
    async read({ tenantId, source }) {
      // A rule scoped to no tenant ("all") has no source to read; the dry run then
      // reports zero evaluated rows instead of inventing a match.
      if (tenantId === "all" || tenantId.length === 0) return [];
      const runs = await options.findings.listRuns(tenantId);
      const run = runs
        .filter((entry) => entry.status === "succeeded" || entry.status === "partial")
        .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0];
      if (run === undefined) return [];
      const findings = await options.findings.listFindings(tenantId, run.id);
      return findings.map((finding) => ({
        source,
        status: finding.status,
        severity: finding.severity ?? "Info",
        checkId: finding.checkId,
        controlName: finding.controlName,
        category: finding.category,
        collector: finding.collector,
        frameworkRefs: finding.frameworkRefs,
        remediationMode: finding.remediationMode,
      }));
    },
  });

  return { rules, ruleTests, events, notifications, evaluator };
}

/** Re-exported for the app composition; kept narrow so the BFF names no Graph type. */
export type { AlertRuleView };
