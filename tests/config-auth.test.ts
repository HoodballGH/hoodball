import test from "node:test";
import assert from "node:assert/strict";
import { authorized } from "../lib/config";
test("admin credentials reject empty, short, malformed, and non-ASCII inputs", () => {
  const previous = process.env.HOODBALL_ADMIN_TOKEN;
  try {
    delete process.env.HOODBALL_ADMIN_TOKEN;
    assert.equal(authorized(new Request("http://localhost")), false);
    process.env.HOODBALL_ADMIN_TOKEN = "short";
    assert.equal(authorized(new Request("http://localhost", { headers: { authorization: "Bearer short" } })), false);
    process.env.HOODBALL_ADMIN_TOKEN = "a".repeat(32);
    assert.equal(authorized(new Request("http://localhost", { headers: { authorization: `Bearer ${"a".repeat(32)}` } })), true);
    assert.equal(authorized(new Request("http://localhost", { headers: { authorization: `Bearer ${"é".repeat(32)}` } })), false);
    assert.equal(authorized(new Request("http://localhost", { headers: { authorization: `Bearer ${"b".repeat(32)}` } })), false);
  } finally {
    if (previous === undefined) delete process.env.HOODBALL_ADMIN_TOKEN;
    else process.env.HOODBALL_ADMIN_TOKEN = previous;
  }
});
