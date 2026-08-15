/**
 * Selection is the one part of the tool layer that decides on its own, with
 * no model in the loop — so it is the part that can be wrong silently. These
 * cases are the ones that cost something when they break: an opener that
 * drags tools along (pure waste, every session's first turn), and a real
 * question routed to "opener" (a starved turn — the founder gets an answer
 * off the snapshot when they asked for something the snapshot cannot say).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectTools, TOPIC_RULES } from "./select.js";
import { ALL_TOOL_NAMES } from "./store-reads.js";

test("openers get no tools — the snapshot already answers them", () => {
  for (const opener of ["hello", "Hi!", "hey", "salam", "Assalamu alaikum", "good morning", "how are you?", "ki khobor"]) {
    const { tools, reason } = selectTools(opener);
    assert.deepEqual(tools, [], `"${opener}" should attach no tools`);
    assert.equal(reason, "opener");
  }
});

test("a topic beats an opener shape — a greeting that names a topic is not an opener", () => {
  // The regression this ordering exists for: short, opens like a greeting,
  // but it is an orders question and answering it from the snapshot alone
  // would be answering a different question.
  const { tools, reason } = selectTools("how are my orders doing?");
  assert.equal(reason, "topic");
  assert.deepEqual(tools, ["get_orders"]);
});

test("each topic routes to its own tool", () => {
  const cases: Array<[string, string]> = [
    ["which orders are still pending?", "get_orders"],
    ["what needs restocking?", "get_products"],
    ["who are my best customers?", "get_customers"],
    ["how many abandoned carts are open?", "get_abandoned_carts"],
    ["what's my cash position?", "get_finance_overview"],
  ];
  for (const [message, expected] of cases) {
    const { tools, reason } = selectTools(message);
    assert.equal(reason, "topic", `"${message}" should match a topic`);
    assert.deepEqual(tools, [expected], `"${message}" → ${expected}`);
  }
});

test("a question spanning two topics gets both tools, not all of them", () => {
  const { tools, reason } = selectTools("did the low stock on polos cost me any orders?");
  assert.equal(reason, "topic");
  assert.equal(tools.length, 2);
  assert.ok(tools.includes("get_products") && tools.includes("get_orders"));
});

test("a follow-up is selected on its own words", () => {
  // "and the money side?" carries no subject — the point of selecting per
  // turn is that it still routes, without inheriting the last turn's tools.
  const { tools } = selectTools("and the money side?");
  assert.deepEqual(tools, ["get_finance_overview"]);
});

test("an unrecognised question widens to the whole set rather than starving", () => {
  const { tools, reason } = selectTools("should I open a second outlet in Chattogram?");
  assert.equal(reason, "default");
  assert.deepEqual(tools.sort(), [...ALL_TOOL_NAMES].sort());
});

// ── The founder does not only type English ────────────────────────────────
//
// Found by the first real model run, not by this suite: the Banglish check-in
// fell through to `default` and bought five tool schemas, while its English
// twin ("how is my business doing?") is an opener and buys none.

test("a Banglish check-in is an opener, exactly like its English twin", () => {
  for (const message of [
    "ei mash e amar business kemon cholche?",
    "kemon cholche?",
    "business kemon jacche",
    "ki obostha",
    "ব্যবসা কেমন চলছে?",
    "সব কেমন যাচ্ছে?",
  ]) {
    const { tools, reason } = selectTools(message);
    assert.deepEqual(tools, [], `"${message}" should attach no tools`);
    assert.equal(reason, "opener", `"${message}" should be an opener`);
  }
  // The twin, for the record — same cost, same reason.
  assert.equal(selectTools("how is my business doing?").reason, "opener");
});

test("Bangla and Banglish topics route to the same tool as their English twin", () => {
  const cases: Array<[string, string]> = [
    ["ei mash e bikri kemon hoyeche?", "get_orders"],
    ["এই মাসে বিক্রি কেমন?", "get_orders"],
    ["kon ponno restock lagbe?", "get_products"],
    ["কোন পণ্যের স্টক শেষ?", "get_products"],
    ["amar best khodder ke?", "get_customers"],
    ["আমার সেরা ক্রেতা কে?", "get_customers"],
    ["ei mash e koto labh hoyeche?", "get_finance_overview"],
    ["এই মাসে কত লাভ হয়েছে?", "get_finance_overview"],
  ];
  for (const [message, expected] of cases) {
    const { tools, reason } = selectTools(message);
    assert.equal(reason, "topic", `"${message}" should match a topic`);
    assert.deepEqual(tools, [expected], `"${message}" → ${expected}`);
  }
});

test("a topic still beats a check-in when the check-in is in Bangla", () => {
  // The ordering rule, in the other alphabet: this ENDS in "kemon cholche" and
  // is short, but it names orders, so answering it off the snapshot alone
  // would answer a different question.
  const { tools, reason } = selectTools("amar order gulo kemon cholche?");
  assert.equal(reason, "topic");
  assert.deepEqual(tools, ["get_orders"]);
});

test("Bangla topic patterns carry no ASCII word boundary", () => {
  // The regression this guards is not a missing word — it is a REGEX BUG that
  // shipped once already in this migration. `\b` in JavaScript is defined
  // against ASCII `\w` with or without the `u` flag, so wrapping a Bangla term
  // in `\b` produces a pattern that does not mean what it reads like. Assert
  // on the patterns themselves, because a `\b` added here would keep passing
  // the cases above for a while and then quietly stop.
  for (const rule of TOPIC_RULES) {
    if (!rule.bn) continue;
    assert.ok(
      !rule.bn.source.includes("\\b"),
      `Bangla pattern ${rule.bn} must not use \\b — it is ASCII-only in JS`,
    );
  }
  assert.ok(
    TOPIC_RULES.filter((r) => r.bn).length >= 4,
    "most topics should be reachable in Bangla script, not just Banglish",
  );
});

test("the whole set is small — the point of the service", () => {
  assert.ok(ALL_TOOL_NAMES.length <= 8, `${ALL_TOOL_NAMES.length} tools; eve shipped 67 on every call`);
});
