/**
 * WHICH LANGUAGE NOVA ANSWERS IN — the rule, pinned.
 *
 * ── THE BUG THIS FILE EXISTS FOR ───────────────────────────────────────────
 *
 * `detectLang` has three arms and only two of them are detections:
 *
 *   Bangla script present   -> "bn"        (evidence)
 *   Banglish hint word      -> "banglish"  (evidence)
 *   anything else           -> "en"        (NO EVIDENCE — a fallback)
 *
 * The third arm means "I found no Bangla signal". That is also what a bare
 * product name, an address and a phone number look like — and every product
 * in a Dakio catalogue is named in English. So the old rule, which flipped
 * the reply language whenever the fallback fired, meant ANY customer who
 * named a product started getting English replies mid-order.
 *
 * Reproduced in Studio on a real three-turn conversation:
 *
 *   1. "assalamu alaikum, ei shirt tar dam koto?"  -> banglish, replied bn
 *   2. "Classic Polo T-Shirt ta, black"            -> en,       replied EN
 *   3. "2 ta lagbe, Dhaka te"                      -> banglish, replied bn
 *
 * The old rule also carried a check that COULD NOT FAIL: `conf >= 0.7`,
 * where 0.7 is the only value the "en" arm ever returns. It read like a
 * guard against weak evidence and guarded nothing. Both halves are fixed
 * here, and the cases below are written as conversations rather than as
 * single calls, because the defect only exists across turns.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { detectLang } from "./classify.js";
import { newLiveContext, type NovaLiveContext } from "./state.js";

/**
 * The preference rule from `turn.ts`, applied to one message.
 *
 * Kept as a mirror rather than exported from `turn.ts` because the real one
 * sits inside a 900-line turn that needs a live store, a model and a
 * database to run. The risk of a mirror drifting is real, so the LAST test
 * in this file reads turn.ts and asserts the two agree on the parts that
 * matter.
 */
function applyLanguageRule(ctx: NovaLiveContext, message: string): void {
  const previousDetected = ctx.customer.lang.detected;
  const lang = detectLang(message);
  ctx.customer.lang.detected = lang.detected;
  ctx.customer.lang.conf = lang.conf;
  if (lang.detected !== "en") {
    ctx.customer.lang.bnSignals = (ctx.customer.lang.bnSignals ?? 0) + 1;
  }
  if (/\b(english please|in english|speak english|talk in english)\b/i.test(message)) {
    ctx.customer.lang.pref = "en";
    ctx.customer.lang.lockedByRequest = true;
  } else if (/banglay bolen|বাংলায় বলেন|bangla(?:y|te)? (?:bolen|bolun|likhen)/i.test(message)) {
    ctx.customer.lang.pref = "bn";
    ctx.customer.lang.lockedByRequest = true;
  } else if (!ctx.customer.lang.lockedByRequest && lang.detected !== "en") {
    ctx.customer.lang.pref = "bn";
  } else if (!ctx.customer.lang.lockedByRequest && lang.detected === "en") {
    const neverWroteBangla = (ctx.customer.lang.bnSignals ?? 0) === 0;
    const previousAlsoEnglish = previousDetected === "en";
    if (neverWroteBangla || previousAlsoEnglish) ctx.customer.lang.pref = "en";
  }
}

/** Run a whole conversation, returning the preference after each message. */
function conversation(messages: string[]): { prefs: string[]; ctx: NovaLiveContext } {
  const ctx = newLiveContext("store-x", "conv-x", "chat");
  const prefs = messages.map((m) => {
    applyLanguageRule(ctx, m);
    return ctx.customer.lang.pref;
  });
  return { prefs, ctx };
}

// ── The regression itself ─────────────────────────────────────────────────

test("an English PRODUCT NAME inside a Bangla conversation does not flip the reply language", () => {
  const { prefs } = conversation([
    "assalamu alaikum, ei shirt tar dam koto?",
    "Classic Polo T-Shirt ta, black",
    "2 ta lagbe, Dhaka te",
  ]);
  assert.deepEqual(prefs, ["bn", "bn", "bn"], "turn 2 used to come back 'en' and the customer got an English reply");
});

test("the other hint-less lines a real order requires are equally safe", () => {
  // A customer placing an order types their address and their phone number.
  // Neither carries a Banglish hint word; both used to flip the language.
  for (const line of ["House 14, Road 7, Dhanmondi", "01712345678", "Premium Oxford Shirt White", "XL"]) {
    const { prefs } = conversation(["ei shirt tar dam koto?", line]);
    assert.equal(prefs[1], "bn", `"${line}" must not flip a Bangla conversation to English`);
  }
});

// ── But a genuinely English customer must still be served in English ──────

test("a customer who has never written Bangla is answered in English from the first message", () => {
  // The default preference is bn (Bangladesh-first), so this is the case a
  // naive "always stay bn" fix would break.
  const { prefs } = conversation(["how much is the polo shirt?"]);
  assert.deepEqual(prefs, ["en"]);
});

test("a real switch to English still happens — after two consecutive English turns", () => {
  const { prefs } = conversation([
    "ei shirt tar dam koto?", // bn evidence
    "do you deliver to Chattogram?", // one hint-less line — hold
    "and what is the charge?", // two in a row — a real switch
  ]);
  assert.deepEqual(prefs, ["bn", "bn", "en"]);
});

// ── Explicit requests still win, in both directions ───────────────────────

test("an explicit request locks the language and later detection cannot override it", () => {
  const { prefs, ctx } = conversation([
    "ei shirt tar dam koto?",
    "english please",
    "amar ekta lagbe bhai", // strong Banglish — must NOT unlock
  ]);
  assert.deepEqual(prefs, ["bn", "en", "en"]);
  assert.equal(ctx.customer.lang.lockedByRequest, true);
});

test("a request for Bangla locks it just as hard", () => {
  const { prefs } = conversation(["how much?", "banglay bolen", "what about delivery charge?"]);
  assert.deepEqual(prefs, ["en", "bn", "bn"], "a locked Bangla thread must not drift back to English");
});

// ── The properties the old rule got wrong, stated directly ────────────────

test("'en' from detectLang is a FALLBACK — it carries a constant, not a measurement", () => {
  // This is why `conf >= 0.7` could never fail: 0.7 is the only value this
  // arm returns. Pinned so nobody reintroduces a threshold on it.
  const a = detectLang("Classic Polo T-Shirt");
  const b = detectLang("01712345678");
  assert.equal(a.detected, "en");
  assert.equal(b.detected, "en");
  assert.equal(a.conf, b.conf, "the 'en' confidence is a constant; a threshold on it decides nothing");
});

test("Bangla evidence is counted, so 'never wrote Bangla' is answerable", () => {
  const { ctx } = conversation(["ei shirt tar dam koto?", "Classic Polo T-Shirt ta", "2 ta lagbe"]);
  assert.equal(ctx.customer.lang.bnSignals, 2, "turns 1 and 3 carried Bangla evidence; turn 2 did not");

  const english = conversation(["how much is this?", "and delivery?"]);
  assert.equal(english.ctx.customer.lang.bnSignals ?? 0, 0);
});

test("this file's mirror of the rule matches the one in turn.ts", () => {
  // The cases above run a copy. If the real rule changes and this one does
  // not, every assertion above keeps passing while production drifts — so
  // assert on the source of truth itself.
  const src = readFileSync(new URL("./turn.ts", import.meta.url), "utf8");
  for (const marker of [
    "bnSignals",
    "const neverWroteBangla",
    "const previousAlsoEnglish",
    "previousAlsoEnglish) ctx.customer.lang.pref = \"en\"",
  ]) {
    assert.ok(src.includes(marker), `turn.ts no longer contains \`${marker}\` — this suite is testing a stale copy`);
  }
  // Strip comments before looking for the old threshold — the block above
  // this rule in turn.ts DESCRIBES `conf >= 0.7` in prose, and a naive search
  // finds the explanation and calls it the bug.
  const code = src
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
  assert.ok(
    !/lang\.conf\s*>=/.test(code),
    "turn.ts reintroduced a threshold on the 'en' fallback's constant confidence",
  );
});
