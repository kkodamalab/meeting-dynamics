import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { features, newVoice, updateVad } from "../src/audio.ts";
import {
  newStudy,
  ingest,
  align,
  normalizeVector,
  vectorDistance,
  inferReference,
  startStudy,
  processStudy,
  aggregate,
  account,
  evaluate,
  finishCalibration,
  defaults,
} from "../src/study.ts";
function fixture(gain = 10) {
  const study = newStudy(2, "reference");
  study.layout = {
    positions: [
      { x: 20, y: 50 },
      { x: 80, y: 50 },
    ],
    pcPosition: { x: 50, y: 50 },
  };
  study.noise = { 1: 0.0001, 2: 0.0001 * gain, pc: 0.0001 };
  study.profiles = {
    1: { rms: { 1: 0.06, 2: 0.009 * gain, pc: 0.03 } },
    2: { rms: { 1: 0.009, 2: 0.06 * gain, pc: 0.03 } },
  };
  return study;
}
function rows(study, rms, at = 1050) {
  return Object.fromEntries(
    Object.entries(rms).map(([channel, r]) => [
      channel,
      {
        channel,
        seq: 1,
        acquiredAt: at,
        receivedAt: at + 30,
        rawRms: r,
        vad: r > study.noise[channel] * 4,
        ...features(
          r,
          study.noise[channel],
          study.profiles[channel]?.rms[channel] || 0.03,
        ),
        uncertainty: 30,
        healthy: true,
        settings: { autoGainControl: false },
      },
    ]),
  );
}
for (const gain of [1, 10])
  test(`response vectors compensate ${gain}x gain and equal PC distance`, () => {
    const s = fixture(gain);
    for (const id of [1, 2])
      assert.equal(inferReference(rows(s, s.profiles[id].rms), s).id, id);
    assert.ok(s.profiles[1].rms["2"] > s.profiles[1].rms["1"] || gain === 1);
  });
test("single overly loud phone does not choose the speaker by its maximum", () => {
  const s = fixture(10);
  assert.equal(inferReference(rows(s, s.profiles[1].rms), s).id, 1);
});
test("common absolute loudness changes do not change the fingerprint", () => {
  const s = fixture();
  const scaled = Object.fromEntries(
    Object.entries(s.profiles[1].rms).map(([k, r]) => [k, r * 0.5]),
  );
  assert.equal(inferReference(rows(s, scaled), s).id, 1);
});
test("indistinguishable reference profiles abstain, seat prior cannot force a result", () => {
  const s = fixture();
  s.profiles[2] = structuredClone(s.profiles[1]);
  assert.equal(inferReference(rows(s, s.profiles[1].rms), s).kind, "unknown");
});
test("PC lost or muted is missing, not an implicit fallback", () => {
  const s = fixture(),
    r = rows(s, s.profiles[1].rms);
  delete r.pc;
  assert.equal(inferReference(r, s).kind, "missing");
  r.pc = { ...rows(s, s.profiles[1].rms).pc, healthy: false };
  assert.equal(inferReference(r, s).kind, "missing");
});
test("simultaneous energy fits a mixture, not a single speaker", () => {
  const s = fixture();
  const mix = Object.fromEntries(
    Object.keys(s.noise).map((k) => [
      k,
      Math.hypot(s.profiles[1].rms[k], s.profiles[2].rms[k]),
    ]),
  );
  assert.equal(inferReference(rows(s, mix), s).kind, "overlap");
});
test("silence and absent calibration are distinct", () => {
  const s = fixture();
  assert.equal(inferReference(rows(s, s.noise), s).kind, "silence");
  s.profiles = {};
  assert.equal(
    inferReference(rows(s, { 1: 0.04, 2: 0.4, pc: 0.04 }), s).kind,
    "unknown",
  );
});
test("acquisition windows tolerate delay and reject reverse sequences/future/uncertain clocks", () => {
  const s = fixture();
  const f = rows(s, s.profiles[1].rms)["1"];
  assert.equal(ingest(s, f), true);
  assert.equal(ingest(s, { ...f, seq: 0 }), false);
  assert.equal(ingest(s, { ...f, seq: 2, acquiredAt: 5000 }), false);
  assert.equal(align(s, 1050)["1"].seq, 1);
  assert.equal(Object.keys(align(s, 2000)).length, 0);
  ingest(s, { ...f, seq: 2, uncertainty: 999 });
  assert.equal(align(s, 1050)["1"].seq, 1);
});
test("turn count uses minimum duration and merges short gaps, while time buckets reconcile", () => {
  const a = aggregate(2);
  const one = { kind: "speaker", id: 1, confidence: 0.8, reason: "" },
    silent = { kind: "silence", id: null, confidence: 0, reason: "" };
  for (let i = 0; i < 3; i++) account(a, one, i * 100, 100, defaults);
  account(a, silent, 300, 200, defaults);
  for (let i = 5; i < 8; i++) account(a, one, i * 100, 100, defaults);
  assert.equal(a.people[0].turns, 1);
  assert.equal(a.people[0].talkMs, 600);
  account(
    a,
    { kind: "missing", id: null, confidence: 0, reason: "" },
    800,
    100,
    defaults,
  );
  account(
    a,
    { kind: "overlap", id: null, confidence: 0.5, reason: "" },
    900,
    100,
    defaults,
  );
  assert.equal(
    a.elapsedMs,
    a.people.reduce((s, p) => s + p.talkMs, 0) +
      a.unknownMs +
      a.silenceMs +
      a.missingMs +
      a.overlapMs,
  );
});
test("noise calibration requires all microphones, coverage and non-saturation", () => {
  const s = fixture();
  s.calibration = { speaker: 0, start: 1000, end: 4000 };
  assert.equal(finishCalibration(s, 4400), false);
  assert.match(s.calibrationError, /受信不足/);
});
test("same known 35-second trace evaluates both methods and reports synthetic provenance", () => {
  const s = fixture(10),
    base = 100000;
  s.dataSource = "synthetic";
  startStudy(s, base);
  s.labels = [
    { start: base, end: base + 10000, speakers: [1] },
    { start: base + 10000, end: base + 15000, speakers: [] },
    { start: base + 15000, end: base + 25000, speakers: [2] },
    { start: base + 25000, end: base + 30000, speakers: [] },
    { start: base + 30000, end: base + 35000, speakers: [1, 2] },
  ];
  const people = [1, 2].map((id) => ({
    id,
    registered: true,
    calibration: { noiseRms: s.noise[id], speechRms: s.profiles[id].rms[id] },
  }));
  const windows = [],
    voices = {};
  for (let i = 0; i < 350; i++) {
    const t = i * 100,
      ids =
        t < 10000
          ? [1]
          : t < 15000
            ? []
            : t < 25000
              ? [2]
              : t < 30000
                ? []
                : [1, 2];
    const rms = Object.fromEntries(
      Object.keys(s.noise).map((k) => [
        k,
        ids.length
          ? Math.sqrt(ids.reduce((v, id) => v + s.profiles[id].rms[k] ** 2, 0))
          : s.noise[k],
      ]),
    );
    for (const f of Object.values(rows(s, rms, base + t + 50))) {
      voices[f.channel] ||= newVoice();
      const adapted = updateVad(voices[f.channel], f.rawRms, 100, {
        noiseRms: s.noise[f.channel],
        speechRms:
          f.channel === "pc" ? 0.03 : s.profiles[f.channel].rms[f.channel],
      });
      ingest(s, { ...f, ...adapted, seq: i + 1 });
    }
    windows.push(...processStudy(s, base + t + 100, people));
  }
  windows.push(...processStudy(s, base + 35000, people, true));
  const A = evaluate(windows, "A", 2, s.config),
    B = evaluate(windows, "B", 2, s.config);
  assert.equal(windows.length, 350);
  assert.ok(B.vadPrecision >= 0.99);
  assert.ok(B.vadRecall >= 0.98);
  assert.ok(B.speakerAccuracy >= 0.95);
  assert.ok(B.misattributionRate <= 0.01);
  assert.ok(B.speakingTimeMaeSeconds <= 0.3);
  assert.equal(B.turnCountMae, 0);
  assert.equal(s.B.elapsedMs, 35000);
  assert.ok(s.B.overlapMs >= 4800);
  assert.equal(s.trace.length, 20);
  writeFileSync(
    "/tmp/meeting-reference-synthetic-evaluation.json",
    JSON.stringify(
      {
        source: "synthetic",
        scenario: "A 10s / silence 5s / B 10s / silence 5s / A+B 5s",
        A,
        B,
      },
      null,
      2,
    ),
  );
});
test("clipped inputs are unknown rather than a confident volume winner", () => {
  const s = fixture(),
    r = rows(s, s.profiles[1].rms);
  r["2"].clippedFraction = 0.2;
  assert.equal(inferReference(r, s).kind, "unknown");
});
test("unlabeled and data-missing windows have explicit evaluation coverage", () => {
  const w = [
    {
      start: 0,
      duration: 100,
      features: {},
      A: { kind: "missing", id: null, confidence: 0, reason: "" },
      B: { kind: "missing", id: null, confidence: 0, reason: "" },
      truth: [1],
    },
  ];
  assert.equal(evaluate(w, "B", 2, defaults).vadRecall, 0);
  assert.equal(evaluate([], "B", 2, defaults).speakerAccuracy, null);
});
