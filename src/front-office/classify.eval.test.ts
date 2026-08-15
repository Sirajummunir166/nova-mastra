/**
 * L0 classification + language detection — the customer-phrase corpus, ported
 * from nova-ai's inbox evals (evals/inbox/persona.ts [MIRROR] D12 corpus, plus
 * classification phrases scattered through run.ts / closing.ts scenarios).
 *
 * The phrases are the value: they are what real Dakio customers type, in all
 * three registers (Bangla script / Banglish / English), and they are kept
 * verbatim. Assertions are re-anchored from eve's `detectLanguage` /
 * register-selection seams onto our lane's `detectLang` + `classifyL0`.
 *
 * Two SUSPECTED BUG blocks at the bottom are marked `todo` — they encode the
 * behavior classify.ts's own regexes ENUMERATE but cannot deliver. Do not
 * delete them; they go green the day the bugs are fixed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyL0, detectLang } from "./classify.js";

// ---------------------------------------------------------------------------
// Language detection — the D12 mirror corpus (persona.ts Ex1–8, T9–T14).
// The register the reply owes the customer starts with detecting theirs.
// ---------------------------------------------------------------------------

test("Bangla script in → bn detected, high confidence (mirror rule: never switch first)", () => {
  const bn = [
    "এই শাড়িটার দাম কত?", // T12 · Bangla price ask
    "চট্টগ্রামে ডেলিভারি কত দিন লাগবে?", // Ex2 · Bangla script delivery ETA
    "আপনি কি রোবট? নাকি মানুষ?", // T10 · Bangla 'রোবট না মানুষ?'
    "আচ্ছা নিবো। ঠিকানা: বাসা ১২, রোড ৫, মিরপুর ২, ঢাকা। 017XXXXXXXX", // Ex5 · Bangla COD close
  ];
  for (const text of bn) {
    const { detected, conf } = detectLang(text);
    assert.equal(detected, "bn", `"${text}" should detect bn`);
    assert.ok(conf >= 0.9, "script detection is near-certain");
  }
});

test("Banglish in → banglish detected", () => {
  const banglish = [
    "bhaiya ei shirt ta dam koto?", // Ex1 · Banglish price ask
    "eta kemon behavior? 7 din hoye gelo product ashe nai!! taka mar dice apnara. ami consumer court e jabo", // Ex7 · complaint + legal threat
    "joldi lagbe, kalke er moddhe pathate parben?", // T13 · Banglish urgency
  ];
  for (const text of banglish) {
    assert.equal(detectLang(text).detected, "banglish", `"${text}" should detect banglish`);
  }
});

test("English in → en detected", () => {
  const en = [
    "do you have this in any other colours?", // Ex3
    "am I talking to a real person?", // T9
    "is this available in medium?", // T11
    "do you deliver to Sylhet?", // T14
  ];
  for (const text of en) {
    assert.equal(detectLang(text).detected, "en", `"${text}" should detect en`);
  }
});

test(
  "SUSPECTED BUG: common Banglish phrasings the hint lexicon misses read as English",
  { todo: "BANGLISH_HINTS is too thin — these D12 corpus turns detect 'en' at conf 0.7, which is enough for turn.ts to flip lang.pref to English on a Banglish customer (mirror rule broken: Nova switches first)" },
  () => {
    const banglish = [
      "amar order er ki obostha? 3 din age dilam", // Ex4 · Banglish order status
      "apni ki robot? reply eto fast keno 😅", // Ex6 · Banglish 'are you a bot?'
      "achha dekhi pore janai", // Ex8 · Banglish cart-recovery nudge reply
    ];
    for (const text of banglish) {
      assert.equal(detectLang(text).detected, "banglish", `"${text}" should detect banglish`);
    }
  },
);

// ---------------------------------------------------------------------------
// L0 rules — the deterministic rung. ~60% of turns must decide here at zero
// model cost, so every phrase below must classify WITHOUT the resolver.
// ---------------------------------------------------------------------------

test("Banglish price ask decides at L0 as price_q and carries the product text", () => {
  const r = classifyL0("bhaiya ei shirt ta dam koto?");
  assert.ok(r, "must not fall to the resolver");
  assert.equal(r.intent, "price_q");
  assert.equal(r.rung, 0);
  assert.equal(r.entities.productText, "bhaiya ei shirt ta dam koto?");
});

test("stock questions decide at L0", () => {
  for (const text of ["stock ase?", "eta pawa jabe?", "is this available in medium?"]) {
    const r = classifyL0(text);
    assert.ok(r, `"${text}" must not fall to the resolver`);
    assert.equal(r.intent, "stock_q", `"${text}" → stock_q`);
  }
});

test("'available in medium' is a stock question, not a size pick", () => {
  // SIZE_RE would happily grab a bare "m"; the price/stock guard is what keeps
  // a stock question about a size from being read as choosing that size.
  const r = classifyL0("is this available in medium?");
  assert.equal(r?.intent, "stock_q");
});

test("delivery FAQ phrases decide at L0", () => {
  for (const text of ["delivery charge koto?", "courier e kotodin lagbe?"]) {
    assert.equal(classifyL0(text)?.intent, "faq_delivery", `"${text}" → faq_delivery`);
  }
});

test("order-status asks decide at L0", () => {
  for (const text of ["order kothay", "amar order er ki obostha? 3 din age dilam"]) {
    assert.equal(classifyL0(text)?.intent, "order_status_q", `"${text}" → order_status_q`);
  }
});

test("asking for a person decides at L0 as human_ask", () => {
  for (const text of ["manush er sathe kotha bolbo", "admin ke den", "call me please"]) {
    assert.equal(classifyL0(text)?.intent, "human_ask", `"${text}" → human_ask`);
  }
});

test("complaints decide at L0", () => {
  for (const text of ["refund chai", "product ta kharap asche", "wrong product dise"]) {
    assert.equal(classifyL0(text)?.intent, "complaint", `"${text}" → complaint`);
  }
});

test("a discount haggle is discount_ask, not a plain price question", () => {
  const r = classifyL0("last price koto? ektu kom rakhen");
  assert.equal(r?.intent, "discount_ask");
});

test("bare agreements decide at L0 as confirm", () => {
  for (const text of ["ji", "yes", "ok", "confirm koren", "nibo", "sure"]) {
    assert.equal(classifyL0(text)?.intent, "confirm", `"${text}" → confirm`);
  }
});

test("buy intent with a product name is buy_intent carrying the text, not a bare confirm", () => {
  const r = classifyL0("ei panjabi ta nibo");
  assert.equal(r?.intent, "buy_intent");
  assert.equal(r?.entities.productText, "ei panjabi ta nibo");
});

test("rejections decide at L0", () => {
  for (const text of ["na", "no", "lagbe na", "thak"]) {
    assert.equal(classifyL0(text)?.intent, "reject", `"${text}" → reject`);
  }
});

test("greetings decide at L0 — but only short ones; a greeting carrying a real question is the question", () => {
  assert.equal(classifyL0("hi")?.intent, "greeting");
  assert.equal(classifyL0("salam")?.intent, "greeting");
  // The regression select.test.ts fights in the founder lane, refought here:
  // opens like a greeting, but it is a delivery question.
  assert.equal(classifyL0("hi I want to know about your delivery charges please")?.intent, "faq_delivery");
});

test("a BD phone number is phone_give, and an address around it rides along", () => {
  const bare = classifyL0("01712345689");
  assert.equal(bare?.intent, "phone_give");
  assert.equal(bare?.entities.phone, "01712345689");
  assert.equal(bare?.entities.address, undefined, "eleven digits alone are not an address");

  // The common real shape: phone typed inside the address line (Ex5's close).
  const both = classifyL0("বাসা ১২, রোড ৫, মিরপুর ২, ঢাকা 01712345689");
  assert.equal(both?.intent, "phone_give");
  assert.equal(both?.entities.phone, "01712345689");
  assert.equal(both?.entities.address, "বাসা ১২, রোড ৫, মিরপুর ২, ঢাকা");
});

test("size picks decide at L0 and are uppercased", () => {
  assert.deepEqual(classifyL0("M")?.entities, { size: "M", qty: undefined });
  assert.equal(classifyL0("xl")?.entities.size, "XL");
  assert.equal(classifyL0("xl 2 ta")?.entities.qty, 2, "size + qty in one message keeps both");
});

test("quantity picks decide at L0; a bare number only counts when the turn asked for one", () => {
  assert.deepEqual(classifyL0("2 ta")?.entities, { qty: 2 });
  assert.equal(classifyL0("2"), null, "a bare number with no question pending is ambiguous — resolver's job");
  assert.deepEqual(classifyL0("2", { awaiting: "qty" })?.entities, { qty: 2 });
});

test("zone picks decide at L0 for short messages only", () => {
  assert.equal(classifyL0("dhaka")?.intent, "zone_pick");
  assert.equal(classifyL0("savar")?.entities.zone, "savar");
  // A long sentence naming a city is not a zone answer.
  const long = classifyL0("my cousin in dhaka said your products are really nice and good quality");
  assert.notEqual(long?.intent, "zone_pick");
});

test("R8: while a summary is pending, contextual agreement confirms without a forced keyword", () => {
  assert.equal(classifyL0("thik ase", { awaiting: "confirm" })?.intent, "confirm");
  assert.equal(classifyL0("kore den", { awaiting: "confirm" })?.intent, "confirm");
  // …but a rejection still wins over loose agreement words.
  assert.equal(classifyL0("na, thak", { awaiting: "confirm" })?.intent, "reject");
  // …and with no summary pending, loose agreement words never confirm.
  // (Amusing collision, accepted: bare "thik ase" reads as stock_q because
  // "ase" is in STOCK_RE — the load-bearing half is that it is NOT a confirm.)
  assert.notEqual(classifyL0("thik ase")?.intent, "confirm");
});

test("an explicit language switch is classified at L0 (kept off the resolver)", () => {
  for (const text of ["english please", "banglay bolen"]) {
    const r = classifyL0(text);
    assert.equal(r?.intent, "other", `"${text}" classifies at L0`);
    assert.equal(r?.rung, 0);
  }
});

test("rules miss → null, so the resolver (rung 1) gets the turn — never a guess", () => {
  for (const text of ["do you have this in any other colours?", "achha dekhi pore janai"]) {
    assert.equal(classifyL0(text), null, `"${text}" is not L0-decidable`);
  }
});

// ---------------------------------------------------------------------------
// SUSPECTED BUG: the Bangla-script arm of L0 is dead.
//
// JS `\b` is ASCII-word-based; Bangla letters are not word characters, so a
// `\b` on either side of a Bangla alternate NEVER matches. Every phrase below
// is literally enumerated in classify.ts's own regexes (PRICE_RE has কত|দাম,
// CONFIRM_RE has জি|হ্যাঁ, REJECT_RE has না, GREET_RE has আসসালামু, ZONE_RE has
// ঢাকা, ORDER_STATUS_RE has আমার অর্ডার, CONFIRM_LOOSE_RE has ঠিক আছে) — and
// none of them fire. Consequence: every pure-Bangla-script customer turn falls
// to the paid resolver, defeating the "~60% decide at L0" design for exactly
// the customers the Bangla alternates were written for.
// Fix shape (do NOT fix in this unit): drop \b around Bangla alternates or use
// Unicode-aware boundaries (e.g. /(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])/u).
// ---------------------------------------------------------------------------

test(
  "SUSPECTED BUG: Bangla-script phrases the regexes enumerate never decide at L0",
  { todo: "JS \\b never matches adjacent to Bangla letters — the entire Bangla-script arm of every L0 regex is unreachable" },
  () => {
    assert.equal(classifyL0("দাম কত")?.intent, "price_q");
    assert.equal(classifyL0("এই শাড়িটার দাম কত?")?.intent, "price_q");
    assert.equal(classifyL0("জি")?.intent, "confirm");
    assert.equal(classifyL0("হ্যাঁ")?.intent, "confirm");
    assert.equal(classifyL0("না")?.intent, "reject");
    assert.equal(classifyL0("আসসালামু আলাইকুম")?.intent, "greeting");
    assert.equal(classifyL0("ঢাকা")?.intent, "zone_pick");
    assert.equal(classifyL0("আমার অর্ডার কোথায়")?.intent, "order_status_q");
    // The most natural Bangla confirmation, answered to a pending summary —
    // CONFIRM_LOOSE_RE contains this exact string.
    assert.equal(classifyL0("ঠিক আছে", { awaiting: "confirm" })?.intent, "confirm");
  },
);
