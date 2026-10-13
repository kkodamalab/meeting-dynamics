import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
const endpoint = process.env.TEST_RELAY_URL || "http://127.0.0.1:8787";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect(id, auth) {
  const ws = new WebSocket(`${endpoint.replace("http", "ws")}/room/${id}`, {
    origin: "http://127.0.0.1:5173",
  });
  ws.states = [];
  ws.on("message", (raw) => ws.states.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "auth", ...auth }));
  await pause(100);
  return ws;
}
const send = (ws, msg) => ws.send(JSON.stringify(msg));
test("real relay: isolated sessions, authenticated concurrent seats, synchronization, VAD aggregation and disconnect", async () => {
  const invalid = await fetch(`${endpoint}/sessions`, {
    method: "POST",
    body: JSON.stringify({ count: 11 }),
  });
  assert.equal(invalid.status, 400);
  const denied = await fetch(`${endpoint}/health`, {
    headers: { Origin: "https://untrusted.example" },
  });
  assert.equal(denied.status, 403);
  const r = await fetch(`${endpoint}/sessions`, {
    method: "POST",
    body: JSON.stringify({ count: 2 }),
  });
  assert.equal(r.status, 200);
  const s = await r.json();
  const host = await connect(s.id, { role: "host", key: s.hostKey });
  const one = await connect(s.id, {
    role: "seat",
    seat: 1,
    key: s.seatKeys[0],
  });
  const two = await connect(s.id, {
    role: "seat",
    seat: 2,
    key: s.seatKeys[1],
  });
  try {
    assert.equal(
      host.states.at(-1).people.filter((p) => p.connected).length,
      2,
    );
    assert.ok(!JSON.stringify(host.states).includes(s.hostKey));
    assert.ok(!JSON.stringify(host.states).includes(s.seatKeys[0]));
    const bad = await connect(s.id, { role: "seat", seat: 1, key: "invalid" });
    assert.equal(bad.readyState, WebSocket.CLOSED);
    const duplicate = await connect(s.id, {
      role: "seat",
      seat: 1,
      key: s.seatKeys[0],
    });
    assert.equal(duplicate.readyState, WebSocket.CLOSED);
    send(one, { type: "register", name: 'Alice, "A"', mic: true });
    send(two, { type: "register", name: "Bob", mic: true });
    await pause(120);
    assert.equal(host.states.at(-1).people[0].name, 'Alice, "A"');
    send(one, { type: "start" });
    await pause(100);
    assert.equal(host.states.at(-1).running, false);
    send(host, { type: "start" });
    await pause(100);
    for (let i = 0; i < 8; i++) {
      send(one, { type: "sample", level: 55, vad: true, mic: true });
      send(two, { type: "sample", level: 2, vad: false, mic: true });
      send(host, { type: "tick" });
      await pause(110);
    }
    send(host, { type: "stop" });
    await pause(150);
    const state = host.states.at(-1);
    assert.equal(state.running, false);
    assert.ok(state.elapsed > 700);
    assert.ok(state.people[0].talkMs > 500);
    assert.equal(state.people[1].talkMs, 0);
    assert.ok(state.people[0].turns >= 1);
    assert.equal(two.states.at(-1).people[0].talkMs, state.people[0].talkMs);
    one.close();
    await pause(150);
    assert.equal(host.states.at(-1).people[0].connected, false);
    assert.equal(host.states.at(-1).people[0].mic, false);
    const reconnect = await connect(s.id, {
      role: "seat",
      seat: 1,
      key: s.seatKeys[0],
    });
    assert.equal(reconnect.states.at(-1).people[0].name, 'Alice, "A"');
    reconnect.close();
    const other = await (
      await fetch(`${endpoint}/sessions`, {
        method: "POST",
        body: JSON.stringify({ count: 2 }),
      })
    ).json();
    assert.notEqual(other.id, s.id);
  } finally {
    host.close();
    one.close();
    two.close();
  }
});
