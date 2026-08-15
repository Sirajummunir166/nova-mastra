/**
 * THE INSTRUCTION SEAM — the trap the phase E spec named, pinned.
 *
 * `runCustomerTurn` takes the CUSTOMER's words. `inbox_reply` / `followup` /
 * `case_update` are instructions TO a turn. The shortcut — passing the
 * instruction as `message` — is the thing these tests exist to make impossible
 * to reintroduce quietly:
 *
 *   • the classifier sees the CUSTOMER's latest inbound, re-read from the store,
 *     and never Nova's own sentence;
 *   • the directive never enters the thread transcript, never moves the
 *     language preference, and never applies an entity delta;
 *   • the directive reaches the WRITER, fenced, as Nova's own instruction;
 *   • when Nova opens its own mouth the instruction names the move; when the
 *     customer spoke, the deterministic ladder still does;
 *   • shadow writes nothing, and silence is a legitimate outcome.
 *
 * Demo backend, no network. The writer is stubbed so the prompt it receives can
 * be read back — the sentence the customer would have got is otherwise the one
 * thing an end-to-end test cannot see.
 */

import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runCustomerTurn, runInstructedTurn, type TurnInstruction } from "./turn.js";
import { loadContext, resetContext, saveContext } from "./context-store.js";
import { writerAgent } from "./agents.js";
import { resolverAgent } from "./agents.js";
import { storeFor, resetStores } from "../store/resolve.js";

process.env.NOVA_STORE_BACKEND = "demo";

const STORE = "store-aurora";

function demo() {
  return storeFor(STORE) as unknown as {
    seedInboxConversation: (seed: {
      id: string;
      messages?: Array<{ direction: "in" | "out"; actor: string; text: string; id?: string }>;
    }) => unknown;
    seedPromise: (seed: {
      id?: string;
      conversationId?: string | null;
      text: string;
      kind: "follow_up_info";
      status?: "open" | "kept" | "broken" | "released";
    }) => { id: string };
  };
}

function seedThread(convId: string, text: string): void {
  demo().seedInboxConversation({ id: convId, messages: [{ direction: "in", actor: "customer", text }] });
  resetContext(STORE, convId);
}

/** Capture what the writer was asked, and answer with a fixed draft. */
type Generate = typeof writerAgent.generate;
let prompts: string[] = [];
let restore: Array<() => void> = [];

function stubWriter(reply = "drafted"): void {
  const agent = writerAgent as unknown as { generate: Generate };
  const saved = agent.generate;
  agent.generate = (async (messages: Array<{ content: string }>) => {
    prompts.push(messages[0]?.content ?? "");
    return { text: reply } as unknown as Awaited<ReturnType<Generate>>;
  }) as Generate;
  restore.push(() => {
    agent.generate = saved;
  });
}

/** The paid rung. Any call to it in these cases would be a bug, so it explodes. */
function forbidResolver(): void {
  const agent = resolverAgent as unknown as { generate: unknown };
  const saved = agent.generate;
  agent.generate = () => {
    throw new Error("the L1 resolver must not run on a message this thread already absorbed");
  };
  restore.push(() => {
    agent.generate = saved;
  });
}

const instruction = (over: Partial<TurnInstruction> = {}): TurnInstruction => ({
  jobKind: "followup",
  mode: "nba_nudge",
  directive:
    "A follow-up you scheduled on this conversation is due (job job_1). NOBODY IS WAITING ON YOU. " +
    "If there is nothing worth saying now, say nothing.",
  action: "NBA_NUDGE",
  owesReply: false,
  jobId: "job_1",
  ...over,
});

before(() => {
  resetStores();
});
beforeEach(() => {
  process.env.NOVA_STORE_BACKEND = "demo";
  prompts = [];
});
afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
});

// ---------------------------------------------------------------------------
// What gets classified
// ---------------------------------------------------------------------------

test("the CUSTOMER's latest inbound is what gets classified — re-read from the store, never the directive", async () => {
  const convId = "conv-instructed-classify";
  seedThread(convId, "koto dam?");
  stubWriter();

  const result = await runInstructedTurn(STORE, convId, instruction());

  assert.equal(result.instructed?.classifiedInbound, "koto dam?", "the classifier saw the customer, not Nova");
  assert.equal(result.intent, "price_q", "and classified it as the customer's question");
  // The tell-tale of the bug: a directive-as-message turn would classify Nova's
  // own English prose and land on `other`.
  assert.notEqual(result.intent, "other");
});

/**
 * D4 — THIS TEST USED TO BE VACUOUS, and the way it was vacuous is worth
 * keeping written down: it ran the NUDGE lane, where `treatAsCustomerTurn` is
 * false and NOTHING is pushed into `ctx.recent` at all. Passing the directive as
 * the message there still produced an empty customer transcript, so the
 * assertion held while the trap was sprung. The lane that actually writes a
 * customer line is `inbox_reply`, so that is the lane this test drives; the
 * nudge half is kept as the second assertion, where it means "no line", not
 * "the right line".
 */
test("the directive never enters the thread transcript as something the customer said", async () => {
  const convId = "conv-instructed-transcript";
  seedThread(convId, "koto dam?");
  stubWriter();

  await runInstructedTurn(
    STORE,
    convId,
    instruction({ jobKind: "inbox_reply", mode: "inbox_reply", action: "CLARIFY", owesReply: true }),
  );

  const ctx = loadContext(STORE, convId, "chat", 0);
  assert.deepEqual(
    ctx.recent.filter((m) => m.role === "customer").map((m) => m.text),
    ["koto dam?"],
    "the customer line is the CUSTOMER's words — the lane that writes one writes theirs",
  );
  for (const line of ctx.recent) {
    assert.doesNotMatch(line.text, /NOBODY IS WAITING/, "the directive is nowhere in the thread state");
    assert.doesNotMatch(line.text, /Fallback delivery/, "nor is any other sentence Nova wrote to itself");
  }
  assert.doesNotMatch(ctx.conversation.summary, /Fallback delivery/, "nor folded into the memo");

  // And the other lane: when NOVA opens its own mouth there is no customer line
  // to write, so the transcript gains nothing at all.
  const nudged = "conv-instructed-transcript-nudge";
  seedThread(nudged, "koto dam?");
  await runInstructedTurn(STORE, nudged, instruction());
  const nudgeCtx = loadContext(STORE, nudged, "chat", 0);
  assert.deepEqual(
    nudgeCtx.recent.filter((m) => m.role === "customer").map((m) => m.text),
    [],
    "Nova speaking first adds NO customer line",
  );
  for (const line of nudgeCtx.recent) {
    assert.doesNotMatch(line.text, /NOBODY IS WAITING/, "and certainly not the directive");
  }
});

/**
 * D4 — vacuous for the same reason as the transcript test: the nudge lane never
 * runs `detectLang` at all, so the preference could not move whatever text was
 * passed. The `inbox_reply` lane DOES detect language, on the message it was
 * handed — so this drives that lane with a Bangla thread and an English
 * directive, which is exactly the pair the shortcut would get wrong.
 */
test("an English directive does not flip a Bangla thread to English", async () => {
  const convId = "conv-instructed-lang";
  seedThread(convId, "দাম কত?");
  stubWriter();

  await runInstructedTurn(
    STORE,
    convId,
    instruction({ jobKind: "inbox_reply", mode: "inbox_reply", action: "CLARIFY", owesReply: true }),
  );

  const after = loadContext(STORE, convId, "chat", 0).customer.lang;
  assert.equal(after.pref, "bn", "the Bangla message set the preference — not Nova's English directive");
  assert.notEqual(after.detected, "en", "and the English directive is not what was language-detected");

  // The nudge lane on a thread whose preference is already real: it must not
  // move at all, because a directive is never customer speech.
  const nudged = "conv-instructed-lang-nudge";
  seedThread(nudged, "দাম কত?");
  await runCustomerTurn(STORE, nudged, "দাম কত?", { mode: "shadow" });
  assert.equal(loadContext(STORE, nudged, "chat", 0).customer.lang.pref, "bn");
  await runInstructedTurn(STORE, nudged, instruction());
  assert.equal(loadContext(STORE, nudged, "chat", 0).customer.lang.pref, "bn", "the directive is not customer speech");
});

test("a message the thread already absorbed is not re-applied — and does not buy the paid resolver", async () => {
  const convId = "conv-instructed-delta";
  // "2 ta lagbe" carries a QUANTITY. Classified for context, absolutely — but
  // applying its delta on a Nova-initiated turn would void a pending summary
  // and write a "qty corrected" memo for a correction nobody made.
  seedThread(convId, "2 ta lagbe");
  stubWriter();
  forbidResolver();

  const result = await runInstructedTurn(STORE, convId, instruction());

  assert.equal(result.instructed?.classifiedInbound, "2 ta lagbe");
  const ctx = loadContext(STORE, convId, "chat", 0);
  assert.equal(ctx.purchase.qty, undefined, "context only — the turn that answered it already applied the delta");
});

// ---------------------------------------------------------------------------
// What reaches the writer
// ---------------------------------------------------------------------------

test("the directive reaches the writer FENCED, outside the transcript, in Nova's own voice", async () => {
  const convId = "conv-instructed-prompt";
  seedThread(convId, "koto dam?");
  stubWriter();

  await runInstructedTurn(STORE, convId, instruction({ directive: "PAY THE PROMISE prom_7." }));

  const prompt = prompts.at(-1)!;
  assert.match(prompt, /NOVA'S OWN DIRECTIVE/, "it has its own heading");
  assert.match(prompt, /the customer did NOT say any of this/i, "and the boundary is stated in words");
  assert.match(prompt, /PAY THE PROMISE prom_7\./);
  // Order matters: the directive sits AFTER the transcript block and before the
  // ACTION line, so nothing can read it as the last thing the customer typed.
  assert.ok(
    prompt.indexOf("LAST MESSAGES:") < prompt.indexOf("NOVA'S OWN DIRECTIVE"),
    "the transcript is its own block",
  );
  assert.ok(prompt.indexOf("NOVA'S OWN DIRECTIVE") < prompt.indexOf("ACTION:"), "and the directive is not inside it");
});

test("a live customer turn carries NO directive block at all", async () => {
  const convId = "conv-instructed-none";
  seedThread(convId, "hello");
  stubWriter();

  await runCustomerTurn(STORE, convId, "hello", { mode: "shadow" });

  assert.doesNotMatch(prompts.at(-1)!, /NOVA'S OWN DIRECTIVE/);
});

// ---------------------------------------------------------------------------
// Who picks the move
// ---------------------------------------------------------------------------

test("when NOVA speaks first the instruction names the move; the ladder is not consulted", async () => {
  const convId = "conv-instructed-action";
  seedThread(convId, "hello"); // a greeting would make the ladder say GREET
  stubWriter();

  const result = await runInstructedTurn(STORE, convId, instruction());

  assert.equal(result.action, "NBA_NUDGE", "the turn is for the nudge, not for re-greeting a greeting");
  assert.match(prompts.at(-1)!, /ACTION: NBA_NUDGE/);
});

test("an inbox_reply IS a customer turn — the deterministic ladder still decides", async () => {
  const convId = "conv-instructed-ladder";
  seedThread(convId, "hello");
  stubWriter();

  const result = await runInstructedTurn(
    STORE,
    convId,
    instruction({ jobKind: "inbox_reply", mode: "inbox_reply", action: "CLARIFY", owesReply: true }),
  );

  assert.equal(result.action, "GREET", "same builder as the live lane, same move");
  assert.equal(result.instructed?.classifiedInbound, "hello");
});

// ---------------------------------------------------------------------------
// The outcomes only this entry point can produce
// ---------------------------------------------------------------------------

test("a fallback reply for a batch the live lane already answered is a free no-op", async () => {
  const convId = "conv-instructed-d7";
  seedThread(convId, "hello");
  stubWriter();
  await runCustomerTurn(STORE, convId, "hello", { mode: "shadow" });

  const result = await runInstructedTurn(
    STORE,
    convId,
    instruction({ jobKind: "inbox_reply", mode: "inbox_reply", action: "CLARIFY", owesReply: true }),
  );

  assert.equal(result.skipped, "already_answered");
  assert.equal(result.silent, true);
  assert.equal(result.modelCalls, 0, "no model call for work that is already done");
});

test("an inbox_reply on a thread with nothing inbound skips rather than inventing a message", async () => {
  const convId = "conv-instructed-empty";
  demo().seedInboxConversation({ id: convId, messages: [] });
  resetContext(STORE, convId);
  stubWriter();

  const result = await runInstructedTurn(
    STORE,
    convId,
    instruction({ jobKind: "inbox_reply", mode: "inbox_reply", action: "CLARIFY", owesReply: true }),
  );

  assert.equal(result.skipped, "no_inbound");
  assert.equal(result.modelCalls, 0);
});

test("Nova can still speak first on a thread whose inbound cannot be read — with nothing classified", async () => {
  const convId = "conv-instructed-unreadable";
  resetContext(STORE, convId); // never seeded: `getInboxConversation` answers null
  stubWriter();

  const result = await runInstructedTurn(
    STORE,
    convId,
    instruction({ jobKind: "case_update", mode: "case_update", action: "CASE_UPDATE", owesReply: true }),
  );

  assert.equal(result.instructed?.classifiedInbound, null, "nothing to classify is not an excuse to classify the directive");
  assert.equal(result.intent, "other", "the honest floor");
  assert.equal(result.skipped, undefined, "a case update owes the customer news either way");
});

test("a thread a human took over stays silent, instructed or not", async () => {
  const convId = "conv-instructed-locked";
  seedThread(convId, "hello");
  stubWriter();
  const ctx = loadContext(STORE, convId, "chat", 0);
  ctx.conversation.stage = "escalated";
  const { saveContext } = await import("./context-store.js");
  saveContext(ctx);

  const result = await runInstructedTurn(STORE, convId, instruction());

  assert.equal(result.skipped, "thread_locked");
  assert.equal(result.silent, true);
  assert.equal(result.reply, "", "Nova does not talk over the colleague who took the thread");
});

// ---------------------------------------------------------------------------
// D1 — the action label is a closed set, and a job may not name a WRITE
// ---------------------------------------------------------------------------

test("a job payload cannot select the order gate — CREATE_ORDER is refused at the seam", async () => {
  const convId = "conv-instructed-order-gate";
  seedThread(convId, "hello");
  stubWriter();

  await assert.rejects(
    () => runInstructedTurn(STORE, convId, instruction({ action: "CREATE_ORDER" })),
    /CREATE_ORDER/,
    "an instruction saying 'place the order' is not a customer confirming one",
  );
});

test("a job payload cannot select the hand-over gate — ESCALATE is refused at the seam", async () => {
  const convId = "conv-instructed-escalate-gate";
  seedThread(convId, "hello");
  stubWriter();

  await assert.rejects(
    () => runInstructedTurn(STORE, convId, instruction({ action: "ESCALATE" })),
    /ESCALATE/,
    "a job may not hand a live thread to a person by writing a word in a payload",
  );
});

test("an action outside the closed set is refused loudly, and nothing downstream sees it", async () => {
  const convId = "conv-instructed-bogus-action";
  seedThread(convId, "hello");
  stubWriter();

  // The lane whose label is a free `NextAction`: anything else is not an action
  // this file knows, and is refused rather than carried.
  await assert.rejects(
    () =>
      runInstructedTurn(
        STORE,
        convId,
        instruction({ jobKind: "inbox_reply", mode: "inbox_reply", action: "CLARIFY ; DROP TABLE", owesReply: true }),
      ),
    /not a known action/,
  );
  await assert.rejects(() => runInstructedTurn(STORE, convId, instruction({ action: "" })), /no action label/);
  // And a mode nothing in this seam has ever heard of.
  await assert.rejects(
    () => runInstructedTurn(STORE, convId, instruction({ mode: "whatever" as never })),
    /unknown instruction mode/,
  );
  assert.equal(prompts.length, 0, "a refused instruction costs no model call");
});

test("the action label must be the one the instructed mode means", async () => {
  const convId = "conv-instructed-mode-action";
  seedThread(convId, "hello");
  stubWriter();

  // A ladder step is a real `NextAction` — and still not something a job may
  // ask a Nova-speaks-first turn to do.
  await assert.rejects(() => runInstructedTurn(STORE, convId, instruction({ action: "PRESENT_SUMMARY" })), /NBA_NUDGE/);
  // And one instructed label may not be worn by another mode's job.
  await assert.rejects(() => runInstructedTurn(STORE, convId, instruction({ action: "PAY_PROMISE" })), /NBA_NUDGE/);
});

// ---------------------------------------------------------------------------
// D2 — the customer ladder's pending ask survives Nova speaking first
// ---------------------------------------------------------------------------

test("a Nova-speaks-first turn does not clobber the pending ask the customer was left on", async () => {
  const convId = "conv-instructed-pending-ask";
  seedThread(convId, "hello");
  stubWriter();
  // Where the live ladder leaves a thread it has just asked "how many?".
  const primed = loadContext(STORE, convId, "chat", 0);
  primed.conversation.nextAction = "ASK_QTY";
  saveContext(primed);

  await runInstructedTurn(STORE, convId, instruction());

  assert.equal(
    loadContext(STORE, convId, "chat", 0).conversation.nextAction,
    "ASK_QTY",
    "the nudge's own label is not the question the customer is answering",
  );

  // The consequence, measured end to end: the customer answers the ask with a
  // bare number. That is L0-classifiable ONLY while the thread remembers what it
  // asked — otherwise the turn falls through to the paid resolver with no idea
  // what "2" means.
  forbidResolver();
  const next = await runCustomerTurn(STORE, convId, "2", { mode: "shadow" });
  assert.equal(next.rung, 0, "the bare answer still resolves on the free rung");
  assert.equal(next.intent, "qty_pick");
  assert.equal(loadContext(STORE, convId, "chat", 0).purchase.qty, 2, "and it is read as the quantity it is");
});

// ---------------------------------------------------------------------------
// D3 — a promise is paid on the thread it is owed on, or not at all
// ---------------------------------------------------------------------------

const promiseInstruction = (over: Partial<TurnInstruction> = {}): TurnInstruction =>
  instruction({
    jobKind: "followup",
    mode: "promise",
    action: "PAY_PROMISE",
    owesReply: true,
    directive: "A promise you made on this conversation is coming due (promise prm_x).",
    ...over,
  });

test("a promise owed on ANOTHER thread is never paid into this one", async () => {
  const owed = "conv-instructed-promise-a";
  const other = "conv-instructed-promise-b";
  seedThread(owed, "kal janaben?");
  seedThread(other, "koto dam?");
  demo().seedPromise({ id: "prm-owed-a", conversationId: owed, text: "kal janabo", kind: "follow_up_info" });
  stubWriter();

  await assert.rejects(
    () => runInstructedTurn(STORE, other, promiseInstruction({ promiseId: "prm-owed-a" })),
    /prm-owed-a/,
    "the row names conversation A; paying it into B is the failure the guard rail exists for",
  );
  assert.equal(prompts.length, 0, "and it costs no model call to refuse");
});

test("a promise the router already verified is enforced against the thread it names", async () => {
  const convId = "conv-instructed-promise-verified";
  seedThread(convId, "koto dam?");
  stubWriter();

  // The contract the router owes this seam: the ROW, not the id. Nothing is
  // seeded in the store here — the object itself is enough to refuse on.
  await assert.rejects(
    () =>
      runInstructedTurn(
        STORE,
        convId,
        promiseInstruction({
          promiseId: "prm-elsewhere",
          promise: { id: "prm-elsewhere", conversationId: "conv-somewhere-else" },
        }),
      ),
    /prm-elsewhere/,
  );

  // …and the same object naming THIS thread runs.
  const ok = await runInstructedTurn(
    STORE,
    convId,
    promiseInstruction({ promiseId: "prm-here", promise: { id: "prm-here", conversationId: convId } }),
  );
  assert.equal(ok.action, "PAY_PROMISE");
});

test("a promise-mode instruction with no promise at all is refused", async () => {
  const convId = "conv-instructed-promise-idless";
  seedThread(convId, "koto dam?");
  stubWriter();

  await assert.rejects(
    () => runInstructedTurn(STORE, convId, promiseInstruction({ promiseId: undefined })),
    /promise/i,
    "'pay off the promise' with no promise names no debt on any thread",
  );
});

test("a promise owed on THIS thread is paid", async () => {
  const convId = "conv-instructed-promise-here";
  seedThread(convId, "koto dam?");
  demo().seedPromise({ id: "prm-here-1", conversationId: convId, text: "kal janabo", kind: "follow_up_info" });
  stubWriter();

  const result = await runInstructedTurn(STORE, convId, promiseInstruction({ promiseId: "prm-here-1" }));

  assert.equal(result.action, "PAY_PROMISE");
  assert.equal(result.instructed?.classifiedInbound, "koto dam?");
});

// ---------------------------------------------------------------------------
// D5 — the one fact that buys silence: what the customer already said
// ---------------------------------------------------------------------------

test("the customer's re-read inbound reaches the writer, attributed to them, without becoming the turn", async () => {
  const convId = "conv-instructed-reread";
  // The thread state has NOT absorbed this line (a fresh context, a rolled
  // epoch, a message that arrived after the nudge was booked) — so the
  // transcript block cannot carry it, and the writer would nudge blind.
  seedThread(convId, "ordered ta cancel korte chai");
  stubWriter();

  const result = await runInstructedTurn(STORE, convId, instruction());

  const prompt = prompts.at(-1)!;
  assert.match(prompt, /ordered ta cancel korte chai/, "the writer can see what the customer already said");
  assert.match(prompt, /CUSTOMER'S LATEST MESSAGE/, "under its own heading, attributed to the customer");
  assert.ok(
    prompt.indexOf("LAST MESSAGES:") < prompt.indexOf("CUSTOMER'S LATEST MESSAGE"),
    "outside the transcript block",
  );
  assert.ok(
    prompt.indexOf("CUSTOMER'S LATEST MESSAGE") < prompt.indexOf("NOVA'S OWN DIRECTIVE"),
    "and above Nova's own words, which stay clearly separate",
  );
  // It is CONTEXT, not the turn: nothing about the move or the thread changed.
  assert.equal(result.action, "NBA_NUDGE", "the instruction still names the move");
  const ctx = loadContext(STORE, convId, "chat", 0);
  assert.deepEqual(ctx.recent.filter((m) => m.role === "customer"), [], "and it did not become a customer turn");
});

// ---------------------------------------------------------------------------
// D6 — the message IDS the job carried are what "already answered" means
// ---------------------------------------------------------------------------

test("a second, distinct message is answered even when the customer repeated themselves word for word", async () => {
  const convId = "conv-instructed-ids";
  demo().seedInboxConversation({
    id: convId,
    messages: [{ direction: "in", actor: "customer", text: "hello", id: "m1" }],
  });
  resetContext(STORE, convId);
  stubWriter();
  const reply = (over: Partial<TurnInstruction>) =>
    instruction({ jobKind: "inbox_reply", mode: "inbox_reply", action: "CLARIFY", owesReply: true, ...over });

  const first = await runInstructedTurn(STORE, convId, reply({ messageIds: ["m1"] }));
  assert.equal(first.skipped, undefined, "the first message is answered");

  // The same word, a different message — the customer asked again.
  demo().seedInboxConversation({
    id: convId,
    messages: [
      { direction: "in", actor: "customer", text: "hello", id: "m1" },
      { direction: "in", actor: "customer", text: "hello", id: "m2" },
    ],
  });
  const second = await runInstructedTurn(STORE, convId, reply({ messageIds: ["m2"] }));
  assert.equal(second.skipped, undefined, "a message this thread has never seen is not 'already answered'");
  assert.equal(second.instructed?.classifiedInbound, "hello");

  // A redelivery of the SAME batch still costs nothing.
  const replay = await runInstructedTurn(STORE, convId, reply({ messageIds: ["m2"] }));
  assert.equal(replay.skipped, "already_answered");
  assert.equal(replay.modelCalls, 0);
});

test("shadow is the default, and an instructed turn in shadow writes nothing", async () => {
  const convId = "conv-instructed-shadow";
  seedThread(convId, "hello");
  stubWriter();
  const client = storeFor(STORE) as unknown as {
    listActions: () => Promise<unknown[]>;
    listDecisions: () => Promise<unknown[]>;
  };
  const actions = (await client.listActions()).length;
  const decisions = (await client.listDecisions()).length;

  const result = await runInstructedTurn(STORE, convId, instruction());

  assert.equal(result.mode, "shadow", "no caller reaches a customer-visible write by accident");
  assert.equal((await client.listActions()).length, actions);
  assert.equal((await client.listDecisions()).length, decisions);
});
