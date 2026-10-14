import test from "node:test";
import assert from "node:assert/strict";
import {
  newStudy,
  beginCalibration,
  finishCalibration,
  ingest,
  studySummary,
} from "../src/study.ts";
import { dbfs } from "../src/audio.ts";
const settings = {
  autoGainControl: false,
  echoCancellation: false,
  noiseSuppression: false,
  sampleRate: 48000,
  channelCount: 2,
};
function populate(s, speaker, start, options = {}) {
  beginCalibration(s, speaker, start);
  const duration = speaker === 0 ? 3000 : 5000;
  for (const channel of ["1", "2", "pc"]) {
    const count = Math.floor(
      (duration / 100) * (options.coverage?.[channel] ?? 1),
    );
    for (let i = 0; i < count; i++) {
      const rawRms =
        options.rms?.(channel, i) ?? (speaker === 0 ? 0.00001 : 0.005);
      const acquiredAt =
        start + i * 100 + 10 + (options.jitter ? (i % 2 ? 15 : -5) : 0);
      const f = {
        channel,
        seq: (s.lastSeq[channel] ?? -1) + 1,
        acquiredAt,
        receivedAt: acquiredAt + (options.delay ?? 50),
        rawRms,
        dbfs: dbfs(rawRms),
        vad: speaker !== 0,
        snr: 0,
        noiseDb: -100,
        correctedDb: 0,
        healthy: options.healthy?.[channel] ?? true,
        uncertainty: options.uncertainty?.[channel] ?? 20,
        clippedFraction: options.clipped?.[channel] ?? 0,
        settings,
      };
      assert.equal(ingest(s, f), true);
    }
  }
  return start + duration + 2000;
}
test("STEP 1 accepts quiet nonzero stereo/AGC-OFF signal with zero SNR and saves PC noise", () => {
  const s = newStudy(2, "reference");
  const end = populate(s, 0, 10000);
  assert.equal(finishCalibration(s, end), true);
  assert.equal(s.noise.pc, 0.00001);
  for (const q of Object.values(
    studySummary(s).calibrationResults[0].quality,
  )) {
    assert.equal(q.snr, null);
    assert.equal(q.passed, true);
    assert.equal(q.samples, 30);
    assert.equal(q.clippedFraction, 0);
    assert.equal(q.settings.channelCount, 2);
  }
});
test("STEP 1 -> STEP 2 -> STEP 3 saves all response vectors and marks ready", () => {
  const s = newStudy(2, "reference");
  for (const [speaker, start] of [
    [0, 10000],
    [1, 16000],
    [2, 24000],
  ])
    assert.equal(finishCalibration(s, populate(s, speaker, start)), true);
  assert.equal(studySummary(s).ready, true);
  assert.ok(s.profiles[1].quality.pc.snr >= 6);
});
test("delayed captures wait 2 seconds and corrected clocks/boundary jitter preserve coverage", () => {
  const s = newStudy(2, "reference");
  const end = populate(s, 0, 10000, { delay: 1750, jitter: true });
  assert.equal(finishCalibration(s, end - 1500), false);
  assert.ok(s.calibration);
  assert.equal(finishCalibration(s, end), true);
  assert.equal(s.calibrationResults[0].quality.pc.coverage, 1);
  assert.ok(s.calibrationResults[0].quality.pc.lateSamples > 0);
});
test("noise failure reports every microphone, keeps STEP 2 blocked and supports STEP 1 retry", () => {
  const s = newStudy(2, "reference");
  const end = populate(s, 0, 10000, {
    coverage: { 1: 0.5, pc: 0 },
    clipped: { 2: 0.03 },
  });
  assert.equal(finishCalibration(s, end), false);
  assert.equal(s.noise.pc, undefined);
  const q = s.calibrationResults[0].quality;
  assert.equal(Object.keys(q).length, 3);
  assert.match(q["1"].reasons.join(), /受信不足/);
  assert.match(q["2"].reasons.join(), /飽和/);
  assert.match(q.pc.reasons.join(), /受信不足/);
  assert.equal(finishCalibration(s, populate(s, 0, 16000)), true);
  assert.ok(s.noise.pc);
});
test("speech alone requires >=6dB SNR on every microphone; retry preserves other speaker", () => {
  const s = newStudy(2, "reference");
  assert.equal(finishCalibration(s, populate(s, 0, 10000)), true);
  assert.equal(finishCalibration(s, populate(s, 1, 16000)), true);
  assert.equal(
    finishCalibration(
      s,
      populate(s, 2, 24000, { rms: (c) => (c === "pc" ? 0.000015 : 0.005) }),
    ),
    false,
  );
  assert.match(s.calibrationResults[2].quality.pc.reasons.join(), /発話SNR/);
  assert.ok(s.profiles[1]);
  assert.equal(s.profiles[2], undefined);
  assert.ok(s.noise.pc);
  assert.equal(finishCalibration(s, populate(s, 2, 32000)), true);
  assert.ok(studySummary(s).ready);
});
for (const speaker of [0, 1])
  test(`STEP ${speaker + 1} rejects actual clipped frames`, () => {
    const s = newStudy(2, "reference");
    s.noise = { 1: 0.00001, 2: 0.00001, pc: 0.00001 };
    assert.equal(
      finishCalibration(
        s,
        populate(s, speaker, 10000, { clipped: { pc: 0.02 } }),
      ),
      false,
    );
    assert.match(
      s.calibrationResults[speaker].quality.pc.reasons.join(),
      /飽和/,
    );
  });
test("exact digital zero is a distinct muted/no-input failure, not saturation", () => {
  const s = newStudy(2, "reference");
  assert.equal(
    finishCalibration(
      s,
      populate(s, 0, 10000, { rms: (c) => (c === "pc" ? 0 : 0.00001) }),
    ),
    false,
  );
  const reasons = s.calibrationResults[0].quality.pc.reasons.join();
  assert.match(reasons, /完全なゼロ/);
  assert.doesNotMatch(reasons, /飽和/);
});
test("unstable noise is rejected without imposing a speech SNR threshold", () => {
  const s = newStudy(2, "reference");
  assert.equal(
    finishCalibration(
      s,
      populate(s, 0, 10000, { rms: (_, i) => (i % 2 ? 0.01 : 0.00001) }),
    ),
    false,
  );
  assert.match(
    s.calibrationResults[0].quality.pc.reasons.join(),
    /無音区間の変動/,
  );
});
test("clock uncertainty is reported; sufficient synchronized captures can still pass", () => {
  const s = newStudy(2, "reference");
  assert.equal(
    finishCalibration(s, populate(s, 0, 10000, { uncertainty: { pc: 500 } })),
    false,
  );
  assert.equal(s.calibrationResults[0].quality.pc.clockRejected, 30);
  assert.match(s.calibrationResults[0].quality.pc.reasons.join(), /時計同期/);
  const end = populate(s, 0, 16000);
  s.buffers.pc.find((f) => f.acquiredAt >= 16000).uncertainty = 500;
  assert.equal(finishCalibration(s, end), true);
  assert.equal(s.calibrationResults[0].quality.pc.clockRejected, 1);
});
test("repeated captures cannot inflate coverage and unhealthy audio is diagnosed", () => {
  const s = newStudy(2, "reference");
  const end = populate(s, 0, 10000, { healthy: { 2: false } });
  s.buffers.pc.forEach((f) => (f.acquiredAt = 10010));
  assert.equal(finishCalibration(s, end), false);
  assert.equal(s.calibrationResults[0].quality.pc.samples, 1);
  assert.match(
    s.calibrationResults[0].quality["2"].reasons.join(),
    /音声処理停止/,
  );
});
test("transport/clock rejection exposes the cause rather than generic low SNR", () => {
  const s = newStudy(2, "reference");
  beginCalibration(s, 0, 10000);
  const f = {
    channel: "pc",
    seq: 1,
    acquiredAt: 5000,
    receivedAt: 10010,
    rawRms: 0.001,
    dbfs: -60,
    snr: 0,
    noiseDb: -60,
    correctedDb: 0,
    vad: false,
    healthy: true,
    uncertainty: 20,
  };
  assert.equal(ingest(s, f), false);
  assert.equal(finishCalibration(s, 15000), false);
  assert.equal(s.calibrationResults[0].quality.pc.rejectedSamples, 1);
  assert.match(s.calibrationResults[0].quality.pc.reasons.join(), /2秒超/);
});
test("a new noise baseline invalidates old speech results and snapshots remain serializable", () => {
  const s = newStudy(2, "reference");
  for (const [speaker, start] of [
    [0, 10000],
    [1, 16000],
    [2, 24000],
  ])
    assert.equal(finishCalibration(s, populate(s, speaker, start)), true);
  beginCalibration(s, 0, 32000);
  assert.deepEqual(s.profiles, {});
  assert.deepEqual(s.calibrationResults, {});
  assert.equal(studySummary(s).ready, false);
  assert.doesNotThrow(() => JSON.stringify(studySummary(s)));
});
