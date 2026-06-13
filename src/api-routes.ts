import { randomUUID } from 'crypto';
import { Request, Response, Router } from 'express';
import { ServerAPI } from '@signalk/server-api';
import { ConditionGroup, ConditionNode, PluginState, Rule } from './types';
import { runRuleActions } from './actions';
import { evaluateLive } from './engine';
import { detectPathType } from './type-detector';
import { OPERATORS_BY_TYPE } from './operators';

/**
 * Register the plugin's REST API. Mounted by the server under
 * `/plugins/signalk-rules`, so these paths are reachable at
 * `/plugins/signalk-rules/api/rules` etc. The webapp is the primary client.
 *
 * `persist` saves the current rule set and re-arms the engine; routes mutate
 * `state.config.rules` then call it so edits take effect without a restart.
 */
export function registerApiRoutes(
  router: Router,
  state: PluginState,
  app: ServerAPI,
  pluginId: string,
  persist: () => Promise<void>
): void {
  /** Merge persisted rule definition with its live runtime status for the UI. */
  function withStatus(rule: Rule): Record<string, unknown> {
    const armed = state.armed.get(rule.id);
    return { ...rule, lastResult: armed?.lastResult, lastFiredMs: armed?.lastFiredMs };
  }

  // ----- list / get ------------------------------------------------------

  router.get('/api/rules', (_req: Request, res: Response) => {
    res.json({ rules: state.config.rules.map(withStatus) });
  });

  router.get('/api/rules/:id', (req: Request, res: Response) => {
    const rule = state.config.rules.find((r) => r.id === req.params.id);
    if (!rule) return res.status(404).json({ error: 'rule not found' });
    return res.json(withStatus(rule));
  });

  // ----- create ----------------------------------------------------------

  router.post('/api/rules', async (req: Request, res: Response) => {
    const incoming = req.body as Partial<Rule>;
    const err = validateRule(incoming);
    if (err) return res.status(400).json({ error: err });
    const rule: Rule = {
      ...(incoming as Rule),
      id: incoming.id && incoming.id.trim() ? incoming.id : randomUUID(),
      enabled: incoming.enabled ?? true,
    };
    if (state.config.rules.some((r) => r.id === rule.id)) {
      return res.status(409).json({ error: `rule id '${rule.id}' already exists` });
    }
    state.config.rules.push(rule);
    try {
      await persist();
      return res.status(201).json(withStatus(rule));
    } catch (e) {
      return res.status(500).json({ error: `save failed: ${e}` });
    }
  });

  // ----- update ----------------------------------------------------------

  router.put('/api/rules/:id', async (req: Request, res: Response) => {
    const idx = state.config.rules.findIndex((r) => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'rule not found' });
    const incoming = req.body as Partial<Rule>;
    const err = validateRule(incoming);
    if (err) return res.status(400).json({ error: err });
    const rule: Rule = {
      ...(incoming as Rule),
      id: req.params.id, // id is immutable via this route
      enabled: incoming.enabled ?? true,
    };
    state.config.rules[idx] = rule;
    try {
      await persist();
      return res.json(withStatus(rule));
    } catch (e) {
      return res.status(500).json({ error: `save failed: ${e}` });
    }
  });

  // ----- enable / disable (convenience) ----------------------------------

  router.post('/api/rules/:id/enabled', async (req: Request, res: Response) => {
    const rule = state.config.rules.find((r) => r.id === req.params.id);
    if (!rule) return res.status(404).json({ error: 'rule not found' });
    const enabled = (req.body as { enabled?: unknown })?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'body must be { enabled: boolean }' });
    }
    rule.enabled = enabled;
    try {
      await persist();
      return res.json(withStatus(rule));
    } catch (e) {
      return res.status(500).json({ error: `save failed: ${e}` });
    }
  });

  // ----- delete ----------------------------------------------------------

  router.delete('/api/rules/:id', async (req: Request, res: Response) => {
    const idx = state.config.rules.findIndex((r) => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'rule not found' });
    state.config.rules.splice(idx, 1);
    try {
      await persist();
      return res.status(204).end();
    } catch (e) {
      return res.status(500).json({ error: `save failed: ${e}` });
    }
  });

  // ----- run the action batch now (ignores trigger + debounce) -----------

  router.post('/api/rules/:id/test', async (req: Request, res: Response) => {
    const armed = state.armed.get(req.params.id);
    if (!armed) return res.status(404).json({ error: 'rule not found' });
    try {
      const result = await runRuleActions(armed, app, pluginId, 'test');
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ error: `test run failed: ${e}` });
    }
  });

  // ----- evaluate a condition group against live data (read-only) --------

  router.post('/api/evaluate', async (req: Request, res: Response) => {
    const conditions = (req.body as { conditions?: ConditionGroup })?.conditions;
    if (!conditions || (!('all' in conditions) && !('any' in conditions))) {
      return res.status(400).json({ error: 'body must be { conditions: { all|any: [...] } }' });
    }
    try {
      const out = await evaluateLive(app, conditions);
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ error: `evaluate failed: ${e}` });
    }
  });

  // ----- type of a path + the operators valid for it ---------------------

  router.get('/api/paths/:path/type', (req: Request, res: Response) => {
    try {
      const info = detectPathType(req.params.path, app);
      const node = app.getSelfPath(req.params.path);
      const current =
        node && typeof node === 'object' && 'value' in node
          ? (node as { value: unknown }).value
          : node;
      return res.json({ ...info, operators: OPERATORS_BY_TYPE[info.dataType] ?? [], current });
    } catch (e) {
      return res.status(500).json({ error: `type detection failed: ${e}` });
    }
  });

  /** The full operator catalogue keyed by data type (for the UI). */
  router.get('/api/operators', (_req: Request, res: Response) => {
    res.json({ operatorsByType: OPERATORS_BY_TYPE });
  });

  // ----- available Signal K paths (path picker) --------------------------

  router.get('/api/paths', (_req: Request, res: Response) => {
    try {
      const self = app.getSelfPath('') as unknown;
      res.json({ paths: flattenLeafPaths(self) });
    } catch (e) {
      res.status(500).json({ error: `could not read paths: ${e}` });
    }
  });
}

// ----- validation ---------------------------------------------------------

/** Minimal shape validation for an incoming rule. Returns an error string, or null if ok. */
function validateRule(r: Partial<Rule> | undefined): string | null {
  if (!r || typeof r !== 'object') return 'body must be a rule object';
  if (!r.name || typeof r.name !== 'string') return 'name is required';
  if (!r.trigger || typeof r.trigger !== 'object') return 'trigger is required';
  const kind = (r.trigger as { kind?: string }).kind;
  if (kind !== 'condition' && kind !== 'schedule') {
    return "trigger.kind must be 'condition' or 'schedule'";
  }
  if (kind === 'condition') {
    const t = r.trigger as { conditions?: unknown; edge?: unknown };
    const condErr = validateConditionNode(t.conditions, true);
    if (condErr) return condErr;
    if (!['rising', 'falling', 'always'].includes(t.edge as string)) {
      return "condition trigger edge must be 'rising', 'falling' or 'always'";
    }
  } else {
    const t = r.trigger as { schedule?: unknown };
    if (!['clock', 'sunrise', 'sunset'].includes(t.schedule as string)) {
      return "schedule trigger.schedule must be 'clock', 'sunrise' or 'sunset'";
    }
  }
  if (!Array.isArray(r.actions) || r.actions.length === 0) {
    return 'at least one action is required';
  }
  for (const a of r.actions) {
    const type = (a as { type?: string })?.type;
    if (type !== 'put' && type !== 'notification') {
      return `unsupported action type '${type}' (expected 'put' or 'notification')`;
    }
  }
  return null;
}

/** Recursively validate a condition node. Top-level must be an all/any group. */
function validateConditionNode(node: unknown, topLevel: boolean): string | null {
  if (!node || typeof node !== 'object') return 'condition must be an object';
  const group = node as { all?: unknown; any?: unknown };
  const branch = group.all ?? group.any;
  if (branch !== undefined) {
    if (!Array.isArray(branch)) return 'all/any must be an array of conditions';
    if (branch.length === 0) return 'a condition group needs at least one test';
    for (const child of branch as ConditionNode[]) {
      const err = validateConditionNode(child, false);
      if (err) return err;
    }
    return null;
  }
  if (topLevel) return 'top-level condition must be an { all: [...] } or { any: [...] } group';
  // Leaf test
  const leaf = node as { fact?: unknown; operator?: unknown };
  if (!leaf.fact || typeof leaf.fact !== 'string') return 'each test needs a fact (Signal K path)';
  if (!leaf.operator || typeof leaf.operator !== 'string') return 'each test needs an operator';
  return null;
}

/**
 * Walk the `vessels.self` tree and collect dotted paths to leaf nodes (objects
 * carrying a `value`), so the UI can offer a path picker.
 */
function flattenLeafPaths(node: unknown, prefix = '', out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  const obj = node as Record<string, unknown>;
  // A Signal K leaf node carries a `value` alongside timestamp/$source/meta.
  if ('value' in obj) {
    if (prefix) out.push(prefix);
    return out;
  }
  for (const [key, child] of Object.entries(obj)) {
    if (key === 'meta' || key === '$source' || key === 'timestamp') continue;
    flattenLeafPaths(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}
