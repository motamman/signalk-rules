import { Engine } from 'json-rules-engine';
import {
  ServerAPI,
  Context,
  Delta,
  Path,
  SubscribeMessage,
} from '@signalk/server-api';
import {
  ArmedRule,
  ConditionGroup,
  ConditionNode,
  ConditionTrigger,
  PluginState,
} from './types';
import { maybeFire } from './actions';
import { registerCustomOperators } from './operators';

// The subscribe-list item shape the server expects.
type SubscribeOptions = SubscribeMessage['subscribe'][number];

/** Collect the distinct fact paths referenced anywhere in a condition tree. */
export function extractFactPaths(node: ConditionNode): string[] {
  const out = new Set<string>();
  const walk = (n: ConditionNode): void => {
    if ('all' in n) n.all.forEach(walk);
    else if ('any' in n) n.any.forEach(walk);
    else if (n.fact) out.add(n.fact);
  };
  walk(node);
  return [...out];
}

/**
 * Build the json-rules-engine instance for a condition rule and cache it (plus
 * the fact paths it reads) on the armed wrapper. Throws if the condition shape
 * is invalid so the caller can surface the error per-rule.
 */
export function compileConditionRule(armed: ArmedRule): void {
  const trigger = armed.def.trigger as ConditionTrigger;
  const engine = new Engine([{ conditions: trigger.conditions, event: { type: 'fired' } }], {
    allowUndefinedFacts: true,
  });
  registerCustomOperators(engine);
  armed.engine = engine;
  armed.factPaths = extractFactPaths(trigger.conditions);
  armed.previous = false;
}

/** Read the current value of a Signal K path, unwrapping the SK leaf node. */
function pathValue(app: ServerAPI, path: string): unknown {
  const node = app.getSelfPath(path);
  return node && typeof node === 'object' && 'value' in node
    ? (node as { value: unknown }).value
    : node;
}

/** Build the facts object (path -> current value) for a set of fact paths. */
function buildFacts(app: ServerAPI, factPaths: string[]): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const p of factPaths) facts[p] = pathValue(app, p);
  return facts;
}

/**
 * Evaluate a condition group against current live values without arming or
 * firing. Powers the UI's "check now" affordance. Returns the facts used, the
 * boolean result, and any error.
 */
export async function evaluateLive(
  app: ServerAPI,
  conditions: ConditionGroup
): Promise<{ facts: Record<string, unknown>; result: boolean | null; error?: string }> {
  const factPaths = extractFactPaths(conditions);
  const facts = buildFacts(app, factPaths);
  try {
    const engine = new Engine([{ conditions, event: { type: 'fired' } }], {
      allowUndefinedFacts: true,
    });
    registerCustomOperators(engine);
    const res = await engine.run(facts);
    return { facts, result: res.events.length > 0 };
  } catch (e) {
    return { facts, result: null, error: String(e) };
  }
}

/** Run the cached engine and return whether the condition group passes. */
async function evalCondition(armed: ArmedRule, app: ServerAPI): Promise<boolean> {
  try {
    const res = await armed.engine!.run(buildFacts(app, armed.factPaths ?? []));
    return res.events.length > 0;
  } catch (e) {
    app.error(`[rule:${armed.def.name}] condition eval error: ${e}`);
    return false;
  }
}

/**
 * Evaluate one condition rule and fire it if the configured edge transition
 * occurred. `previous` is updated in place each call.
 */
async function evaluateAndMaybeFire(
  armed: ArmedRule,
  app: ServerAPI,
  pluginId: string
): Promise<void> {
  const trigger = armed.def.trigger as ConditionTrigger;
  const now = await evalCondition(armed, app);
  const prev = armed.previous;
  const fired =
    (trigger.edge === 'rising' && now && !prev) ||
    (trigger.edge === 'falling' && !now && prev) ||
    (trigger.edge === 'always' && now);
  armed.previous = now;
  if (fired) {
    void maybeFire(armed, app, pluginId, 'condition');
  }
}

/**
 * Seed `previous` from the current value without firing, so arming a rule whose
 * condition is already true doesn't immediately fire on a rising edge.
 */
export async function seedConditionRule(armed: ArmedRule, app: ServerAPI): Promise<void> {
  armed.previous = await evalCondition(armed, app);
}

/** Collect the distinct SK paths referenced by all enabled condition rules. */
function conditionPaths(state: PluginState): string[] {
  const paths = new Set<string>();
  for (const armed of state.armed.values()) {
    if (!armed.def.enabled || armed.def.trigger.kind !== 'condition') continue;
    for (const p of armed.factPaths ?? []) paths.add(p);
  }
  return [...paths];
}

/**
 * (Re)subscribe to the delta stream for every path any enabled condition rule
 * cares about, and re-evaluate the affected rules on each delta. Skips
 * `notifications.*` deltas to avoid feedback loops.
 */
export function armConditions(state: PluginState, app: ServerAPI, pluginId: string): void {
  disarmConditions(state);

  const paths = conditionPaths(state);
  if (paths.length === 0) {
    app.debug('no enabled condition rules; not subscribing to deltas');
    return;
  }

  const subscription = {
    context: app.selfContext as Context,
    subscribe: paths.map((path): SubscribeOptions => ({ path: path as Path, policy: 'instant' })),
  };

  app.subscriptionmanager.subscribe(
    subscription,
    state.deltaUnsubscribes,
    (err: unknown) => app.error(`[rules] subscription error: ${err}`),
    (delta: Delta) => onDelta(state, app, pluginId, delta)
  );
  app.debug(`subscribed to ${paths.length} path(s) for condition rules`);
}

/** Tear down the delta subscription. */
export function disarmConditions(state: PluginState): void {
  for (const unsub of state.deltaUnsubscribes.splice(0)) {
    try {
      unsub();
    } catch {
      // best-effort cleanup
    }
  }
}

function onDelta(state: PluginState, app: ServerAPI, pluginId: string, delta: Delta): void {
  const changed = new Set<string>();
  for (const update of delta.updates ?? []) {
    const values = (update as { values?: Array<{ path?: string }> }).values;
    if (!values) continue;
    for (const v of values) {
      if (!v.path || v.path.startsWith('notifications')) continue;
      changed.add(v.path);
    }
  }
  if (changed.size === 0) return;

  for (const armed of state.armed.values()) {
    if (!armed.def.enabled || armed.def.trigger.kind !== 'condition') continue;
    if ((armed.factPaths ?? []).some((p) => changed.has(p))) {
      void evaluateAndMaybeFire(armed, app, pluginId);
    }
  }
}
