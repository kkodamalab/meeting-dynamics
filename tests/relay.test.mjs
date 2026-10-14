import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
const endpoint = process.env.TEST_RELAY_URL || "http://127.0.0.1:8787";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate){const end=Date.now()+5000;while(Date.now()<end){if(predicate())return;await pause(20);}assert.fail('Expected relay acknowledgement did not arrive');}
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
  await until(()=>ws.states.length>0||ws.readyState===WebSocket.CLOSED);
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
    send(one, {
      type: "calibration",
      calibration: { noiseRms: 0.001, speechRms: 0.2 },
    });
    send(two, {
      type: "calibration",
      calibration: { noiseRms: 0.001, speechRms: 0.2 },
    });
    send(host, { type: "start" });
    await until(()=>host.states.at(-1)?.running===true);
    for (let i = 0; i < 15; i++) {
      send(one, {
        type: "sample",
        rawRms: 0.2,
        seq: i + 1,
        monotonic: performance.now(),
        mic: true,
        settings: { autoGainControl: false },
      });
      send(two, {
        type: "sample",
        rawRms: 0.001,
        seq: i + 1,
        monotonic: performance.now(),
        mic: true,
      });
      send(host, { type: "tick" });
      await pause(110);
    }
    await pause(150);
    send(one,{type:'sample',rawRms:0.2,seq:16,monotonic:performance.now(),mic:true});
    await until(()=>host.states.at(-1)?.people[0].seq===16);
    send(host, { type: "stop" });
    await until(()=>host.states.at(-1)?.running===false);
    const state = host.states.at(-1);
    assert.equal(state.running, false);
    assert.ok(state.elapsed > 700);
    assert.ok(state.people[0].talkMs > 500);
    assert.equal(state.people[1].talkMs, 0);
    assert.ok(state.people[0].turns >= 1);
    assert.ok(state.people[0].rawRms > 0);
    assert.ok(state.people[0].lastSample > 0);
    assert.equal(state.people[0].seq, 16);
    assert.equal(state.people[0].settings.autoGainControl, false);
    assert.ok(state.unknownMs > 0);
    assert.ok(state.confidence === 0 || state.confidence > 0);
    const before = host.states.at(-1).people[0].seq;
    send(one, { type: "sample", rawRms: 0, seq: 1, mic: true });
    await pause(100);
    send(host, { type: "tick" });
    await pause(100);
    assert.equal(host.states.at(-1).people[0].seq, before);
    assert.equal(two.states.at(-1).people[0].talkMs, state.people[0].talkMs);
    one.close();
    await until(()=>host.states.at(-1)?.people[0].connected===false);
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
