/**
 * Nova job scheduling — cron-in-IANA-timezone occurrence math (Phase 05).
 *
 * A TypeScript mirror of dakio-api's `src/lib/novaCron.js` (same algorithm,
 * same deliberate scope cut: dom/month must be literal '*'). Duplicated
 * rather than shared because nova-ai and dakio-api are separate repos with
 * separate deploys and no shared package — DemoStore needs this so its
 * in-memory job engine exercises real tz math (the same three IANA zones as
 * the seeded demo tenants) without a live Dakio backend. Keep the two files
 * in sync if the cadence vocabulary ever grows; both carry their own
 * DST-vector tests (`evals/jobs/run.ts` here, `novaCron.test.js` there).
 */

const MINUTE_MS = 60_000;

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  dows: Set<number>;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const term of field.split(",")) {
    const stepMatch = term.match(/^(\*|\d+-\d+)\/(\d+)$/);
    if (stepMatch) {
      const [, base, stepStr] = stepMatch;
      const step = Number(stepStr);
      if (!Number.isInteger(step) || step <= 0) throw new Error(`invalid step in cron field '${field}'`);
      const [start, end] = base === "*" ? [min, max] : base.split("-").map(Number);
      for (let v = start; v <= end; v += step) values.add(v);
      continue;
    }
    if (term === "*") {
      for (let v = min; v <= max; v++) values.add(v);
      continue;
    }
    const rangeMatch = term.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start > end) throw new Error(`invalid range '${term}' in cron field '${field}'`);
      for (let v = start; v <= end; v++) values.add(v);
      continue;
    }
    if (/^\d+$/.test(term)) {
      const v = Number(term);
      if (v < min || v > max) throw new Error(`value ${v} out of range [${min},${max}] in cron field '${field}'`);
      values.add(v);
      continue;
    }
    throw new Error(`unparseable cron field term '${term}' in '${field}'`);
  }
  return values;
}

/** Parses Nova's cron subset: 5 space-separated fields, dom/month fixed to '*'. */
export function parseCron(cronStr: string): CronFields {
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`invalid cron '${cronStr}': expected 5 fields (minute hour dom month dow)`);
  }
  const [minute, hour, dom, month, dow] = parts;
  if (dom !== "*" || month !== "*") {
    throw new Error(
      `invalid cron '${cronStr}': day-of-month and month must be '*' — Nova's job kinds never need them`,
    );
  }
  return {
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    dows: parseField(dow, 0, 6), // 0=Sunday..6=Saturday
  };
}

function civilToFakeUtc(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour, minute, 0);
}

function fakeUtcFields(fakeMs: number) {
  const d = new Date(fakeMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

const civilFormatterCache = new Map<string, Intl.DateTimeFormat>();
function civilFormatter(tz: string): Intl.DateTimeFormat {
  let f = civilFormatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    civilFormatterCache.set(tz, f);
  }
  return f;
}

export function localCivilFields(instant: Date, tz: string) {
  const map: Record<string, string> = {};
  for (const p of civilFormatter(tz).formatToParts(instant)) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    civilFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

function tzOffsetMinutesAt(instantMs: number, tz: string): number {
  const f = localCivilFields(new Date(instantMs), tz);
  const asFakeUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return (asFakeUtc - instantMs) / MINUTE_MS;
}

/** Converts a civil local time in `tz` to the real UTC instant it names, or `null` in a DST spring-forward gap. */
export function civilToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date | null {
  let guess = civilToFakeUtc(year, month, day, hour, minute);
  for (let i = 0; i < 4; i++) {
    const offset = tzOffsetMinutesAt(guess, tz);
    const candidate = civilToFakeUtc(year, month, day, hour, minute) - offset * MINUTE_MS;
    if (candidate === guess) break;
    guess = candidate;
  }
  const check = localCivilFields(new Date(guess), tz);
  if (check.year !== year || check.month !== month || check.day !== day || check.hour !== hour || check.minute !== minute) {
    return null;
  }
  return new Date(guess);
}

const MAX_STEPS = 12 * 24 * 60;

/** The most recent occurrence of `cronStr` (in `tz`) at or before `atUtc` — what job-def expansion needs each tick. */
export function lastOccurrenceAtOrBefore(cronStr: string, tz: string, atUtc: Date): Date | null {
  const { minutes, hours, dows } = parseCron(cronStr);
  const atCivil = localCivilFields(atUtc, tz);
  let cursorFake = civilToFakeUtc(atCivil.year, atCivil.month, atCivil.day, atCivil.hour, atCivil.minute);
  for (let i = 0; i < MAX_STEPS; i++) {
    const f = fakeUtcFields(cursorFake);
    if (minutes.has(f.minute) && hours.has(f.hour) && dows.has(f.dow)) {
      const utc = civilToUtc(f.year, f.month, f.day, f.hour, f.minute, tz);
      if (utc && utc.getTime() <= atUtc.getTime()) return utc;
    }
    cursorFake -= MINUTE_MS;
  }
  return null;
}

/** The next occurrence of `cronStr` (in `tz`) strictly after `afterUtc`. Used by tests/diagnostics. */
export function nextOccurrenceAfter(cronStr: string, tz: string, afterUtc: Date): Date | null {
  const { minutes, hours, dows } = parseCron(cronStr);
  const afterCivil = localCivilFields(afterUtc, tz);
  let cursorFake =
    civilToFakeUtc(afterCivil.year, afterCivil.month, afterCivil.day, afterCivil.hour, afterCivil.minute) + MINUTE_MS;
  for (let i = 0; i < MAX_STEPS; i++) {
    const f = fakeUtcFields(cursorFake);
    if (minutes.has(f.minute) && hours.has(f.hour) && dows.has(f.dow)) {
      const utc = civilToUtc(f.year, f.month, f.day, f.hour, f.minute, tz);
      if (utc && utc.getTime() > afterUtc.getTime()) return utc;
    }
    cursorFake += MINUTE_MS;
  }
  return null;
}
