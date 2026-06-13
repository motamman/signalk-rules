# signalk-rules

Declarative automation for [Signal K](https://signalk.org/).

> **IF** a path condition is met · **WHEN** a schedule fires · **THEN** run one or more actions (a "batch").

A single, approachable rules table — simpler than Node-RED, more complete than the
scattered point plugins (`signalk-trigger` is IF without THEN; `signalk-scheduler`
is WHEN+THEN without IF). Rules are plain JSON: scannable, diff-able, backup-able.

## Status

**MVP / phase 1.** Beta.

- **Triggers:** `condition` — a structured group of path tests (path · operator · value),
  combined with **ALL** (AND) or **ANY** (OR), with rising/falling/always edge detection;
  and `schedule` — clock time + days, or sunrise/sunset with an offset.
- **Actions:** `put` (Signal K PUT via `putSelfPath`) and `notification` (raise a Signal K
  notification). Executed as an ordered batch.
- **Management:** a rules-table webapp under **Webapps → Rules**, backed by a REST API.

Deliberately **not** in phase 1: `shell` / `http` actions (RCE/SSRF surface — gated behind
a safety flag later), `event` rule-chaining, and sustained-for timers beyond simple debounce.

## How it works

Conditions use [`json-rules-engine`](https://github.com/CacheControl/json-rules-engine):
each test is a `{ fact, operator, value }` leaf where the **fact is a Signal K path**, fed the
current value at evaluation time. The webapp detects each path's data type and offers the
matching operators (numeric `> < =`, boolean `is true/false`, string `contains`, position
`within radius`), so rules are built without typing any expression syntax.

Each rule is armed on plugin start (and whenever rules change via the API):

- **condition** rules subscribe to the delta stream for only the paths they reference,
  re-run the engine on each change, and fire on the configured edge. `notifications.*`
  deltas are skipped to avoid feedback loops. A per-rule `debounceMs` suppresses re-firing.
- **schedule** rules install a `node-cron` job. Sunrise/sunset times are computed from the
  vessel's `navigation.position` (via `suncalc`) plus an offset, and recomputed daily.

When a rule fires, its `actions` run in order and the result is recorded as the rule's
"last fired" / "last result". Rules persist to `rules.json` in the plugin's data directory
(not plugin options), so the admin Plugin Config form never overwrites them.

## Rule shape

```jsonc
{
  "id": "uuid",
  "name": "Shallow water alarm",
  "enabled": true,
  "trigger": {
    "kind": "condition",
    "conditions": {
      "all": [
        { "fact": "environment.depth.belowKeel", "operator": "lessThan", "value": 2 }
      ]
    },
    "edge": "rising"
  },
  "debounceMs": 5000,
  "actions": [
    { "type": "notification", "path": "environment.depth.belowKeel",
      "state": "alarm", "message": "Shallow!" }
  ]
}
```

## Install (development)

```bash
npm install      # restores node_modules
npm run build    # compiles src/ -> dist/
# then install into your Signal K server (npm install <this dir>) and enable the plugin
```

`node_modules/` and `dist/` are git-ignored — `npm install` and `npm run build` regenerate them.

## License

MIT © Maurice Tamman
