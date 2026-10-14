import { dbfs, inferSpeaker, percentile } from "./audio.ts";
export type Mode = "smartphone" | "reference";
export type Kind = "speaker" | "unknown" | "silence" | "missing" | "overlap";
export type Decision = {
  kind: Kind;
  id: number | null;
  confidence: number;
  reason: string;
};
export type Feature = {
  channel: string;
  seq: number;
  acquiredAt: number;
  receivedAt: number;
  rawRms: number;
  vad: boolean;
  snr: number;
  dbfs: number;
  noiseDb: number;
  correctedDb: number;
  uncertainty: number;
  settings?: Record<string, unknown>;
  healthy: boolean;
  clockOffsetMs?: number;
  roundTripMs?: number;
  capturedMonotonic?: number;
  peak?: number;
  clippedFraction?: number;
};
export type Window = {
  start: number;
  duration: number;
  features: Record<string, Feature>;
  A: Decision;
  B: Decision;
  truth?: number[];
};
export const defaults = {
  windowMs: 100,
  bufferMs: 350,
  toleranceMs: 150,
  maxUncertaintyMs: 200,
  gapMs: 350,
  minTurnMs: 300,
  similarityGapDb: 2,
  maxDistanceDb: 6,
};
export type Config = typeof defaults;
export const channels = (count: number, pc = true) => [
  ...Array.from({ length: count }, (_, i) => String(i + 1)),
  ...(pc ? ["pc"] : []),
];
export function normalizeVector(rms: number[], noise: number[]) {
  return rms.map((r, i) =>
    dbfs(Math.sqrt(Math.max(1e-12, r * r - noise[i] * noise[i]))),
  );
}
const centered = (v: number[]) => {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return v.map((x) => x - mean);
};
export function vectorDistance(a: number[], b: number[]) {
  const x = centered(a),
    y = centered(b);
  return Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0) / x.length);
}
export function inferReference(
  features: Record<string, Feature>,
  study: any,
): Decision {
  const keys = channels(study.count);
  const rows = keys.map((k) => features[k]);
  if (rows.some((r) => !r || !r.healthy))
    return {
      kind: "missing",
      id: null,
      confidence: 0,
      reason: "PCまたはスマホのデータ不足",
    };
  if (rows.some((r) => (r.clippedFraction || 0) > 0.01))
    return {
      kind: "unknown",
      id: null,
      confidence: 0,
      reason: "マイク入力の飽和",
    };
  const speech = rows.some((r) => r.vad && r.snr >= 6);
  if (!speech)
    return {
      kind: "silence",
      id: null,
      confidence: 0,
      reason: "全マイクVAD無音",
    };
  if (
    keys.some((k) => !Number.isFinite(study.noise[k])) ||
    Object.keys(study.profiles).length !== study.count
  )
    return {
      kind: "unknown",
      id: null,
      confidence: 0,
      reason: "共同キャリブレーション未完了",
    };
  const noise = keys.map((k) => study.noise[k]);
  const live = normalizeVector(
    rows.map((r) => r.rawRms),
    noise,
  );
  const ranked = Object.entries(study.profiles)
    .map(([id, p]: any) => ({
      id: Number(id),
      distance: vectorDistance(
        live,
        normalizeVector(
          keys.map((k) => p.rms[k]),
          noise,
        ),
      ),
    }))
    .sort((a, b) => a.distance - b.distance);
  const best = ranked[0],
    second = ranked[1];
  let mixture = Infinity;
  for (let i = 1; i <= study.count; i++)
    for (let j = i + 1; j <= study.count; j++)
      for (const w of [0.25, 0.5, 0.75]) {
        const a = study.profiles[i].rms,
          b = study.profiles[j].rms;
        const combined = keys.map((k) =>
          Math.sqrt(
            w * Math.max(0, a[k] ** 2 - study.noise[k] ** 2) +
              (1 - w) * Math.max(0, b[k] ** 2 - study.noise[k] ** 2) +
              study.noise[k] ** 2,
          ),
        );
        mixture = Math.min(
          mixture,
          vectorDistance(live, normalizeVector(combined, noise)),
        );
      }
  if (mixture + study.config.similarityGapDb < best.distance)
    return {
      kind: "overlap",
      id: null,
      confidence: Math.max(0, 1 - mixture / study.config.maxDistanceDb),
      reason: "複数話者の混合応答に近い（同時発話候補）",
    };
  const gap = second ? second.distance - best.distance : 12;
  if (
    best.distance > study.config.maxDistanceDb ||
    gap < study.config.similarityGapDb
  )
    return {
      kind: "unknown",
      id: null,
      confidence: 0,
      reason: "応答ベクトルが曖昧／校正と不一致",
    };
  // A weak positional prior adjusts confidence only; it never chooses the speaker.
  const seat = study.layout?.positions?.[best.id - 1],
    pc = study.layout?.pcPosition;
  const prior =
    seat && pc
      ? Math.max(0, 1 - Math.hypot(seat.x - pc.x, seat.y - pc.y) / 142)
      : 0.5;
  const snr = Math.max(...rows.map((r) => r.snr));
  return {
    kind: "speaker",
    id: best.id,
    confidence:
      Math.min(1, gap / 6) *
      Math.max(0, 1 - best.distance / study.config.maxDistanceDb) *
      Math.min(1, snr / 20) *
      (0.95 + 0.05 * prior),
    reason: "正規化応答・SNR・時間平滑化（位置は信頼度の補助）",
  };
}
export function inferA(
  features: Record<string, Feature>,
  people: any[],
  time: number,
): Decision {
  const rows = people.map((p) => {
    const f = features[String(p.id)];
    return {
      ...p,
      ...f,
      lastSample: f?.acquiredAt || 0,
      connected: !!f?.healthy,
      mic: !!f?.healthy,
      sampleDelayMs: f ? 0 : 10000,
    };
  });
  if (rows.some((p) => !p.connected))
    return {
      kind: "missing",
      id: null,
      confidence: 0,
      reason: "スマホのデータ不足",
    };
  const result = inferSpeaker(rows, time);
  return {
    kind: result.id
      ? "speaker"
      : !result.speech
        ? "silence"
        : result.reason.includes("同時発話")
          ? "overlap"
          : "unknown",
    id: result.id,
    confidence: result.confidence,
    reason: result.reason,
  };
}
export function aggregate(count: number) {
  return {
    elapsedMs: 0,
    speechMs: 0,
    unknownMs: 0,
    silenceMs: 0,
    missingMs: 0,
    overlapMs: 0,
    confidenceMs: 0,
    people: Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      talkMs: 0,
      turns: 0,
      confidenceMs: 0,
    })),
    turnState: {} as Record<
      string,
      { lastEnd: number; duration: number; counted: boolean }
    >,
    lastOther: 0,
  };
}
export function account(
  total: ReturnType<typeof aggregate>,
  decision: Decision,
  start: number,
  duration: number,
  config: Config,
) {
  total.elapsedMs += duration;
  if (decision.kind === "silence") total.silenceMs += duration;
  else if (decision.kind === "missing") total.missingMs += duration;
  else {
    total.speechMs += duration;
    total.confidenceMs += duration * decision.confidence;
    if (decision.kind === "unknown") total.unknownMs += duration;
    if (decision.kind === "overlap") total.overlapMs += duration;
    if (decision.kind === "speaker" && decision.id) {
      const p = total.people[decision.id - 1];
      p.talkMs += duration;
      p.confidenceMs += duration * decision.confidence;
      let segment = total.turnState[decision.id];
      if (
        !segment ||
        start - segment.lastEnd > config.gapMs ||
        segment.lastEnd < total.lastOther
      ) {
        segment = { lastEnd: start, duration: 0, counted: false };
        total.turnState[decision.id] = segment;
      }
      segment.duration += duration;
      segment.lastEnd = start + duration;
      if (!segment.counted && segment.duration >= config.minTurnMs) {
        p.turns++;
        segment.counted = true;
      }
      total.lastOther = start; // same speaker's lastEnd is newer; another speaker breaks continuity.
    }
  }
}
export function intervals(
  windows: Window[],
  method: "A" | "B",
  config: Config,
) {
  const runs: any[] = [];
  for (const w of windows) {
    const d = w[method],
      previous = runs.at(-1);
    if (
      previous &&
      previous.kind === d.kind &&
      previous.id === d.id &&
      previous.end === w.start
    ) {
      previous.end += w.duration;
      previous.confidenceMs += d.confidence * w.duration;
    } else
      runs.push({
        ...d,
        start: w.start,
        end: w.start + w.duration,
        confidenceMs: d.confidence * w.duration,
      });
  }
  return runs.map((r) => ({
    ...r,
    confidence: r.confidenceMs / (r.end - r.start),
    validTurn: r.kind === "speaker" && r.end - r.start >= config.minTurnMs,
  }));
}
export function evaluate(
  windows: Window[],
  method: "A" | "B",
  count: number,
  config: Config,
) {
  let tp = 0,
    fp = 0,
    fn = 0,
    correct = 0,
    wrong = 0,
    single = 0,
    labeled = 0;
  const predicted = aggregate(count),
    truth = aggregate(count);
  for (const w of windows) {
    if (!w.truth) continue;
    labeled += w.duration;
    const d = w[method],
      voice =
        d.kind === "speaker" || d.kind === "unknown" || d.kind === "overlap",
      truthVoice = w.truth.length > 0;
    if (voice && truthVoice) tp += w.duration;
    if (voice && !truthVoice) fp += w.duration;
    if (!voice && truthVoice) fn += w.duration;
    if (w.truth.length === 1) {
      single += w.duration;
      if (d.kind === "speaker" && d.id === w.truth[0]) correct += w.duration;
      else if (d.kind === "speaker") wrong += w.duration;
    }
    account(predicted, d, w.start, w.duration, config);
    account(
      truth,
      {
        kind:
          w.truth.length === 0
            ? "silence"
            : w.truth.length === 1
              ? "speaker"
              : "overlap",
        id: w.truth[0] || null,
        confidence: 1,
        reason: "正解ラベル",
      },
      w.start,
      w.duration,
      config,
    );
  }
  const ratio = (n: number, d: number) => (d ? n / d : null);
  return {
    labeledMs: labeled,
    vadPrecision: ratio(tp, tp + fp),
    vadRecall: ratio(tp, tp + fn),
    speakerAccuracy: ratio(correct, single),
    misattributionRate: ratio(wrong, single),
    speakingTimeMaeSeconds: labeled
      ? predicted.people.reduce(
          (s, p, i) => s + Math.abs(p.talkMs - truth.people[i].talkMs),
          0,
        ) /
        count /
        1000
      : null,
    turnCountMae: labeled
      ? predicted.people.reduce(
          (s, p, i) => s + Math.abs(p.turns - truth.people[i].turns),
          0,
        ) / count
      : null,
  };
}
export function newStudy(count: number, mode: Mode = "smartphone") {
  return {
    version: 1,
    epoch: Date.now(),
    legacyMs: 0,
    count,
    mode,
    config: { ...defaults },
    layout: null as any,
    noise: {} as Record<string, number>,
    profiles: {} as Record<string, any>,
    buffers: {} as Record<string, Feature[]>,
    lastSeq: {} as Record<string, number>,
    calibration: null as any,
    calibrationError: "",
    A: aggregate(count),
    B: aggregate(count),
    origin: 0,
    next: 0,
    running: false,
    labels: [] as { start: number; end?: number; speakers: number[] }[],
    dataSource: "unlabeled-live" as string,
    trace: [] as Window[],
    smooth: {} as Record<string, number[]>,
    clock: {} as Record<string, any>,
    recordedWindows: 0,
    recordedBytes: 0,
    recordingLimit: 36000,
    byteLimit: 32 * 1024 * 1024,
  };
}
export function ingest(study: ReturnType<typeof newStudy>, feature: Feature) {
  if (
    !Number.isInteger(feature.seq) ||
    feature.seq <= (study.lastSeq[feature.channel] ?? -1) ||
    !Number.isFinite(feature.acquiredAt) ||
    feature.acquiredAt > feature.receivedAt + 200 ||
    feature.receivedAt - feature.acquiredAt > 2000
  )
    return false;
  study.lastSeq[feature.channel] = feature.seq;
  const history = (study.buffers[feature.channel] ||= []);
  history.push(feature);
  study.buffers[feature.channel] = history
    .filter((f) => f.receivedAt > feature.receivedAt - 15000)
    .slice(-180);
  return true;
}
export function align(study: ReturnType<typeof newStudy>, time: number) {
  const result: Record<string, Feature> = {};
  for (const key of channels(study.count)) {
    const candidates = (study.buffers[key] || []).filter(
      (f) =>
        Math.abs(f.acquiredAt - time) <= study.config.toleranceMs &&
        f.uncertainty <= study.config.maxUncertaintyMs,
    );
    const nearest = candidates.sort(
      (a, b) => Math.abs(a.acquiredAt - time) - Math.abs(b.acquiredAt - time),
    )[0];
    if (nearest) result[key] = nearest;
  }
  return result;
}
export function startStudy(study: ReturnType<typeof newStudy>, now: number) {
  if (!study.origin) {
    study.origin = now;
    study.next = now;
  }
  study.running = true;
  study.next = now;
}
export function processStudy(
  study: ReturnType<typeof newStudy>,
  now: number,
  people: any[],
  finish = false,
) {
  const output: Window[] = [];
  if (!study.running) return output;
  const end = finish ? now : now - study.config.bufferMs;
  while (study.next + study.config.windowMs <= end) {
    const start = study.next,
      features = align(study, start + study.config.windowMs / 2);
    const smooth: Record<string, Feature> = {};
    for (const [k, f] of Object.entries(features)) {
      const history = (study.smooth[k] ||= []);
      history.push(f.rawRms);
      if (history.length > 3) history.shift();
      smooth[k] = {
        ...f,
        rawRms: Math.sqrt(
          history.reduce((s, r) => s + r * r, 0) / history.length,
        ),
      };
    }
    for (const k of channels(study.count))
      if (!features[k]) delete study.smooth[k];
    const A = inferA(features, people, start + study.config.windowMs / 2),
      B = inferReference(smooth, study);
    const label = study.labels.findLast(
      (l) => l.start <= start && (l.end === undefined || l.end > start),
    );
    const w = {
      start: start - study.origin,
      duration: study.config.windowMs,
      features,
      A,
      B,
      ...(label ? { truth: label.speakers } : {}),
    };
    account(study.A, A, w.start, w.duration, study.config);
    account(study.B, B, w.start, w.duration, study.config);
    output.push(w);
    study.trace.push(w);
    if (study.trace.length > 20) study.trace.shift();
    study.recordedWindows++;
    study.next += study.config.windowMs;
    if (study.recordedWindows >= study.recordingLimit) {
      study.running = false;
      break;
    }
  }
  if (finish) study.running = false;
  return output;
}
export function beginCalibration(
  study: ReturnType<typeof newStudy>,
  speaker: number,
  now: number,
) {
  study.calibration = {
    speaker,
    start: now,
    end: now + (speaker === 0 ? 3000 : 5000),
  };
  study.calibrationError = "";
  if (speaker === 0) {
    study.noise = {};
    study.profiles = {};
  }
}
export function finishCalibration(
  study: ReturnType<typeof newStudy>,
  now: number,
) {
  const c = study.calibration;
  if (!c || now < c.end + study.config.bufferMs) return false;
  const keys = channels(study.count),
    rms: Record<string, number> = {},
    quality: Record<string, any> = {};
  for (const key of keys) {
    const rows = (study.buffers[key] || []).filter(
      (f) =>
        f.acquiredAt >= c.start &&
        f.acquiredAt < c.end &&
        f.healthy &&
        f.uncertainty <= study.config.maxUncertaintyMs,
    );
    const coverage = rows.length / ((c.end - c.start) / 100);
    const values = rows.map((f) => f.rawRms);
    rms[key] = Math.max(1e-6, percentile(values, c.speaker === 0 ? 0.5 : 0.75));
    quality[key] = {
      samples: rows.length,
      coverage,
      peak: Math.max(0, ...values),
      snr:
        c.speaker === 0
          ? null
          : dbfs(rms[key]) - dbfs(study.noise[key] || 1e-6),
    };
    if (
      coverage < 0.7 ||
      values.some((v) => v >= 0.95) ||
      rows.some((f) => (f.clippedFraction || 0) > 0.01) ||
      (c.speaker !== 0 && quality[key].snr < 6)
    ) {
      study.calibrationError = `${key === "pc" ? "PC" : key}: 受信不足・飽和・SNR不足。位置・マイクを確認して再測定`;
      study.calibration = null;
      return false;
    }
  }
  if (c.speaker === 0) study.noise = rms;
  else if (keys.some((k) => !study.noise[k]))
    study.calibrationError = "静音STEPを先に完了してください";
  else study.profiles[c.speaker] = { rms, quality, measuredAt: now };
  study.calibration = null;
  return !study.calibrationError;
}
export function studySummary(study: ReturnType<typeof newStudy>) {
  const clean = (a: ReturnType<typeof aggregate>) => {
    const { turnState, lastOther, ...rest } = a;
    return rest;
  };
  return {
    sessionStartAt: study.origin,
    legacyMs: study.legacyMs,
    mode: study.mode,
    config: study.config,
    layout: study.layout,
    noise: study.noise,
    profiles: study.profiles,
    calibration: study.calibration,
    calibrationError: study.calibrationError,
    ready:
      Object.keys(study.profiles).length === study.count &&
      channels(study.count).every((k) => study.noise[k]),
    A: clean(study.A),
    B: clean(study.B),
    dataSource: study.dataSource,
    labels: study.labels,
    clock: study.clock,
    recordedWindows: study.recordedWindows,
    recordedBytes: study.recordedBytes,
    byteLimit: study.byteLimit,
    recordingLimit: study.recordingLimit,
  };
}
