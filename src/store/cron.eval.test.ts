/**
 * The `jobs` eval suite, part 1 — the occurrence engine.
 *
 * ── WHY THIS FILE IS THE ONE THAT MATTERS MOST IN THE SUITE ────────────────
 *
 * Everything else in the brain is checked by something. This module was
 * checked by nothing, and it is the module that decides WHEN Nova wakes up.
 * Get it wrong and there is no error, no failed job, no Sentry event — the
 * morning report simply arrives at 07:00 for six months of the year, or twice
 * one Sunday, or not at all on the day the clocks move. A founder in Dhaka
 * would never notice; a founder in New York would think Nova was unreliable
 * and would be right.
 *
 * `lastOccurrenceAtOrBefore` also produces the **dedupe key**. That makes this
 * file's correctness an idempotency question, not just a punctuality one: if
 * the answer wobbles inside a single due window, the same night's work is
 * claimed twice and the founder gets two morning reports. Section 4 is the
 * one that pins that.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * The lease contract (claim / complete / release / fence / backoff) and
 * per-tenant claiming are already pinned by `job-lease.eval.test.ts` and
 * `isolation.eval.test.ts` — the other halves of the `jobs` gate. This file
 * does not repeat them.
 *
 * ── ABOUT THE TIMEZONES ────────────────────────────────────────────────────
 *
 * The three zones are not decorative. They are the real seeded tenant zones,
 * chosen to span the three behaviours that exist:
 *
 *   Asia/Dhaka          — fixed offset, never moves. The production case.
 *   America/New_York    — DST, and the zone Dakio's own ops sit closest to.
 *   America/Los_Angeles — DST on a different offset, so an off-by-one-hour
 *                         bug cannot hide behind a coincidence.
 *
 * The DST transition days are DISCOVERED by probing, never hard-coded. Hard
 * coding "March 8" makes the test wrong the year a government moves the date —
 * and governments do; Bangladesh itself ran DST in 2009 and dropped it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseCron,
  civilToUtc,
  isValidTimeZone,
  lastOccurrenceAtOrBefore,
  nextOccurrenceAfter,
} from "./cron.js";

const DHAKA = "Asia/Dhaka";
const NEW_YORK = "America/New_York";
const LOS_ANGELES = "America/Los_Angeles";

/** Local wall-clock hour and minute of a real instant, in `tz`. */
function wallClock(instant: Date, tz: string): { hour: number; minute: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { hour: Number(get("hour")), minute: Number(get("minute")), dow: DOW.indexOf(get("weekday")) };
}

/**
 * Find the days in `year` where `tz`'s UTC offset changes, by probing every
 * day at local noon. Noon is chosen because it is never inside a transition
 * gap in any zone that has ever existed.
 *
 * `fromMin`/`toMin` are the CONVENTIONAL UTC offset in minutes — negative west
 * of Greenwich, so New York is −300 in winter and −240 in summer. The sign
 * matters and is easy to get backwards: spring forward makes the offset go
 * UP (−300 → −240), because the clock moves toward UTC. Getting it inverted
 * makes the gap test probe the fall-back day, where 02:30 exists twice rather
 * than not at all — and the test then fails for the right reason with a
 * misleading name.
 */
function findOffsetChanges(year: number, tz: string): Array<{ date: Date; fromMin: number; toMin: number }> {
  const changes: Array<{ date: Date; fromMin: number; toMin: number }> = [];
  let previous: number | null = null;
  for (let day = 0; day < 366; day++) {
    const probe = new Date(Date.UTC(year, 0, 1, 12, 0, 0) + day * 86_400_000);
    if (probe.getUTCFullYear() !== year) break;
    const civil = civilToUtc(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate(), 12, 0, tz);
    if (!civil) continue;
    // `civil` is the UTC instant of local noon, so probe − civil is local − UTC.
    const offset = (probe.getTime() - civil.getTime()) / 60_000;
    if (previous !== null && offset !== previous) changes.push({ date: probe, fromMin: previous, toMin: offset });
    previous = offset;
  }
  return changes;
}

/** Spring forward: the clock jumps ahead, so the UTC offset increases. */
const springForwardOf = (changes: ReturnType<typeof findOffsetChanges>) => changes.find((c) => c.toMin > c.fromMin);
/** Fall back: the clock moves away from UTC, so the offset decreases. */
const fallBackOf = (changes: ReturnType<typeof findOffsetChanges>) => changes.find((c) => c.toMin < c.fromMin);

// ── 1. The cron dialect, and what it refuses ──────────────────────────────
//
// Nova's cron is a deliberate SUBSET: day-of-month and month must be `*`,
// because no Nova job kind is monthly. A parser that quietly accepted
// `0 8 1 * *` and then ignored the `1` would schedule a monthly report to run
// every single day — the worst kind of bug, because it looks like it worked.

test("the cron dialect parses the cadences the job kinds actually use", () => {
  const real: Array<[string, { minutes: number; hours: number; dows: number }]> = [
    ["0 8 * * *", { minutes: 1, hours: 1, dows: 7 }], // morning_report, daily 08:00
    ["0 2 * * *", { minutes: 1, hours: 1, dows: 7 }], // night_ops, daily 02:00
    ["0 9-21 * * *", { minutes: 1, hours: 13, dows: 7 }], // pulse, hourly while awake
    ["0 */4 * * *", { minutes: 1, hours: 6, dows: 7 }], // cart_sweep, every 4h
    ["0 9 * * 1", { minutes: 1, hours: 1, dows: 1 }], // weekly_strategy, Monday 09:00
  ];
  for (const [expr, want] of real) {
    const f = parseCron(expr);
    assert.equal(f.minutes.size, want.minutes, `${expr} minutes`);
    assert.equal(f.hours.size, want.hours, `${expr} hours`);
    assert.equal(f.dows.size, want.dows, `${expr} days-of-week`);
  }
});

test("day-of-month and month are REFUSED, not silently ignored", () => {
  // Accepting these and dropping the field would turn a monthly cadence into a
  // daily one — and nothing downstream would report an error.
  for (const expr of ["0 8 1 * *", "0 8 * 3 *", "0 8 15 6 *"]) {
    assert.throws(() => parseCron(expr), /day-of-month and month must be/, expr);
  }
});

test("malformed cron fails closed rather than scheduling something arbitrary", () => {
  for (const expr of ["", "0 8 * *", "0 8 * * * *", "0 99 * * *", "abc 8 * * *", "0 8 * * 9", "0 */0 * * *", "0 21-9 * * *"]) {
    assert.throws(() => parseCron(expr), `"${expr}" should not parse`);
  }
});

// ── 2. A daily cadence keeps its LOCAL hour across a DST change ───────────
//
// This is the whole promise of storing a timezone with the cadence. "08:00"
// means eight in the morning where the founder lives, in June and in January.
// A naive implementation that adds 86,400,000 ms passes every test written in
// Dhaka and drifts by an hour twice a year everywhere else.

for (const [label, tz, expectedChanges] of [
  ["Dhaka", DHAKA, 0],
  ["New York", NEW_YORK, 2],
  ["Los Angeles", LOS_ANGELES, 2],
] as const) {
  test(`${label}: daily 08:00 stays 08:00 local across a whole year`, () => {
    const changes = findOffsetChanges(2026, tz);
    assert.equal(changes.length, expectedChanges, `${label} should have ${expectedChanges} offset changes in 2026`);

    let cursor = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    let seen = 0;
    // Walk the whole year one occurrence at a time. 370 covers 365 days plus
    // slack, and asserts on EVERY one — the two that matter are unremarkable
    // to look at, which is exactly why they need to be inside the loop.
    for (let i = 0; i < 370; i++) {
      const occurrence = nextOccurrenceAfter("0 8 * * *", tz, cursor);
      assert.ok(occurrence, `${label}: ran out of occurrences after ${seen}`);
      if (occurrence.getUTCFullYear() > 2026) break;
      const { hour, minute } = wallClock(occurrence, tz);
      assert.equal(hour, 8, `${label}: occurrence ${seen} landed at ${hour}:${minute} local`);
      assert.equal(minute, 0);
      seen += 1;
      cursor = occurrence;
    }
    assert.ok(seen >= 360, `${label}: only produced ${seen} occurrences in a year`);
  });
}

test("the DST days themselves are correct, not skipped by the walk", () => {
  // Named separately because the loop above would still pass if the engine
  // silently skipped the transition day entirely — 364 correct occurrences and
  // one missing morning report reads as success at 360.
  for (const tz of [NEW_YORK, LOS_ANGELES]) {
    for (const change of findOffsetChanges(2026, tz)) {
      const dayBefore = new Date(change.date.getTime() - 86_400_000);
      const occurrence = nextOccurrenceAfter("0 8 * * *", tz, dayBefore);
      assert.ok(occurrence, `${tz}: no occurrence around the transition`);
      const { hour } = wallClock(occurrence, tz);
      assert.equal(hour, 8, `${tz}: the transition day's 08:00 landed at ${hour}:00 local`);
      // And it is genuinely the next day, not the same one returned twice.
      assert.ok(
        occurrence.getTime() > dayBefore.getTime() && occurrence.getTime() - dayBefore.getTime() < 2 * 86_400_000,
        `${tz}: transition-day occurrence is not within a day of the probe`,
      );
    }
  }
});

// ── 3. The spring-forward gap ─────────────────────────────────────────────
//
// On the spring-forward day, a local hour does not exist. 02:30 is not a time
// in New York that morning. `civilToUtc` must say so with `null` rather than
// inventing the nearest instant, because "the nearest instant" is how a 02:00
// night_ops job silently becomes a 03:00 one — or worse, how the same job
// resolves to two different instants on two ticks and gets claimed twice.

test("a local time inside the spring-forward gap resolves to null, not to a nearby guess", () => {
  for (const tz of [NEW_YORK, LOS_ANGELES]) {
    const springForward = springForwardOf(findOffsetChanges(2026, tz));
    assert.ok(springForward, `${tz}: no spring-forward transition found in 2026`);
    const d = springForward.date;
    const inGap = civilToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 2, 30, tz);
    assert.equal(inGap, null, `${tz}: 02:30 on the spring-forward day should not exist`);

    // The hours on either side of the gap are real and must still resolve.
    assert.ok(civilToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 1, 30, tz), `${tz}: 01:30 should exist`);
    assert.ok(civilToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 4, 30, tz), `${tz}: 04:30 should exist`);
  }
});

test("Dhaka has no gap to fall into — every hour of every day resolves", () => {
  // The production zone. If this ever fails, the bug is in the engine, not in
  // a government's decision.
  for (let day = 0; day < 365; day += 7) {
    const probe = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000);
    for (const hour of [0, 2, 8, 13, 23]) {
      const at = civilToUtc(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate(), hour, 0, DHAKA);
      assert.ok(at, `Dhaka ${probe.toISOString().slice(0, 10)} ${hour}:00 should exist`);
    }
  }
});

// ── 4. IDEMPOTENCY — the reason this function shapes the dedupe key ───────
//
// The dispatcher expands a job def by asking "what was the last due
// occurrence at or before now?" and using the answer as the dedupe key. Every
// tick inside one due window must therefore get the SAME answer. If it
// wobbles, the same morning report is claimed twice, and the founder is told
// good morning twice.

test("every tick inside one due window agrees on the occurrence — the dedupe key cannot wobble", () => {
  for (const tz of [DHAKA, NEW_YORK, LOS_ANGELES]) {
    // 08:00 local on an ordinary day, then probe across the following hour.
    const base = nextOccurrenceAfter("0 8 * * *", tz, new Date(Date.UTC(2026, 5, 10, 0, 0, 0)));
    assert.ok(base);
    const answers = new Set<number>();
    for (let minute = 0; minute < 60; minute += 3) {
      const at = new Date(base.getTime() + minute * 60_000);
      const last = lastOccurrenceAtOrBefore("0 8 * * *", tz, at);
      assert.ok(last, `${tz}: no last occurrence at +${minute}m`);
      answers.add(last.getTime());
    }
    assert.equal(answers.size, 1, `${tz}: the due window produced ${answers.size} different dedupe keys`);
    assert.equal([...answers][0], base.getTime());
  }
});

test("the wobble check holds across a DST transition too", () => {
  // The window most likely to break it: the hour after 02:00 local on a
  // fall-back day, where one wall-clock hour happens twice.
  for (const tz of [NEW_YORK, LOS_ANGELES]) {
    const fallBack = fallBackOf(findOffsetChanges(2026, tz));
    assert.ok(fallBack, `${tz}: no fall-back transition in 2026`);
    const answers = new Set<number>();
    // Probe real UTC instants straight through the doubled hour.
    const start = new Date(fallBack.date.getTime() - 12 * 3_600_000);
    for (let minute = 0; minute < 24 * 60; minute += 17) {
      const at = new Date(start.getTime() + minute * 60_000);
      const last = lastOccurrenceAtOrBefore("0 2 * * *", tz, at);
      assert.ok(last, `${tz}: no occurrence at ${at.toISOString()}`);
      answers.add(last.getTime());
      // Whatever it answers, it must be a real instant at or before `at`.
      assert.ok(last.getTime() <= at.getTime(), `${tz}: last occurrence is in the future`);
    }
    // Over a 24h walk a daily cadence should resolve to one or two distinct
    // occurrences — never a different answer every probe.
    assert.ok(answers.size <= 2, `${tz}: fall-back day produced ${answers.size} distinct occurrences`);
  }
});

test("last and next never disagree about where an instant sits", () => {
  for (const tz of [DHAKA, NEW_YORK, LOS_ANGELES]) {
    for (const expr of ["0 8 * * *", "0 9-21 * * *", "0 9 * * 1"]) {
      for (let day = 0; day < 365; day += 29) {
        const at = new Date(Date.UTC(2026, 0, 1, 5, 17, 0) + day * 86_400_000);
        const last = lastOccurrenceAtOrBefore(expr, tz, at);
        const next = nextOccurrenceAfter(expr, tz, at);
        assert.ok(last && next, `${tz} ${expr}: missing an occurrence around ${at.toISOString()}`);
        assert.ok(last.getTime() <= at.getTime(), `${tz} ${expr}: last is after the instant`);
        assert.ok(next.getTime() > at.getTime(), `${tz} ${expr}: next is not after the instant`);
        assert.ok(last.getTime() < next.getTime(), `${tz} ${expr}: last is not before next`);
      }
    }
  }
});

// ── 5. Day-of-week survives the timezone ──────────────────────────────────
//
// `weekly_strategy` runs Monday 09:00 local. The day-of-week must be read in
// the founder's zone, not UTC — Monday 09:00 in Los Angeles is Monday 17:00
// UTC, but Monday 00:30 in Dhaka is *Sunday* 18:30 UTC, and an engine that
// matched the UTC weekday would run that one on the wrong day.

test("a weekly cadence lands on the right LOCAL weekday, in every zone", () => {
  for (const tz of [DHAKA, NEW_YORK, LOS_ANGELES]) {
    let cursor = new Date(Date.UTC(2026, 0, 1));
    for (let i = 0; i < 52; i++) {
      const occurrence = nextOccurrenceAfter("0 9 * * 1", tz, cursor);
      assert.ok(occurrence, `${tz}: ran out of weekly occurrences at ${i}`);
      const { dow, hour } = wallClock(occurrence, tz);
      assert.equal(dow, 1, `${tz}: weekly occurrence ${i} landed on local weekday ${dow}, not Monday`);
      assert.equal(hour, 9);
      cursor = occurrence;
    }
  }
});

test("an early-morning weekly cadence is read in local time, not UTC", () => {
  // The case that catches a UTC weekday check: 00:30 Monday in Dhaka is
  // Sunday 18:30 UTC.
  const occurrence = nextOccurrenceAfter("30 0 * * 1", DHAKA, new Date(Date.UTC(2026, 2, 1)));
  assert.ok(occurrence);
  assert.equal(wallClock(occurrence, DHAKA).dow, 1, "should be Monday in Dhaka");
  assert.equal(occurrence.getUTCDay(), 0, "…and Sunday in UTC — which is the point");
});

// ── 6. Timezone validation ────────────────────────────────────────────────

test("a garbage timezone is rejected, and the real ones are accepted", () => {
  for (const bad of ["Not/AZone", "", "UTC+6", "Asia/Dacca_Old", "asia/dhaka "]) {
    assert.equal(isValidTimeZone(bad), false, `"${bad}" should be rejected`);
  }
  for (const good of [DHAKA, NEW_YORK, LOS_ANGELES, "UTC", "Europe/London"]) {
    assert.equal(isValidTimeZone(good), true, `"${good}" should be accepted`);
  }
});
