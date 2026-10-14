export type Calibration = { noiseRms: number; speechRms: number };
export type VoiceState = {
  noiseRms: number;
  vad: boolean;
  attackMs: number;
  releaseMs: number;
};
export const dbfs = (rms: number) => 20 * Math.log10(Math.max(1e-6, rms));
export const newVoice = (): VoiceState => ({
  noiseRms: 0.001,
  vad: false,
  attackMs: 0,
  releaseMs: 0,
});
export function features(rawRms: number, noiseRms: number, speechRms?: number) {
  const rms = Math.max(0, Math.min(1, rawRms)),
    noise = Math.max(1e-6, noiseRms);
  const signal = Math.sqrt(Math.max(0, rms * rms - noise * noise));
  const reference = speechRms
    ? Math.sqrt(Math.max(1e-12, speechRms * speechRms - noise * noise))
    : 0;
  return {
    rawRms: rms,
    dbfs: dbfs(rms),
    snr: Math.max(0, dbfs(rms) - dbfs(noise)),
    correctedDb: reference ? dbfs(signal / reference) : -120,
    noiseDb: dbfs(noise),
  };
}
export function updateVad(
  state: VoiceState,
  rms: number,
  dt: number,
  calibration?: Calibration,
) {
  dt = Math.max(0, Math.min(200, dt));
  if (calibration) state.noiseRms = calibration.noiseRms;
  const f = features(rms, state.noiseRms, calibration?.speechRms);
  const above = f.dbfs > Math.max(-100, f.noiseDb + (state.vad ? 6 : 10));
  if (!state.vad) {
    state.attackMs = above ? state.attackMs + dt : 0;
    if (state.attackMs >= 150) {
      state.vad = true;
      state.releaseMs = 0;
    }
  } else {
    state.releaseMs = above ? 0 : state.releaseMs + dt;
    if (state.releaseMs >= 350) {
      state.vad = false;
      state.attackMs = 0;
    }
  }
  if (!calibration && !state.vad && f.snr < 6)
    state.noiseRms = Math.max(
      1e-6,
      state.noiseRms + ((rms - state.noiseRms) * dt) / 20000,
    );
  return {
    ...f,
    vad: state.vad,
    startThresholdDb: Math.max(-100, f.noiseDb + 10),
    endThresholdDb: Math.max(-100, f.noiseDb + 6),
  };
}
export function validCalibration(c: Calibration) {
  return (
    Number.isFinite(c?.noiseRms) &&
    Number.isFinite(c?.speechRms) &&
    c.noiseRms >= 1e-6 &&
    c.noiseRms < 0.5 &&
    c.speechRms <= 1 &&
    c.speechRms > c.noiseRms * 3.16
  );
}
export function percentile(values: number[], fraction: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}
export type Candidate = {
  id: number;
  connected: boolean;
  registered: boolean;
  mic: boolean;
  lastSample: number;
  vad: boolean;
  snr?: number;
  correctedDb?: number;
  calibration?: Calibration;
  sampleDelayMs?: number;
  calibrating?: boolean;
  audioState?: string;
  trackMuted?: boolean;
};
export function inferSpeaker(people: Candidate[], now: number) {
  const participants = people.filter((p) => p.registered);
  const fresh = participants.filter(
    (p) =>
      p.connected &&
      p.mic &&
      (!p.audioState || p.audioState === "running") &&
      !p.trackMuted &&
      now - p.lastSample < 600 &&
      (p.sampleDelayMs || 0) < 500,
  );
  const voiced = fresh.filter((p) => p.vad && !p.calibrating);
  if (!voiced.length)
    return {
      id: null,
      confidence: 0,
      reason: participants.some((p) => !fresh.includes(p))
        ? "受信不足"
        : "無音",
      speech: false,
    };
  if (fresh.some((p) => p.calibrating))
    return {
      id: null,
      confidence: 0,
      reason: "キャリブレーション中",
      speech: true,
    };
  if (fresh.length !== participants.length)
    return { id: null, confidence: 0, reason: "受信不足", speech: true };
  if (fresh.some((p) => !validCalibration(p.calibration!)))
    return {
      id: null,
      confidence: 0,
      reason: "キャリブレーション未完了",
      speech: true,
    };
  const scored = voiced
    .map((p) => ({
      p,
      score:
        Math.max(-60, Math.min(12, p.correctedDb!)) +
        Math.min(30, p.snr!) * 0.15,
    }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0],
    second = scored[1],
    gap = second ? best.score - second.score : 12;
  // Both microphones near their own speech reference can mean simultaneous speech.
  if (
    second &&
    ((best.p.correctedDb! > -4 && second.p.correctedDb! > -4) || gap < 4)
  )
    return {
      id: null,
      confidence: 0,
      reason: "音量差が小さい／同時発話",
      speech: true,
    };
  if (best.p.snr! < 10)
    return { id: null, confidence: 0, reason: "SNR不足", speech: true };
  return {
    id: best.p.id,
    confidence: Math.min(1, gap / 12) * Math.min(1, best.p.snr! / 20),
    reason: "補正音量・SNR",
    speech: true,
  };
}
