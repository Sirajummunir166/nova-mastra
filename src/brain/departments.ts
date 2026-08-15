/**
 * Job → department (room) attribution — blueprint 17 (rooms live operations).
 *
 * ⚠️ THIS IS A SECOND COPY, AND IT IS DELIBERATELY NOT THE AUTHORITY.
 *
 * dakio-api's `src/lib/novaJobDepartments.js` is the authoritative copy and
 * stays that way: it STAMPS the `NovaJob.department` column at row creation,
 * inside the same transaction that mints the row, and the merchant room feed
 * reads that column. Nothing in nova-mastra writes that column, and nothing
 * here may be treated as deciding a job's room — a claimed job already arrives
 * with its department resolved (`jobOut` sends it; see `NovaJob.department` in
 * `src/store/types.ts`).
 *
 * This copy exists for the two things the brain needs BEFORE a row exists or
 * WITHOUT one:
 *   1. ROUTING — the dispatcher picks a lane by kind, and a lane wants to know
 *      which room it is visiting even when the wire value is absent (an older
 *      row, a DemoStore fixture, a job minted before the column shipped).
 *   2. REGISTRY CHECKS — `registry.ts` asserts each lane's declared department
 *      agrees with this map, so a lane cannot quietly claim to work a room the
 *      server would file it under a different one.
 *
 * Because it is a copy, DRIFT IS THE RISK. The registry eval compares
 * `BrainLane.department` against `departmentForJob` for every non
 * payload-resolved kind, which catches a lane and this map disagreeing; it
 * cannot catch this map and dakio-api's disagreeing. If you change either,
 * change both — the header comment in the dakio-api file says the same.
 *
 * ── Original header, preserved (dakio-api src/lib/novaJobDepartments.js) ────
 *
 * Deterministic and never model-adjustable, the same law as
 * `DEPARTMENT_BY_INTENT` (Stage 10 module 09): the model neither chooses nor
 * overrides which room a scheduled visit belongs to. The map is by job KIND;
 * a `payload.department` set by a trusted producer (e.g. the case drain, which
 * reads the case row's own derived department) wins over the kind default.
 *
 * Cross-department turns (night_ops reads campaigns, purchases and tickets in
 * one session) attribute the JOB to `ceo` — the coordinator lane — while each
 * mutation the turn performs still carries its own real department on the
 * `NovaAction` row. The CEO room shows the visit; every touched room shows the
 * receipts.
 *
 * Server sweeps (promise_sweep, journey_sweep, …) map to null on purpose:
 * they are bookkeeping passes, not room visits, and must never render a
 * "Nova is working here" state.
 */

import { NOVA_DEPARTMENTS, type JobKind, type NovaDepartment } from "../store/types.js";

/**
 * Type-only imports above, on purpose: this module must stay free of runtime
 * dependencies on the store layer so `src/store/backend.ts` can import it
 * (DemoStore plays the SERVER role, so it stamps departments the way dakio-api
 * does) without opening an import cycle.
 *
 * `Partial<Record<JobKind, …>>` rather than `Record`: the absent kinds are the
 * server sweeps, and their absence IS the null. Spelling each one out as
 * `null` would read as "considered, no room", which is true — but it would
 * also invite someone to fill one in.
 */
const DEPARTMENT_BY_JOB_KIND: Partial<Record<JobKind, NovaDepartment>> = {
  // Coordinator lane — whole-store passes run out of the CEO Office.
  morning_report: "ceo",
  pulse: "ceo",
  weekly_strategy: "ceo",
  night_ops: "ceo",
  night_shift: "ceo",
  reflection: "ceo",
  // Department-specific lanes.
  cart_sweep: "sales",
  inbox_reply: "support",
  courier_intervention: "shipping",
  restock_check: "inventory",
  // Stage 11 Phase 3: catalog photo indexing is inventory-room work — the
  // founder sees "Nova is working here" while the catalog drains into memory.
  catalog_vision: "inventory",
  // followup / case_update: resolved in departmentForJob (payload-dependent).
  // Server sweeps: deliberately absent → null.
};

export { DEPARTMENT_BY_JOB_KIND };

/**
 * The kinds whose room CANNOT be read off the kind alone — the payload decides.
 *
 * Exported because the registry eval has to exempt exactly these from its
 * "lane.department agrees with departmentForJob" assertion: for `followup` and
 * `case_update` there is no single right answer at registry time, and asserting
 * one would bake in whichever branch the empty payload happens to take.
 */
export const PAYLOAD_RESOLVED_KINDS: readonly JobKind[] = ["followup", "case_update"];

const DEPARTMENT_SET = new Set<string>(NOVA_DEPARTMENTS);

/**
 * The department a job row is stamped with at creation time.
 * Returns null for kinds that are not room visits (server sweeps).
 */
export function departmentForJob(
  kind: JobKind,
  payload: Record<string, unknown> = {},
): NovaDepartment | null {
  // Port note: the JS original returns `payload.department` unvalidated (any
  // non-empty string). Here it is checked against `NOVA_DEPARTMENTS` before
  // being returned, because this side is TYPED as `NovaDepartment | null` and a
  // payload is wire data — a typo would otherwise become a `NovaDepartment`
  // the type system swears exists and no room renders. The server's own
  // trusted producers all write real departments, so this narrows nothing real.
  const fromPayload = payload?.department;
  if (typeof fromPayload === "string" && DEPARTMENT_SET.has(fromPayload)) {
    return fromPayload as NovaDepartment;
  }
  if (kind === "followup") {
    // A promise-backed follow-up is Nova paying a support debt; a cart/NBA
    // nudge is sales work. `promiseId` is the same discriminator the channel
    // routing keys on.
    return payload && payload.promiseId != null ? "support" : "sales";
  }
  if (kind === "case_update") {
    // The drain stamps payload.department from the case row; a job that
    // somehow lacks it falls to shipping — the department most case kinds
    // derive to — rather than to null, so the visit is never invisible.
    return "shipping";
  }
  return DEPARTMENT_BY_JOB_KIND[kind] ?? null;
}
