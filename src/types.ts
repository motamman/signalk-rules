import { Router } from 'express';
import type { Engine } from 'json-rules-engine';

/** Minimal shape of a stoppable scheduled task (croner Cron or a timer). */
export interface StoppableTask {
  stop(): void;
}

/**
 * The persisted, declarative rule model. Rules are plain JSON — the engine is
 * the only consumer of this shape, so the same model can back any UI.
 *
 * Conditions use the `json-rules-engine` structure: a top-level `all`/`any`
 * group of leaf tests. Each leaf's `fact` is a Signal K path (self context);
 * the engine is fed current path values as facts at evaluation time.
 */

// ----- Triggers -----------------------------------------------------------

export type EdgeMode = 'rising' | 'falling' | 'always';

/** A single path test: `fact` (SK path) `operator` `value`. */
export interface ConditionLeaf {
  /** Signal K path on self, used as the json-rules-engine fact id. */
  fact: string;
  /** json-rules-engine operator (built-in or custom, e.g. withinRadius). */
  operator: string;
  /** Comparison value. For range/position operators this is an object. */
  value: unknown;
  /** Optional JSONPath into the fact value (e.g. '$.latitude'). */
  path?: string;
}

export interface AllGroup {
  all: ConditionNode[];
}
export interface AnyGroup {
  any: ConditionNode[];
}
export type ConditionNode = ConditionLeaf | AllGroup | AnyGroup;
/** Top-level condition is always a group (json-rules-engine requirement). */
export type ConditionGroup = AllGroup | AnyGroup;

export interface ConditionTrigger {
  kind: 'condition';
  /** Top-level all/any group of path tests. */
  conditions: ConditionGroup;
  /** When to fire relative to the group's previous truthiness. */
  edge: EdgeMode;
}

/** `clock` = time + days; `sunrise`/`sunset` = sun event + offset. */
export type ScheduleKind = 'clock' | 'sunrise' | 'sunset';

export interface ScheduleTrigger {
  kind: 'schedule';
  schedule: ScheduleKind;
  /** 'HH:MM' (24h) — required for `clock`. */
  time?: string;
  /** Days of week to run, 0=Sunday..6=Saturday. Empty/undefined = every day. */
  days?: number[];
  /** Minutes added to the sun event (negative = before) — for `sunrise`/`sunset`. */
  offsetMinutes?: number;
}

export type Trigger = ConditionTrigger | ScheduleTrigger;

// ----- Actions (a "batch", executed in order) -----------------------------

export interface PutAction {
  type: 'put';
  /** Signal K path on self to PUT. */
  path: string;
  value: unknown;
}

export interface NotificationAction {
  type: 'notification';
  /** Path under `notifications.` to raise (without the `notifications.` prefix). */
  path: string;
  /** normal | alert | warn | alarm | emergency. */
  state: string;
  message: string;
  /** Notification methods, defaults to ['visual']. */
  methods?: string[];
}

export type Action = PutAction | NotificationAction;

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  /** Suppress re-firing within this many ms of the last fire. */
  debounceMs?: number;
  actions: Action[];
}

// ----- Run results (runtime, surfaced to the UI) --------------------------

export interface ActionResult {
  type: string;
  ok: boolean;
  message?: string;
}

export interface RuleRunResult {
  /** ISO timestamp of the run. */
  at: string;
  ok: boolean;
  /** Why the rule ran: 'condition' | 'schedule' | 'test'. */
  trigger: string;
  message?: string;
  actionResults: ActionResult[];
}

// ----- Plugin config + runtime state --------------------------------------

export interface PluginConfig {
  rules: Rule[];
}

/** Per-rule runtime wrapper — never persisted. */
export interface ArmedRule {
  def: Rule;
  /** Compiled json-rules-engine instance (condition rules only). */
  engine?: Engine;
  /** Distinct SK paths the condition references (condition rules only). */
  factPaths?: string[];
  /** Previous truthiness for edge detection (condition rules only). */
  previous?: boolean;
  /** Active cron tasks (schedule rules only). */
  cronTasks: StoppableTask[];
  /** Timestamp (ms) of the last fire, for debounce. */
  lastFiredMs?: number;
  /** Most recent run result, surfaced to the UI. */
  lastResult?: RuleRunResult;
}

export interface PluginState {
  config: PluginConfig;
  /** Armed rules keyed by rule id. */
  armed: Map<string, ArmedRule>;
  /** Cleanup functions for the delta-stream subscription (condition rules). */
  deltaUnsubscribes: Array<() => void>;
  started: boolean;
}

export interface SignalKPlugin {
  id: string;
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  start: (options: Partial<PluginConfig>) => void;
  stop: () => void;
  registerWithRouter?: (router: Router) => void;
}
