import { ServerAPI, Context, Path, Timestamp } from '@signalk/server-api';
import { Action, ActionResult, ArmedRule, RuleRunResult } from './types';

/**
 * Execute a single action and return a structured result. Actions never throw
 * out of here — failures become `{ ok: false }` so one bad action in a batch
 * doesn't abort the rest.
 */
export async function runAction(
  a: Action,
  app: ServerAPI,
  pluginId: string
): Promise<ActionResult> {
  try {
    switch (a.type) {
      case 'put': {
        // putSelfPath resolves once the registered PUT handler responds; it
        // rejects when there is no handler / the handler reports failure.
        const reply = (await app.putSelfPath(a.path, a.value, () => {})) as
          | { state?: string; statusCode?: number; message?: string }
          | undefined;
        const state = reply?.state;
        const statusCode = reply?.statusCode;
        // The server resolves a Reply whose `state` is COMPLETED even for
        // failures (e.g. 405 = no registered PUT handler), so statusCode is
        // the authoritative signal when present. PENDING = accepted async.
        const ok =
          statusCode !== undefined
            ? statusCode < 400
            : state === 'PENDING' || state === 'COMPLETED';
        return {
          type: 'put',
          ok,
          message: ok
            ? `PUT ${a.path} = ${JSON.stringify(a.value)}`
            : `PUT ${a.path} failed: ${reply?.message ?? state ?? statusCode}`,
        };
      }

      case 'notification': {
        app.handleMessage(pluginId, {
          context: app.selfContext as Context,
          updates: [
            {
              values: [
                {
                  path: `notifications.${a.path}` as Path,
                  value: {
                    state: a.state,
                    method: a.methods ?? ['visual'],
                    message: a.message,
                    timestamp: new Date().toISOString(),
                  },
                },
              ],
            },
          ],
          // notifications use the same path namespace in v1
        } as Parameters<ServerAPI['handleMessage']>[1]);
        return {
          type: 'notification',
          ok: true,
          message: `notification ${a.path} -> ${a.state}`,
        };
      }

      default: {
        // Exhaustiveness guard — phase-2 action types (shell/http/emit) land here.
        const unknown = a as { type?: string };
        return {
          type: unknown.type ?? 'unknown',
          ok: false,
          message: `unsupported action type: ${unknown.type}`,
        };
      }
    }
  } catch (e) {
    return { type: a.type, ok: false, message: String(e) };
  }
}

/** Run a rule's whole batch in order, recording the result on the armed rule. */
export async function runRuleActions(
  armed: ArmedRule,
  app: ServerAPI,
  pluginId: string,
  triggerKind: string
): Promise<RuleRunResult> {
  const actionResults: ActionResult[] = [];
  let ok = true;
  for (const a of armed.def.actions) {
    const r = await runAction(a, app, pluginId);
    actionResults.push(r);
    if (!r.ok) ok = false;
  }
  const result: RuleRunResult = {
    at: new Date().toISOString() as Timestamp,
    ok,
    trigger: triggerKind,
    actionResults,
  };
  armed.lastResult = result;
  app.debug(
    `[rule:${armed.def.name}] fired (${triggerKind}) -> ${ok ? 'ok' : 'FAILED'} (${actionResults.length} action(s))`
  );
  return result;
}

/**
 * Debounce gate in front of {@link runRuleActions}. Returns the run result, or
 * `null` if the fire was suppressed because the rule fired again within
 * `debounceMs`.
 */
export async function maybeFire(
  armed: ArmedRule,
  app: ServerAPI,
  pluginId: string,
  triggerKind: string
): Promise<RuleRunResult | null> {
  const now = Date.now();
  const debounce = armed.def.debounceMs ?? 0;
  if (debounce > 0 && armed.lastFiredMs && now - armed.lastFiredMs < debounce) {
    app.debug(
      `[rule:${armed.def.name}] suppressed by debounce (${now - armed.lastFiredMs}ms < ${debounce}ms)`
    );
    return null;
  }
  armed.lastFiredMs = now;
  return runRuleActions(armed, app, pluginId, triggerKind);
}
