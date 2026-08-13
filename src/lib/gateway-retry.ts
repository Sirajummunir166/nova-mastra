/**
 * Some gateway providers (zai in particular) throw transient 503s
 * ("Service temporarily unavailable") with no fallback providers configured,
 * which surfaces to a customer as a dead turn. Retry the model call a couple
 * of times before giving up; anything that is not a transient upstream error
 * rethrows immediately.
 */

const TRANSIENT = /temporarily unavailable|503|overloaded|rate.?limit|ECONNRESET|fetch failed/i;

export async function withGatewayRetry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await call();
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT.test(err instanceof Error ? err.message : String(err))) throw err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}
