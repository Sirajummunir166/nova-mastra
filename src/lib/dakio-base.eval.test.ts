/**
 * The scheme-less base URL, pinned.
 *
 * This is a config bug that costs a whole deployment and tells you almost
 * nothing while it does it. Measured on the live Railway instance:
 * `DAKIO_API_URL=dakio-api-production.up.railway.app` — no scheme, because
 * that is exactly what a hosting dashboard shows you and exactly what you
 * paste. Every store read then died with
 *
 *   TypeError: Invalid URL
 *   input: "dakio-api-production.up.railway.app/api/v1/inbox/cases/…"
 *
 * which names neither the variable at fault nor the fix. Nothing worked: no
 * pulse, no customer turn, no job could resolve a tenant.
 *
 * A normalizer existed for this and was never imported by anything — dead
 * code shipped alongside the bug it was written to prevent. So this file pins
 * BOTH halves: that the helper is right, and that the three production
 * callers actually use it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dakioBaseUrl } from "./dakio-base.js";

function withUrl<T>(value: string | undefined, body: () => T): T {
  const saved = process.env.DAKIO_API_URL;
  if (value === undefined) delete process.env.DAKIO_API_URL;
  else process.env.DAKIO_API_URL = value;
  try {
    return body();
  } finally {
    if (saved === undefined) delete process.env.DAKIO_API_URL;
    else process.env.DAKIO_API_URL = saved;
  }
}

test("a bare host from a hosting dashboard becomes a usable https URL", () => {
  withUrl("dakio-api-production.up.railway.app", () => {
    assert.equal(dakioBaseUrl(), "https://dakio-api-production.up.railway.app");
  });
  // And the result is actually parseable, which is the property that failed.
  withUrl("dakio-api-production.up.railway.app", () => {
    assert.doesNotThrow(() => new URL(`${dakioBaseUrl()}/api/v1/store/profile`));
  });
});

test("an explicit scheme is never rewritten", () => {
  for (const url of ["https://api.example.com", "http://api.example.com"]) {
    withUrl(url, () => assert.equal(dakioBaseUrl(), url));
  }
});

test("a bare localhost means local dev over http, not https", () => {
  // Getting this wrong breaks every developer's machine to fix production.
  for (const [input, expected] of [
    ["localhost:5001", "http://localhost:5001"],
    ["127.0.0.1:5001", "http://127.0.0.1:5001"],
  ] as const) {
    withUrl(input, () => assert.equal(dakioBaseUrl(), expected));
  }
});

test("a trailing slash is dropped so callers can always concatenate /api/...", () => {
  withUrl("https://api.example.com/", () => {
    assert.equal(dakioBaseUrl(), "https://api.example.com");
    assert.equal(`${dakioBaseUrl()}/api/v1/store/profile`, "https://api.example.com/api/v1/store/profile");
  });
});

test("an unset variable throws rather than producing a URL against nothing", () => {
  withUrl(undefined, () => assert.throws(() => dakioBaseUrl(), /DAKIO_API_URL is not set/));
  withUrl("   ", () => assert.throws(() => dakioBaseUrl(), /DAKIO_API_URL is not set/));
});

test("the production callers USE the helper — a normalizer nothing imports is not a fix", () => {
  // The actual defect was not a missing normalizer. It was a normalizer that
  // existed, was correct, and was imported by zero files while the live
  // instance failed every request. Assert on the call sites, because the
  // behaviour tests above all passed while production was down.
  for (const file of ["../store/fleet.ts", "../store/tenants.ts", "../store/resolve.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /dakioBaseUrl\(\)/, `${file} must resolve the base URL through the helper`);
    const rawReads = source.match(/process\.env\.DAKIO_API_URL/g) ?? [];
    // fleet.ts keeps ONE raw read: "is it configured at all", which must stay
    // a null-check rather than becoming a throw.
    assert.ok(rawReads.length <= 1, `${file} still reads DAKIO_API_URL raw ${rawReads.length} times`);
  }
});
