# Phase E gate — the brain · MOSTLY DONE, one item left

*(nova-mastra `a998d2c` → `faa4330`; dakio-api `415acaf` → `2feff15`.)*

## What Phase E was

Stand up Nova's 24/7 brain: the heartbeat that claims work per tenant, the
router that decides what each job is, the pulse that watches the business
hourly, and the lanes that act on what it finds.

## Proven

1. **The heartbeat beats.** A Mastra scheduled workflow ticks every minute,
   claims up to ten jobs per tenant **through that tenant's own token** (never
   a fleet-wide credential), routes each by the registry, and settles
   truthfully — verified live: one tick claimed three jobs and completed or
   released all three for the right reasons.
2. **The cost claim is measured, and it is the whole argument.** Four
   consecutive pulse hours cost **0, 0, 1, 0** model calls. A margin falling
   44% → 9% bought the one; an open problem is not news twice. Under eve each
   of those hours was a full ~26K-token agent turn regardless of what it
   found.
3. **Nothing fakes success.** A lane that does not exist releases; a server
   sweep that should never have reached us completes as not-ours rather than
   burning dakio-api's retry ladder; a job with no lease token is refused
   before the work runs; a live turn that already placed an order completes
   with an error instead of releasing into a second order.
4. **The pulse says what it cannot see.** On the seeded store its first pulse
   now reports *"no sales-velocity source for 8 of 8 products… no supplier
   lead time for 8 of 8"* — at zero model cost — where it used to report a
   clean quiet hour. Blindness is reported at three granularities (dark read,
   missing load-bearing field, truncated page) and a quiet pulse is
   unreachable while any of them is untold.
5. **The two lanes that never ran, run.** Proven end to end on the live
   stack: a `restock_wait` case opened through the real API minted a job (the
   producer's first ever), the brain claimed it, and the lane wrote back
   *"NOTHING is on order… There is no date to give"* — **0 model calls**,
   because the honesty fork is arithmetic and a model invited to word a
   supply position it cannot check is how "next week" gets invented.
6. **The model layer is measured, not assumed.** `openai/gpt-5.6-luna` through
   the Vercel AI Gateway, four turns, all four succeeded:

   | | eve (measured) | Nova on Mastra |
   |---|---|---|
   | founder's opener | p50 **26,666** in-tokens | **425** in-tokens |
   | latency | p50 **29.4 s** | **3.6 s** |

   The opener attaches zero tools because the snapshot already answers it —
   that is the whole 63× difference. Asked what the pending orders are worth,
   the model answered *"not available in the current snapshot"* rather than
   inventing a figure. The pulse judge returned valid structured output.
7. **A sixth sense, honestly.** Courier data collected for months is now read
   and watched — with rates refused below an evidence floor, no claim from a
   truncated window, and `onTimeRate` null forever because the schema has no
   promised-delivery date to compute one from.

## What adversarial review changed

Three reviewers, twice, found real defects each time — including several I
would have shipped:

- **The duty bound was self-certifying.** A purchase order filed under
  "Low-stock alerts" instead of "Reorder drafts" skipped that duty's minimum
  level, its door's rules, **and a founder who had explicitly paused reorder
  drafts** — and the test suite shipped that construction as its own fixture.
  Verbs are now bound to the duties that govern them, at the one seam every
  lane passes through.
- **The pulse's headline was an unvalidated model string** — it produced
  *"Sales are down because your courier is losing parcels and ad spend is
  wasted"* in a report whose own footer disclaimed both.
- **One dismissive model call buried a warning forever**, and one failed
  report erased six findings including two critical stock-outs.
- **One tenant's malformed response aborted the whole fleet's minute.**
- And **my own Phase A regression**: three copies of the backend-mode read,
  two of which I had left on the old default, so an unset variable would have
  given the brain live clients for a hard-coded list of fake stores.

## Known issues (accepted, documented — the stopping rule)

1. **`courier_intervention` has not run against a genuinely stuck parcel on
   the live stack** — no order in the dev database has a stale scan. Its
   producer flag stays OFF until one drill on a seeded stuck parcel.
   `NOVA_RESTOCK_CHECK_PRODUCER` is ON and proven; the courier one is not.
2. ~~**The pulse's judge has never met a real model.**~~ **CLOSED.** The
   gateway is reachable and the judge has now been run for real. What it did
   is worth knowing before you read the cost numbers as good news: given a
   margin collapse from **44.4% → 9.1%**, it answered `worthWaking: false` —
   twice, on two independent runs. It is not wrong on its own terms (BDT 25
   gross profit per unit is still positive), but it is the exact judgement the
   founder would want to overrule.

   The code holds up under it. A dismissed department is recorded as
   **dismissed, not announced** (`pulse.ts:963-975`), so the finding returns as
   news after `DISMISSAL_QUIET_MS` (24h) and sooner if it worsens — the
   permanent burial that adversarial review found is genuinely fixed, and this
   run is the first time that fix has been exercised against real model
   judgement rather than a fake. The title stayed derived, never the model's
   prose. **But the tuning question is now open and it is a product question,
   not a bug:** a margin falling four-fifths overnight probably should wake a
   founder, and today only stock-out conditions are `critical` (the one
   severity the judge cannot suppress). Widening that set is a decision about
   how loud Nova is allowed to be, and it is yours.
3. **RTO reduction has data but no verb.** `shipping.rto_reduction` sits
   unclaimed with a reason this work made stale ("nothing reads RTO" — the
   pulse does now). Wiring it needs a roster-governed verb first; nothing in
   the action vocabulary changes which courier a store routes to, and filing
   an existing verb against it would be exactly the laundering the duty
   binding now prevents.
4. **47 of 72 duties remain unclaimed**, each with a written reason. That
   list is the honest capability gap, not a bug — but it is large, and the
   sharpest entry is `support.complaint_resolution`: the ticket desk Nova can
   see is Dakio's, not the merchant's customers'.
5. Smaller: a `no_verb` gap for "record what Nova learned on a case"; the
   pulse's dedupe read still pulls the whole tenant ledger per gated call
   (dakio-api shipped a point lookup the agent does not use yet); one
   structural fix (the list-derived all-blind guard) that no test can fail
   against with exactly six senses.

## What the real model run changed in the code

Running a model found one defect no test had: **the tool router was
English-only**. The founder asked *"ei mash e amar business kemon cholche?"* —
a plain check-in — and it fell through to `default`, buying five tool schemas
to answer a question the snapshot answers by itself. The English twin, "how is
my business doing?", is an opener and costs nothing. Same question, same store,
different price, for no reason but the alphabet.

`select.ts` now carries Bangla and Banglish for every topic, and the Bangla
patterns are kept in a **separate field with no `\b`** — because `\b` in
JavaScript is ASCII-only with or without the `u` flag, which is precisely the
bug that produced the dead Bangla arm in the front-office classifier in Phase
C. One test asserts on the patterns themselves, so re-adding `\b` fails
immediately instead of degrading quietly. That turn now routes as `opener`,
zero tools, and still answers correctly in Bangla script.

## The proxy trap, written down so it costs nobody another hour

Adding `ai-gateway.vercel.sh` to the environment allowlist was **necessary and
not sufficient**. Node 22's global `fetch` ignores `HTTPS_PROXY`, so it went
around the proxy that enforces the allowlist and got:

```
403  Host not in allowlist: ai-gateway.vercel.sh.
     Add this host to your network egress settings to allow access.
```

— while `curl` to the same host in the same second returned `200`. The message
sends you back to the allowlist, which was already correct.

`src/lib/egress.ts` installs undici's `EnvHttpProxyAgent` (what
`NODE_USE_ENV_PROXY=1` does) and `src/boot.ts` makes it a side-effect import so
the ordering is a fact of the module graph rather than a comment. It is a
**no-op when no proxy is set**, so Railway is untouched.

## Not done in Phase E

**The eval suites** (`jobs`, `fleet`, `night`, `duties`) are not yet ported —
they are the phase's formal gate in doc 05, and they are the next unit.

## The ask

Read the known issues, especially #2. Everything else here is verified; the
judgement quality of the brain is not, and cannot be until a model credential
exists.
