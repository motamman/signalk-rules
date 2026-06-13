import { Router } from 'express';
import { ServerAPI } from '@signalk/server-api';
import { PluginConfig, PluginState, SignalKPlugin } from './types';
import { armAll, disarmAll } from './arm';
import { registerApiRoutes } from './api-routes';
import { RULES_SCHEMA } from './schema';
import { loadRules, saveRules } from './storage';

export default function (app: ServerAPI): SignalKPlugin {
  const plugin: SignalKPlugin = {
    id: 'signalk-rules',
    name: 'Rules',
    description:
      'Declarative automation: IF a path condition is met (or WHEN a schedule fires), THEN run an ordered batch of actions.',
    schema: RULES_SCHEMA,
    start: () => {},
    stop: () => {},
    registerWithRouter: undefined,
  };

  const state: PluginState = {
    config: { rules: [] },
    armed: new Map(),
    deltaUnsubscribes: [],
    started: false,
  };

  function updateStatus(): void {
    const active = state.config.rules.filter((r) => r.enabled).length;
    app.setPluginStatus(`${active} active rule(s)`);
  }

  /**
   * Persist the current rule set to its own file (never plugin options) and
   * rebuild the armed state so edits take effect immediately. Shared by the
   * REST routes.
   */
  function persist(): Promise<void> {
    saveRules(app, state.config.rules);
    armAll(state, app, plugin.id);
    updateStatus();
    return Promise.resolve();
  }

  plugin.start = function (_options: Partial<PluginConfig>): void {
    // Rules live in their own file, not plugin options.
    state.config = { rules: loadRules(app) };
    armAll(state, app, plugin.id);
    state.started = true;
    app.debug(`started with ${state.config.rules.length} rule(s)`);
    updateStatus();
  };

  plugin.stop = function (): void {
    disarmAll(state);
    state.started = false;
    app.debug('stopped');
  };

  plugin.registerWithRouter = function (router: Router): void {
    registerApiRoutes(router, state, app, plugin.id, persist);
  };

  return plugin;
}
