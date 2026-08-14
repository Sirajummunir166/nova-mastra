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
import { selectTools } from "./select.js";
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

test("the whole set is small — the point of the service", () => {
  assert.ok(ALL_TOOL_NAMES.length <= 8, `${ALL_TOOL_NAMES.length} tools; eve shipped 67 on every call`);
});
