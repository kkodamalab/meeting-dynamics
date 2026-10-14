import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
const endpoint = "http://127.0.0.1:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate) {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail("Reference relay did not acknowledge expected state");
}
async function socket(session, role, key, seat) {
  const ws = new WebSocket(
    endpoint.replace("http", "ws") + "/room/" + session.id,
    { origin: "http://127.0.0.1:5173" },
  );
  ws.state = null;
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "state") ws.state = m;
    if (m.type === "sync") ws.sync = m;
  });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  ws.send(JSON.stringify({ type: "auth", role, key, seat }));
  await until(() => ws.state);
  return ws;
}
const send = (ws, m) => ws.send(JSON.stringify(m));
test("PC + 2 smartphones calibrate over real WebSockets, align, store, export and invalidate PC recovery", async () => {
  const s = await (
    await fetch(endpoint + "/sessions", {
      method: "POST",
      body: JSON.stringify({ count: 2 }),
    })
  ).json();
  const host = await socket(s, "host", s.hostKey),
    a = await socket(s, "seat", s.seatKeys[0], 1),
    b = await socket(s, "seat", s.seatKeys[1], 2);
  let seq = 0;
  try {
    send(host, { type: "sync", nonce: 123 });
    await until(() => host.sync?.nonce === 123);
    assert.ok(host.sync.serverTime > 0);
    send(host, {
      type: "configure-study",
      mode: "reference",
      layout: {
        positions: [
          { x: 25, y: 50 },
          { x: 75, y: 50 },
        ],
        pcPosition: { x: 50, y: 50 },
      },
    });
    send(a, { type: "register", name: "A", mic: true });
    send(b, { type: "register", name: "B", mic: true });
    send(host, { type: "pc-mic", mic: true });
    await until(() => host.state.research?.mode === "reference");
    const source = (ws, channel, rms) =>
      send(ws, {
        type: channel === "pc" ? "pc-sample" : "sample",
        rawRms: rms,
        mic: true,
        seq,
        acquiredAt: Date.now(),
        monotonic: performance.now(),
        clockUncertainty: 0,
        audioState: "running",
        settings: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
      });
    const run = async (ms, values) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        seq++;
        source(a, "1", values[0]);
        source(b, "2", values[1]);
        source(host, "pc", values[2]);
        send(host, { type: "tick" });
        await sleep(105);
      }
    };
    send(host, { type: "calibration-step", speaker: 0 });
    await run(3500, [0.001, 0.01, 0.001]);
    await until(() => host.state.research.noise.pc);
    send(host, { type: "calibration-step", speaker: 1 });
    await run(5500, [0.06, 0.09, 0.03]);
    await until(() => host.state.research.profiles[1]);
    send(host, { type: "calibration-step", speaker: 2 });
    await run(5500, [0.009, 0.6, 0.03]);
    await until(() => host.state.research.ready);
    send(host, { type: "start" });
    await until(() => host.state.running);
    send(host, { type: "label", speakers: [1], source: "synthetic" });
    await run(1300, [0.06, 0.09, 0.03]);
    send(host, { type: "stop" });
    await until(() => !host.state.running);
    assert.ok(host.state.people[0].talkMs > 400);
    assert.equal(host.state.people[1].talkMs, 0);
    assert.equal(host.state.people.length, 2);
    assert.ok(host.state.research.A.elapsedMs > 500);
    const data = await (
      await fetch(endpoint + "/room/" + s.id + "/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostKey: s.hostKey }),
      })
    ).json();
    assert.equal(data.version, 2);
    assert.ok(data.study.windows.length > 5);
    assert.ok(data.study.windows.some((w) => w.features.pc));
    assert.equal(data.study.dataSource, "synthetic");
    assert.equal(data.study.layout.pcPosition.x, 50);
    const total = data.study.B;
    assert.equal(
      total.elapsedMs,
      total.people.reduce((v, p) => v + p.talkMs, 0) +
        total.unknownMs +
        total.silenceMs +
        total.missingMs +
        total.overlapMs,
    );
    const forbidden = await fetch(endpoint + "/room/" + s.id + "/export", {
      method: "POST",
      body: JSON.stringify({ hostKey: "invalid" }),
    });
    assert.equal(forbidden.status, 403);
    send(host, { type: "pc-mic", mic: false });
    await until(() => host.state.pc.mic === false);
    send(host, { type: "pc-mic", mic: true });
    await until(() => host.state.research.ready === false);
    assert.equal(host.state.research.mode, "reference");
  } finally {
    host.close();
    a.close();
    b.close();
  }
});
