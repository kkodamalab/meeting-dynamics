import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("relay/worker.js", "utf8");
const start = source.indexOf("export class RateLimit");
const RateLimit = new Function(
  source.slice(start).replace("export class RateLimit", "return class RateLimit"),
)();

function fakeLimiter() {
  const rows = new Map();
  const sql = {
    exec(query, ...args) {
      if (query.startsWith("SELECT")) {
        const row = rows.get(args[0]);
        return row ? [{ window: row.window, count: row.count }] : [];
      }
      if (query.startsWith("INSERT")) {
        rows.set(args[0], { window: args[1], count: args[2], updated: args[3] });
        return [];
      }
      if (query.startsWith("DELETE")) {
        for (const [key, row] of rows)
          if (row.updated < args[0]) rows.delete(key);
        return [];
      }
      return [];
    },
  };
  return { limiter: new RateLimit({ storage: { sql } }), rows };
}
const request = (rules) =>
  new Request("https://rate/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rules }),
  });

test("rate limits deny excess requests without consuming other buckets", async () => {
  const { limiter, rows } = fakeLimiter();
  const perIp = { key: "create:ip:hashed", limit: 2, windowMs: 60_000 };
  assert.equal((await limiter.fetch(request([perIp]))).status, 200);
  assert.equal((await limiter.fetch(request([perIp]))).status, 200);
  const denied = await limiter.fetch(request([perIp]));
  assert.equal((await denied.json()).allowed, false);

  const global = { key: "create:global", limit: 10, windowMs: 60_000 };
  const before = rows.get("create:global");
  const mixed = await limiter.fetch(request([perIp, global]));
  assert.equal((await mixed.json()).allowed, false);
  assert.equal(rows.get("create:global"), before);
});

test("rate limiter rejects malformed rules", async () => {
  const { limiter } = fakeLimiter();
  assert.equal(
    (await limiter.fetch(request([{ key: "bad", limit: 0, windowMs: 60_000 }]))).status,
    400,
  );
});
