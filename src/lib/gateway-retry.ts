/**
 * Some gateway providers (zai in particular) throw transient 503s
 * ("Service temporarily unavailable") with no fallback providers configured,
 * which surfaces to a customer as a dead turn. Retry the model call a couple
 * of times before giving up; anything that is not a transient upstream error
 * rethrows immediately.
 *
 * Note what this does NOT do: it cannot bound the call it wraps. `call()` owns
 * its own timeout (the store client's `DakioTimeoutError`, the gateway SDK's
 * own), and a `call()` that never settles makes this function never settle
 * either — retries around an unbounded operation are still unbounded. The
 * optional `deadlineMs` bounds the part this function does own: how long it
 * keeps SPENDING on further attempts and backoff sleeps once the budget is up.
 */

const TRANSIENT = /temporarily unavailable|503|overloaded|rate.?limit|ECONNRESET|fetch failed/i;

export interface GatewayRetryOptions {
  /**
   * Stop starting new attempts once this many ms have elapsed since the first
   * one. Omitted ⇒ no budget, the original behaviour: every attempt in the
   * ladder is made however long they take. Pass it wherever a caller has a
   * deadline of its own (a lease, a request timeout) that the retry ladder
   * must not outlive.
   */
  deadlineMs?: number;
}

export async function withGatewayRetry<T>(
  call: () => Promise<T>,
  attempts = 3,
  opts: GatewayRetryOptions = {},
): Promise<T> {
  const startedAt = Date.now();
  const budgetSpent = (): boolean =>
    opts.deadlineMs !== undefined && Date.now() - startedAt >= opts.deadlineMs;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await call();
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT.test(err instanceof Error ? err.message : String(err))) throw err;
      if (budgetSpent()) break;
      const wait = 800 * (i + 1);
      // Never sleep past the budget — waiting out a deadline just to give up
      // is the slowest possible way to fail.
      const remaining =
        opts.deadlineMs === undefined ? wait : Math.min(wait, opts.deadlineMs - (Date.now() - startedAt));
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, remaining));
      if (budgetSpent()) break;
    }
  }
  throw lastErr;
}
