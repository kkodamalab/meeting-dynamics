import test from "node:test";
import assert from "node:assert/strict";
import {
  newVoice,
  updateVad,
  features,
  inferSpeaker,
  validCalibration,
} from "../src/audio.ts";
const calibration = { noiseRms: 0.001, speechRms: 0.02 };
function phone(id, rms, c = calibration) {
  return {
    id,
    connected: true,
    registered: true,
    mic: true,
    lastSample: 1000,
    vad: rms > c.noiseRms * 4,
    calibration: c,
    ...features(rms, c.noiseRms, c.speechRms),
  };
}
test("adaptive VAD recognizes low-gain speech below old rounded 8% threshold", () => {
  const s = newVoice(),
    c = { noiseRms: 0.0001, speechRms: 0.003 };
  assert.equal(updateVad(s, 0.003, 100, c).vad, false);
  assert.equal(updateVad(s, 0.003, 100, c).vad, true);
});
test("hysteresis smooths speech onset/offset without flicker at threshold", () => {
  const s = newVoice();
  updateVad(s, 0.01, 100, calibration);
  assert.equal(updateVad(s, 0.01, 100, calibration).vad, true);
  for (let i = 0; i < 3; i++)
    assert.equal(updateVad(s, 0.001, 100, calibration).vad, true);
  assert.equal(updateVad(s, 0.001, 100, calibration).vad, false);
});
test("sustained room noise does not pass calibrated VAD", () => {
  const s = newVoice();
  for (let i = 0; i < 50; i++)
    assert.equal(updateVad(s, 0.0012, 100, calibration).vad, false);
});
test("equal corrected sound from old/new is unknown, independent of 10x sensitivity", () => {
  const old = phone(1, 0.01, { noiseRms: 0.001, speechRms: 0.01 }),
    next = phone(2, 0.1, { noiseRms: 0.01, speechRms: 0.1 });
  assert.equal(inferSpeaker([old, next], 1000).id, null);
});
test("old speaking wins despite new having greater raw RMS", () => {
  const old = phone(1, 0.008, { noiseRms: 0.0002, speechRms: 0.01 }),
    next = phone(2, 0.03, { noiseRms: 0.002, speechRms: 0.1 });
  const d = inferSpeaker([old, next], 1000);
  assert.equal(d.id, 1);
  assert.ok(d.confidence > 0);
});
test("new speaking wins with reciprocal normalized evidence", () =>
  assert.equal(inferSpeaker([phone(1, 0.004), phone(2, 0.02)], 1000).id, 2));
test("silent but connected microphone does not become the loudness winner", () =>
  assert.equal(inferSpeaker([phone(1, 0.02), phone(2, 0)], 1000).id, 1));
test("stale or delayed peer causes abstention, not forced attribution", () => {
  for (const patch of [
    { lastSample: 0 },
    { sampleDelayMs: 800 },
    { connected: false },
  ])
    assert.equal(
      inferSpeaker([phone(1, 0.02), { ...phone(2, 0.02), ...patch }], 1000).id,
      null,
    );
});
test("simultaneous strong speech at both own-voice references is unknown", () =>
  assert.equal(inferSpeaker([phone(1, 0.02), phone(2, 0.03)], 1000).id, null));
test("calibration missing or invalid cannot silently bias device assignment", () => {
  assert.equal(validCalibration({ noiseRms: 0.01, speechRms: 0.02 }), false);
  assert.equal(
    inferSpeaker(
      [{ ...phone(1, 0.02), calibration: undefined }, phone(2, 0)],
      1000,
    ).id,
    null,
  );
});
test('AGC-like gain drift creating equivalent strong signals is withheld',()=>{const old=phone(1,.02),next=phone(2,.01*2);assert.equal(inferSpeaker([old,next],1000).id,null)});
test('noise processing changes adaptive thresholds rather than a fixed amplitude gate',()=>{const high=updateVad(newVoice(),.001,100,{noiseRms:.01,speechRms:.1}),low=updateVad(newVoice(),.001,100,{noiseRms:.001,speechRms:.1});assert.equal(high.startThresholdDb-low.startThresholdDb,20)});
test('muted or suspended capture is withheld even when the socket is healthy',()=>{for(const patch of [{trackMuted:true},{audioState:'suspended'}])assert.equal(inferSpeaker([phone(1,.02),{...phone(2,0),...patch}],1000).id,null)});
