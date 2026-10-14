import test from "node:test";
import assert from "node:assert/strict";
import { Room } from "../relay/worker.js";
import { features } from "../src/audio.ts";
test("room accounts stable speech, ambiguity, delay and switching without first-arrival bias", () => {
  const original = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const c = { noiseRms: 0.001, speechRms: 0.02 };
    const people = [1, 2].map((id) => ({
      id,
      connected: true,
      registered: true,
      mic: true,
      lastSample: now,
      vad: id === 1,
      calibration: c,
      ...features(id === 1 ? 0.02 : 0.001, c.noiseRms, c.speechRms),
      talkMs: 0,
      turns: 0,
    }));
    const room = Object.create(Room.prototype);
    room.room = {
      people,
      running: true,
      lastTick: now,
      elapsed: 0,
      active: null,
    };
    const tick = () => {
      now += 100;
      people.forEach((p) => (p.lastSample = now));
      room.advance();
    };
    tick();
    tick();
    assert.equal(people[0].talkMs, 0);
    for (let i = 0; i < 5; i++) tick();
    assert.ok(people[0].talkMs > 0);
    assert.equal(people[1].talkMs, 0);
    const oldMs = people[0].talkMs;
    Object.assign(people[1], features(0.02, c.noiseRms, c.speechRms), {
      vad: true,
    });
    const unknown = room.room.unknownMs;
    for (let i = 0; i < 5; i++) tick();
    assert.equal(people[0].talkMs, oldMs);
    assert.equal(people[1].talkMs, 0);
    assert.equal(room.room.unknownMs - unknown, 500);
    people[1].sampleDelayMs = 900;
    for (let i = 0; i < 3; i++) tick();
    assert.equal(room.room.active, null);
    people[1].sampleDelayMs = 0;
    Object.assign(people[0], features(0.001, c.noiseRms, c.speechRms), {
      vad: false,
    });
    for (let i = 0; i < 7; i++) tick();
    assert.ok(people[1].talkMs > 0);
    assert.equal(people[1].turns, 1);
    assert.equal(
      room.room.elapsed,
      people.reduce((s, p) => s + p.talkMs, 0) +
        (room.room.unknownMs || 0) +
        (room.room.silenceMs || 0),
    );
  } finally {
    Date.now = original;
  }
});
