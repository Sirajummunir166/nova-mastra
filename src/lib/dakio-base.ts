/**
 * One place that resolves DAKIO_API_URL.
 *
 * Hosting dashboards (Railway, Vercel) show service domains WITHOUT a scheme,
 * so `DAKIO_API_URL=dakio-api-production.up.railway.app` is an easy paste —
 * and `fetch()` rejects it with an opaque "Failed to parse URL". Normalize
 * here instead of making every caller get it right: default to https for a
 * bare host, keep an explicit scheme, and drop a trailing slash so callers
 * can always concatenate `/api/...`.
 */

let warned = false;

export function dakioBaseUrl(): string {
  const raw = process.env.DAKIO_API_URL?.trim();
  if (!raw) throw new Error("DAKIO_API_URL is not set");

  let url = raw.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    // localhost/127.0.0.1 without a scheme means local dev over http.
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(url);
    url = `${local ? "http" : "https"}://${url}`;
    if (!warned) {
      warned = true;
      console.warn(`[dakio] DAKIO_API_URL had no scheme — using ${url}. Set the full URL to silence this.`);
    }
  }
  return url;
}
