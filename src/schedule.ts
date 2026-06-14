import { Cron } from 'croner';
import * as SunCalc from 'suncalc';
import { ServerAPI } from '@signalk/server-api';
import { ArmedRule, ScheduleTrigger } from './types';
import { maybeFire } from './actions';

const MS_PER_MINUTE = 60_000;
// Recompute sun-relative times just after local midnight each day.
const DAILY_RECOMPUTE_CRON = '5 0 * * *';
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/** Arm a schedule rule, installing its cron job(s) / timers onto `cronTasks`. */
export function armScheduleRule(
  armed: ArmedRule,
  app: ServerAPI,
  pluginId: string
): void {
  const trigger = armed.def.trigger as ScheduleTrigger;
  if (trigger.schedule === 'clock') {
    armClock(armed, app, pluginId, trigger);
  } else {
    armSunEvent(armed, app, pluginId, trigger);
  }
}

function armClock(
  armed: ArmedRule,
  app: ServerAPI,
  pluginId: string,
  trigger: ScheduleTrigger
): void {
  const match = trigger.time ? TIME_RE.exec(trigger.time) : null;
  if (!match) {
    app.error(
      `[rule:${armed.def.name}] invalid clock time '${trigger.time}' (expected HH:MM)`
    );
    return;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    app.error(`[rule:${armed.def.name}] clock time out of range '${trigger.time}'`);
    return;
  }
  const dow =
    trigger.days && trigger.days.length > 0 ? trigger.days.join(',') : '*';
  const expr = `${minute} ${hour} * * ${dow}`;
  try {
    // croner validates the pattern in the constructor (throws if invalid) and
    // starts the job immediately. The returned Cron has .stop() (StoppableTask).
    const task = new Cron(expr, () => {
      void maybeFire(armed, app, pluginId, 'schedule');
    });
    armed.cronTasks.push(task);
    app.debug(`[rule:${armed.def.name}] scheduled clock '${expr}'`);
  } catch (e) {
    app.error(`[rule:${armed.def.name}] invalid cron expression '${expr}': ${e}`);
  }
}

function armSunEvent(
  armed: ArmedRule,
  app: ServerAPI,
  pluginId: string,
  trigger: ScheduleTrigger
): void {
  // Schedule today's event now, then recompute daily (position and the event
  // time both drift, so we recompute rather than assume a fixed offset).
  scheduleNextSun(armed, app, pluginId, trigger);
  const daily = new Cron(DAILY_RECOMPUTE_CRON, () => {
    scheduleNextSun(armed, app, pluginId, trigger);
  });
  armed.cronTasks.push(daily);
  app.debug(`[rule:${armed.def.name}] watching ${trigger.schedule}`);
}

function scheduleNextSun(
  armed: ArmedRule,
  app: ServerAPI,
  pluginId: string,
  trigger: ScheduleTrigger
): void {
  const pos = getPosition(app);
  if (!pos) {
    app.debug(
      `[rule:${armed.def.name}] no navigation.position yet; will retry at next recompute`
    );
    return;
  }
  const now = new Date();
  const eventTime = computeEventTime(trigger, now, pos);
  if (!eventTime) {
    app.debug(
      `[rule:${armed.def.name}] no ${trigger.schedule} today at this latitude`
    );
    return;
  }
  const delayMs = eventTime.getTime() - now.getTime();
  if (delayMs <= 0) {
    // Event already passed for today; the daily recompute will catch tomorrow.
    return;
  }
  const timer = setTimeout(() => {
    void maybeFire(armed, app, pluginId, 'schedule');
  }, delayMs);
  armed.cronTasks.push({ stop: () => clearTimeout(timer) });
  app.debug(
    `[rule:${armed.def.name}] next ${trigger.schedule} fire at ${eventTime.toISOString()}`
  );
}

function computeEventTime(
  trigger: ScheduleTrigger,
  date: Date,
  pos: { latitude: number; longitude: number }
): Date | null {
  const times = SunCalc.getTimes(date, pos.latitude, pos.longitude);
  const base =
    trigger.schedule === 'sunrise' ? times.sunrise : times.sunset;
  // suncalc returns an Invalid Date during polar day/night.
  if (!base || isNaN(base.getTime())) return null;
  return new Date(base.getTime() + (trigger.offsetMinutes ?? 0) * MS_PER_MINUTE);
}

function getPosition(
  app: ServerAPI
): { latitude: number; longitude: number } | null {
  const node = app.getSelfPath('navigation.position');
  const value =
    node && typeof node === 'object' && 'value' in node
      ? (node as { value: unknown }).value
      : node;
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { latitude?: unknown }).latitude === 'number' &&
    typeof (value as { longitude?: unknown }).longitude === 'number'
  ) {
    return value as { latitude: number; longitude: number };
  }
  return null;
}
