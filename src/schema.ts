/**
 * The plugin-config form is intentionally empty: rules are created and edited
 * in the Rules webapp (Webapps → Rules), and persisted to a separate file
 * (see storage.ts) — never through this form. This mirrors signalk-parquet,
 * which keeps its path/trigger editing in the webapp rather than the schema.
 */
export const RULES_SCHEMA = {
  type: 'object',
  description: 'Rules are managed in the Rules webapp — open Webapps → Rules. There is nothing to configure here.',
  properties: {},
};
