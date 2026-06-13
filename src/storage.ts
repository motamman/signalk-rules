import * as fs from 'fs';
import * as path from 'path';
import { ServerAPI } from '@signalk/server-api';
import { Rule } from './types';

const FILE = 'rules.json';

function rulesPath(app: ServerAPI): string {
  return path.join(app.getDataDirPath(), FILE);
}

/**
 * Load persisted rules from the plugin's data directory. Kept separate from
 * plugin options (like signalk-parquet's webapp-config.json) so the admin
 * Plugin Config form can never overwrite the rule set. Returns [] if absent or
 * unreadable (logged), so a corrupt file never blocks startup.
 */
export function loadRules(app: ServerAPI): Rule[] {
  const file = rulesPath(app);
  try {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.rules) ? parsed.rules : [];
  } catch (e) {
    app.error(`[rules] could not read ${file}: ${e}`);
    return [];
  }
}

/** Persist rules atomically (write temp + rename) to avoid a torn file. */
export function saveRules(app: ServerAPI, rules: Rule[]): void {
  const file = rulesPath(app);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ rules }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
