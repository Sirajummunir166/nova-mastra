/**
 * What a lane WANTED to do and may not — the shared vocabulary of the two
 * founder-plane event lanes.
 *
 * ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
 *
 * The pulse already has this idea (`CapabilityGap` in `brain/pulse.ts`) and it
 * is the right idea: a lane that meets a remedy it may not perform SURFACES it,
 * naming the verb and the duty it would need, rather than borrowing whichever
 * duty happens to be closest. What these two lanes need is that idea plus ONE
 * kind the pulse never met, so the type is restated here instead of widened
 * over there:
 *
 *   `no_verb` — the act is real, useful, and there is NO VERB IN `ActionType`
 *   for it at all, so there is nothing for a duty to govern and nothing for the
 *   gate to judge. `restock_check` writing what it learned onto a case is
 *   exactly that: dakio-api has `PATCH /cases/:id`, the roster has no row for
 *   "Nova records what it found on a case", and `ActionType` has no verb. It is
 *   the same honesty mechanism as `doorExists: false` and `UNCLAIMED` — say the
 *   hole exists, in the code, where the next author trips over it.
 *
 * The other two kinds are the pulse's, unchanged in meaning so a reader who
 * knows one knows both:
 *
 *   `out_of_lane`      — a real duty governs the verb; another lane holds it
 *                        (or no lane does). Fixed by a REGISTRY edit, or by the
 *                        lane that holds it doing the work. Often it is not a
 *                        defect at all but DIVISION OF LABOUR, and the reason
 *                        string has to say which — see doc 07 B2, where one
 *                        cart worked by two lanes is how a customer gets nudged
 *                        twice in one evening.
 *   `ungoverned_verb`  — the verb is shipped and NO duty on the founder's
 *                        roster governs it (`UNGOVERNED_VERBS`). Fixed by a
 *                        ROSTER edit, reviewed, mirrored to dakio-api's
 *                        `NovaDuty` seed. Never by attaching it to a neighbour.
 *
 * Nothing here is enforcement. The bounds are enforced at the ONE seam every
 * lane files through (`gateOrFile` → `assertDutyBinding` → `assertDutyInLane`,
 * both of which THROW). This file is how a lane answers with a founder-readable
 * sentence for the conditions it can see coming, instead of a stack trace.
 */

import type { ActionType, JobKind } from "../../store/types.js";
import { governingDuties, UNGOVERNED_VERBS } from "../../store/duties.js";
import { laneFor } from "../registry.js";

/** A remedy a lane wanted and could not perform. Surfaced, never acted on. */
export interface LaneGap {
  kind: "out_of_lane" | "ungoverned_verb" | "no_verb";
  /** The verb, or a short slug when there is no verb (`kind: "no_verb"`). */
  verb: ActionType | string;
  /** The duty it would need, or `null` when nothing on the roster governs it. */
  wantedDuty: string | null;
  /** Why this lane may not do it, in a sentence a founder can read. */
  reason: string;
}

/**
 * Classify one remedy for one lane, in the order the pulse's `settleFinding`
 * established — and for the same reason: the ORDER is the safety argument.
 *
 *   1. no duty on the roster GOVERNS the verb ⇒ `ungoverned_verb`. There is
 *      nothing to perform it under and nothing may be borrowed.
 *   2. the governing duty is not in THIS LANE's registry entry ⇒
 *      `out_of_lane`. Not a soft warning: the gate is never consulted, because
 *      consulting it would mean the lane had decided it might act.
 *   3. otherwise the lane may file it — `null`, and the caller goes to the gate.
 *
 * `why` is the caller's own sentence about THIS occurrence (the division of
 * labour, the lane that holds the duty), appended to the mechanical part. A
 * gap list whose entries all read the same is a gap list nobody reads.
 */
export function classifyRemedy(
  lane: JobKind,
  verb: ActionType,
  why: string,
): LaneGap | null {
  const governing = governingDuties(verb);
  if (governing.length === 0) {
    return {
      kind: "ungoverned_verb",
      verb,
      wantedDuty: null,
      reason:
        `\`${verb}\` would answer this, and NO duty on Nova's roster governs \`${verb}\` — so there is ` +
        `nothing to perform it under. ${UNGOVERNED_VERBS[verb] ?? ""} ${why}`.trim(),
    };
  }
  const held = laneFor(lane)?.duties ?? [];
  const inLane = governing.find((d) => held.includes(d));
  if (inLane) return null;
  return {
    kind: "out_of_lane",
    verb,
    wantedDuty: governing[0]!,
    reason:
      `\`${verb}\` needs one of [${governing.join(", ")}], and the "${lane}" lane holds ` +
      `[${held.join(", ") || "nothing"}]. ${why}`.trim(),
  };
}

/**
 * The duty key this lane may file `verb` under — the FIRST governing duty its
 * own registry entry claims.
 *
 * Callers use it to build a `GateSpec.dutyRef` that cannot be a laundering
 * choice: the set is `VERB_DUTIES`' (which duties may govern the verb)
 * intersected with the registry's (which duties this lane claims), so the only
 * freedom left is between duties that are BOTH legitimate for the verb and
 * genuinely this lane's. `null` means the lane may not file this verb at all,
 * and {@link classifyRemedy} says which of the two reasons applies.
 */
export function dutyForVerbInLane(lane: JobKind, verb: ActionType): string | null {
  const held = laneFor(lane)?.duties ?? [];
  return governingDuties(verb).find((d) => held.includes(d)) ?? null;
}

/**
 * A read that answered, or the reason it did not — the two lanes' per-read
 * guard.
 *
 * Deliberately NOT imported from `lib/snapshot.ts`'s `DomainRead`, even though
 * the shape is the same. The sense layer is the PULSE's instrument, sized to
 * its domains and its blind-spot comparison; these lanes read a single order or
 * a single case and must not start pulling a store-wide snapshot behind them to
 * borrow a type alias.
 */
export type LaneRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Run one read; a throw becomes a reason instead of taking the lane down. */
export async function readOr<T>(fn: () => Promise<T>): Promise<LaneRead<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Something the lane could not see this run.
 *
 * Same shape and the same purpose as the pulse's `BlindSpot`: a dark READ and a
 * dark FIELD are both blindness, and the dispatcher's `JobReport.blindSpots`
 * carries the keys so "the lane ran and saw everything" and "the lane ran
 * blind" are different rows on a tick report rather than the same one.
 */
export interface LaneBlindSpot {
  /** Stable key: `read:*` for a read that failed, `field:*` for a missing fact. */
  key: string;
  /** What is missing, in one sentence, and what it costs this run. */
  detail: string;
}
