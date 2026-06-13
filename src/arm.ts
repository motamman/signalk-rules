import { ServerAPI } from '@signalk/server-api';
import { ArmedRule, PluginState, Rule } from './types';
import {
  compileConditionRule,
  seedConditionRule,
  armConditions,
  disarmConditions,
} from './engine';
import { armScheduleRule } from './schedule';

/** Stop every timer/subscription and forget all armed rules. */
export function disarmAll(state: PluginState): void {
  disarmConditions(state);
  for (const armed of state.armed.values()) {
    for (const task of armed.cronTasks.splice(0)) {
      try {
        task.stop();
      } catch {
        // best-effort cleanup
      }
    }
  }
  state.armed.clear();
}

/**
 * Rebuild the full armed state from `state.config.rules`. Disabled rules are
 * tracked (so the UI can show their last result) but not wired up. A rule that
 * fails to arm (e.g. a malformed condition) is logged and skipped without
 * aborting the others.
 */
export function armAll(
  state: PluginState,
  app: ServerAPI,
  pluginId: string
): void {
  disarmAll(state);

  for (const rule of state.config.rules) {
    const armed: ArmedRule = { def: rule, cronTasks: [] };
    state.armed.set(rule.id, armed);
    if (!rule.enabled) continue;
    try {
      armOne(armed, app, pluginId);
    } catch (e) {
      app.error(`[rule:${rule.name}] failed to arm: ${e}`);
    }
  }

  // One delta subscription covers every enabled condition rule.
  armConditions(state, app, pluginId);
}

function armOne(armed: ArmedRule, app: ServerAPI, pluginId: string): void {
  const rule: Rule = armed.def;
  if (rule.trigger.kind === 'condition') {
    compileConditionRule(armed);
    void seedConditionRule(armed, app);
  } else if (rule.trigger.kind === 'schedule') {
    armScheduleRule(armed, app, pluginId);
  }
}
