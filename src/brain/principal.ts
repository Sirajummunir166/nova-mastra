/**
 * The two synthetic principals the brain mints — job sessions and customer
 * conversations — ported from nova-ai `agent/lib/jobs/principal.ts` and
 * `agent/lib/customer/principal.ts`.
 *
 * ── THE ADAPTATION, STATED UP FRONT ─────────────────────────────────────────
 *
 * Both originals returned eve's `SessionAuthContext` (`import type … from
 * "eve/context"`), and the readers (`isCustomerSession`, `customerSessionFacts`,
 * `runs.ts`'s `attr`) took eve's `SessionContext` — a framework object with a
 * `session.auth.{current,initiator}` pair that eve's channel layer populated and
 * eve's tenant-guard hook pinned. None of that exists on Mastra.
 *
 * So the SHAPE is ported and the FRAMEWORK is not: `NovaPrincipal` below is a
 * plain object with eve's four fields and eve's meanings, and `NovaAuth` is the
 * plain `{current, initiator}` pair our own dispatcher constructs and passes
 * explicitly. Everything downstream reads the same field names off the same
 * shape, so the ported logic (including the OR across current/initiator and the
 * string-or-array attribute reader) is unchanged.
 *
 * Why keep eve's field names at all, when nothing forces them? Because these
 * fields are the SECURITY VOCABULARY the rest of the port is written in —
 * `principalType`, `authenticator`, `attributes.storeId` are named in
 * `authority.ts`'s comments, in dakio-api's, and in every incident note about
 * the trust plane. Renaming them would silently disconnect this code from every
 * sentence written about it.
 *
 * ⚠️ WHAT DOES **NOT** HOLD YET IN THIS REPO. Both originals lean on a real
 * enforcement point: "the trust-plane tools (`approve_action`, `reject_action`,
 * `undo_action`, `configure_autonomy`) deny any non-`"user"` principal
 * outright". **nova-mastra has none of those tools today** (`src/tools/` is
 * five read-only store tools), so `principalType` here is currently carried,
 * not enforced. It is set correctly anyway so the guard has the truth to check
 * the day it lands — but do not read the comments below as a description of a
 * live defence in THIS process. Whoever ports the trust plane owes that check;
 * until then, a non-`"user"` principal is denied by there being nothing to deny.
 */

import type { JobKind } from "../store/types.js";

/**
 * eve's principal-type vocabulary, preserved exactly.
 *
 * `"user"` is the only one the trust plane may ever accept (see the header);
 * `"runtime"` is the scheduler, `"customer"` is someone talking to the store.
 * The union is closed on purpose — a fifth kind of actor should be a decision,
 * not a string someone typed.
 */
export type PrincipalType = "user" | "runtime" | "customer";

/**
 * One verified actor. The plain-object stand-in for eve's `SessionAuthContext`.
 *
 * `attributes` is the tenancy carrier and is `readonly`: `attributes.storeId`
 * is the ONLY source of tenancy for a session, so a caller mutating it after
 * the fact would be re-tenanting a live turn.
 */
export interface NovaPrincipal {
  authenticator: string;
  principalId: string;
  principalType: PrincipalType;
  attributes: Readonly<Record<string, string>>;
}

/**
 * The plain stand-in for eve's `SessionAuth`.
 *
 * `initiator` is who opened the session, `current` is who is acting now. eve
 * kept both because they can legitimately differ; the readers below check BOTH
 * for exactly that reason, and the port keeps the distinction rather than
 * flattening it to one principal — flattening would silently change the
 * fail-safe direction documented on `isCustomerSession`.
 */
export interface NovaAuth {
  current?: NovaPrincipal | null;
  initiator?: NovaPrincipal | null;
}

/**
 * The minimal session shape the predicates need — the plain replacement for
 * eve's `SessionContext`/`TenantContext`. Anything carrying an `id` and an
 * `auth` satisfies it, so the dispatcher can pass its own session object
 * without adapting.
 */
export interface NovaSessionContext {
  readonly session: { readonly id: string; readonly auth: NovaAuth };
}

// ---------------------------------------------------------------------------
// The scheduler principal (nova-ai agent/lib/jobs/principal.ts)
// ---------------------------------------------------------------------------

/**
 * The synthetic principal the dispatcher stamps on every job session
 * (Phase 05). Today only the dispatcher and the Phase 05 evals should import
 * this — no tool does, and it should stay that way — but this is a
 * convention, not an enforced boundary: `tenantAppPrincipal` is a plain
 * exported function, importable from anywhere in the codebase like any other.
 *
 * `principalType: "runtime"` (not `"user"`) is load-bearing: the trust-plane
 * tools (`approve_action`, `reject_action`, `undo_action`,
 * `configure_autonomy`) deny any non-`"user"` principal outright (see the
 * `principalType !== "user"` check each of those tools applies). That denial
 * is what actually makes a misused import harmless — it holds regardless of
 * who calls this function or what attributes they pass — NOT the absence of
 * an import path. Deliberately no `role` attribute here either way; don't add
 * one. An earlier version of the trust-plane guard matched the literal
 * string `eve:app`, which this principal's shape doesn't match at all;
 * widening it to `principalType !== "user"` (that phase) is what actually
 * covers a scheduler-minted principal.
 *
 * (Port note: per this file's header, those trust-plane tools do not exist in
 * nova-mastra yet. The paragraph above describes the contract this principal
 * is built to satisfy, and the debt whoever ports them inherits.)
 */
export function tenantAppPrincipal(
  storeId: string,
  jobId?: string,
  jobKind?: JobKind | string,
): NovaPrincipal {
  return {
    authenticator: "nova-scheduler",
    principalId: "nova:scheduler",
    principalType: "runtime",
    // `jobId` rides the auth attributes the same way the customer principal
    // carries `conversationId`: it is how the turn-lifecycle run recorder
    // (brain/runs.ts) can stamp NovaRun.jobId at TURN START — the mid-run
    // job↔run join blueprint 17 R1 requires. The dispatcher's complete-time
    // `sessionId` stamp only lands after the turn settles.
    //
    // `jobKind` rides alongside it for observability: `jobId` identifies WHICH
    // row, but a trace list needs to say WHAT ran — a cuid tells a reader
    // nothing, `night_shift` tells them everything. Nothing authorizes on it;
    // it is a label, and the kind is already the dispatcher's own routing key,
    // so it adds no new trust surface.
    attributes: {
      storeId,
      ...(jobId ? { jobId } : {}),
      ...(jobKind ? { jobKind } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The customer principal (nova-ai agent/lib/customer/principal.ts)
// ---------------------------------------------------------------------------

/**
 * The authenticator string every dynamic resolver keys on. Module 02 turned
 * it into the single switch that selects a register: the customer instruction
 * layer loads when it matches, and the founder layers return `null` when it
 * does — mutually exclusive by construction, so the two prompts can never
 * co-render.
 */
export const INBOX_AUTHENTICATOR = "dakio-inbox";

/**
 * The synthetic principal the customer channel mints for every inbound
 * customer-conversation session (Stage 10 module 01). Shape is canonical
 * (Front Office §2.5): `authenticator: "dakio-inbox"` is what the dynamic
 * customer instruction layer keys on (module 02 — `isCustomerSession` below
 * is that switch, and the founder layers 10–40 return `null` on it so they
 * cannot load for a customer session), and `attributes.storeId` is the ONLY
 * source of tenancy for the session.
 *
 * `principalType: "customer"` (not `"user"`) is load-bearing, same as
 * `tenantAppPrincipal` above: the trust-plane tools deny any non-`"user"`
 * principal outright, so a customer session is structurally denied the trust
 * plane no matter what the transcript says. Deliberately no `role` attribute —
 * the store resolver then resolves the least privileged `"staff"`, never an
 * owner.
 *
 * Tenancy note: `storeId` here is taken from the delivery POST's body, which
 * is legitimate ONLY because the caller (dakio-api's `inboxDelivery.js`) has
 * already been authenticated as dakio-api itself via the HMAC shared secret —
 * dakio-api is the authoritative tenancy system, and the channel mints this
 * principal server-side after that check. The channel never accepts founder
 * JWTs and this function must never be handed a model- or customer-supplied
 * store id.
 */
export function customerPrincipal(
  storeId: string,
  conversationId: string,
  platform: string,
): NovaPrincipal {
  return {
    authenticator: INBOX_AUTHENTICATOR,
    principalId: `inbox:${conversationId}`,
    principalType: "customer",
    attributes: { storeId, conversationId, platform },
  };
}

/**
 * Read one attribute off the verified principal — `current` first, then
 * `initiator`. Never off a tool argument or the transcript.
 *
 * The array branch is not defensive padding: eve's attribute bag typed values
 * as `string | readonly string[]`, several producers wrote single-element
 * arrays, and the port keeps accepting both so a value written by the eve-era
 * side still reads here.
 */
export function principalAttr(auth: NovaAuth, key: string): string | undefined {
  const read = (p: NovaPrincipal | null | undefined): string | undefined => {
    const value = p?.attributes?.[key] as string | readonly string[] | undefined;
    if (typeof value === "string" && value.length > 0) return value;
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) return value[0];
    return undefined;
  };
  return read(auth.current) ?? read(auth.initiator);
}

/**
 * Is this session a customer conversation?
 *
 * Checks BOTH `current` and `initiator`, not just `current` as D1 phrases it.
 * The two are the same principal on every real customer turn (the channel
 * mints one and the tenant-guard hook refuses a session whose current and
 * initiator disagree on tenant), so the OR only differs in the degenerate
 * case — and there it fails the safe way: a session that was EVER a customer
 * session keeps the customer register and stays out of the founder layers.
 * Getting founder content into a customer session is the worst
 * customer-facing failure this module can have; the reverse is a cosmetic bug.
 */
export function isCustomerSession(ctx: NovaSessionContext): boolean {
  const { current, initiator } = ctx.session.auth;
  return (
    current?.authenticator === INBOX_AUTHENTICATOR ||
    initiator?.authenticator === INBOX_AUTHENTICATOR
  );
}

/** What the customer register needs to address the session, beyond the store. */
export interface CustomerSessionFacts {
  conversationId: string;
  platform: string;
}

/**
 * Read the conversation the session is pinned to, straight off the verified
 * principal — never off a tool argument or the transcript. Returns `null` for
 * a non-customer session.
 */
export function customerSessionFacts(ctx: NovaSessionContext): CustomerSessionFacts | null {
  if (!isCustomerSession(ctx)) return null;
  const conversationId = principalAttr(ctx.session.auth, "conversationId");
  if (!conversationId) return null;
  return { conversationId, platform: principalAttr(ctx.session.auth, "platform") ?? "messenger" };
}

/**
 * The store this session is pinned to, or `null`.
 *
 * Replaces nova-ai's `resolveStoreId(ctx)` (`agent/lib/tenant.ts`), which read
 * eve's context and additionally consulted eve's tenant-guard hook state. Here
 * it is exactly what the name says: the `storeId` attribute off the verified
 * principal. The guard-hook half has no equivalent yet and is NOT silently
 * implied — a caller that needs "this session may not change tenant mid-turn"
 * has to enforce it itself until that ports.
 */
export function resolveStoreId(ctx: NovaSessionContext): string | null {
  return principalAttr(ctx.session.auth, "storeId") ?? null;
}
