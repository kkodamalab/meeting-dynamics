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
        segment.lastEnd <= total.lastOther
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
      if(segment.counted)total.lastOther = start; // Only a qualified utterance interrupts another speaker.
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
  const utterances:any[]=[];const last:Record<string,any>={};let other=0;
  for(const r of runs){if(r.kind!=='speaker'||!r.id)continue;
    let u=last[r.id];if(!u||r.start-u.end>config.gapMs||u.end<=other){u={id:r.id,start:r.start,end:r.start,speakingMs:0,confidenceMs:0,validTurn:false};last[r.id]=u;utterances.push(u);}
    u.end=r.end;u.speakingMs+=r.end-r.start;u.confidenceMs+=r.confidenceMs;u.validTurn=u.speakingMs>=config.minTurnMs;
    if(u.validTurn)other=r.end-config.windowMs;
  }
  return {raw:runs.map(r=>({...r,confidence:r.confidenceMs/(r.end-r.start)})),utterances:utterances.map(u=>({...u,gapMs:u.end-u.start-u.speakingMs,confidence:u.confidenceMs/u.speakingMs}))};
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
    assigned = 0,
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

    }
    if(d.kind=== "speaker"){assigned+=w.duration;if(w.truth.length!==1||d.id!==w.truth[0])wrong+=w.duration;}
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
    assignedMs:assigned,wrongAssignedMs:wrong,
    misattributionRate: ratio(wrong, assigned),
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
    calibrationResults: {} as Record<string, any>,
    calibrationRejected: {} as Record<string, string[]>,
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
  const rejection =
    !Number.isInteger(feature.seq) ||
    feature.seq <= (study.lastSeq[feature.channel] ?? -1)
      ? "重複／順序逆転シーケンス"
      : !Number.isFinite(feature.acquiredAt)
        ? "取得時刻が不正"
        : feature.acquiredAt > feature.receivedAt + 200
          ? "時計ずれ: 取得時刻が受信時刻より200ms超先"
          : feature.receivedAt - feature.acquiredAt > 2000
            ? "通信遅延／時計ずれ: 取得から受信まで2秒超"
            : "";
  if (rejection) {
    const c = study.calibration;
    if (
      c &&
      feature.receivedAt >= c.start &&
      feature.receivedAt <= c.end + 2000
    ) {
      study.calibrationRejected ||= {};
      const errors = (study.calibrationRejected[feature.channel] ||= []);
      if (errors.length < 180) errors.push(rejection);
    }
    return false;
  }
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
  study.calibrationRejected = {};
  delete study.calibrationResults?.[speaker];
  if (speaker === 0) {
    study.noise = {};
    study.profiles = {};
    study.calibrationResults = {};
  } else {
    delete study.profiles[speaker];
  }
}
export function finishCalibration(
  study: ReturnType<typeof newStudy>,
  now: number,
) {
  const c = study.calibration;
  // ingest accepts up to 2s transport delay. Wait the same budget before
  // judging coverage, without extending the acquisition interval.
  if (!c || now < c.end + Math.max(2000, study.config.bufferMs)) return false;
  const keys = channels(study.count),
    rms: Record<string, number> = {},
    quality: Record<string, any> = {};
  for (const key of keys) {
    const received = (study.buffers[key] || []).filter(
      (f) => f.acquiredAt >= c.start && f.acquiredAt < c.end,
    );
    const valid = received.filter(
      (f) =>
        f.healthy &&
        f.uncertainty <= study.config.maxUncertaintyMs &&
        Number.isFinite(f.rawRms) &&
        f.rawRms >= 0 &&
        f.rawRms <= 1,
    );
    // Count independent captures, not repeated transmissions of one capture.
    // Counting captures rather than occupied rounded bins avoids boundary
    // jitter losing every other sample. Acquisition times are clock-corrected.
    const rows: Feature[] = [];
    for (const f of [...valid].sort((a, b) => a.acquiredAt - b.acquiredAt))
      if (!rows.length || f.acquiredAt - rows.at(-1)!.acquiredAt >= 50)
        rows.push(f);
    const expectedSamples = (c.end - c.start) / study.config.windowMs;
    const coverage = Math.min(1, rows.length / expectedSamples);
    const values = rows.map((f) => f.rawRms);
    rms[key] = Math.max(1e-6, percentile(values, c.speaker === 0 ? 0.5 : 0.75));
    const clippedFraction = rows.length
      ? rows.reduce((s, f) => s + (f.clippedFraction || 0), 0) / rows.length
      : 0;
    const maxClippedFraction = Math.max(
      0,
      ...rows.map((f) => f.clippedFraction || 0),
    );
    const snr =
      c.speaker === 0
        ? null
        : study.noise[key]
          ? dbfs(rms[key]) - dbfs(study.noise[key])
          : null;
    const reasons: string[] = [];
    const rejected = study.calibrationRejected?.[key] || [];
    if (coverage < 0.7) reasons.push(...new Set(rejected));
    if (
      coverage < 0.7 &&
      received.some((f) => f.uncertainty > study.config.maxUncertaintyMs)
    )
      reasons.push(
        `時計同期不確実性が${study.config.maxUncertaintyMs}msを超過（同期を待って再測定）`,
      );
    if (coverage < 0.7)
      reasons.push(
        `受信不足: ${rows.length}/${expectedSamples} (${(coverage * 100).toFixed(1)}%)、70%以上必要`,
      );
    if (received.some((f) => !f.healthy))
      reasons.push("音声処理停止／マイク消音");
    if (
      received.some(
        (f) => !Number.isFinite(f.rawRms) || f.rawRms < 0 || f.rawRms > 1,
      )
    )
      reasons.push("RMSが不正");
    if (values.some((v) => v >= 0.95) || maxClippedFraction > 0.01)
      reasons.push(
        `飽和: 最大クリップ率 ${(maxClippedFraction * 100).toFixed(2)}%（1%以下必要）／RMS上限0.95`,
      );
    if (values.length && values.every((v) => v === 0))
      reasons.push("全サンプルが完全なゼロ: マイク入力・消音を確認");
    const spreadDb = values.length
      ? dbfs(percentile(values, 0.9)) - dbfs(percentile(values, 0.1))
      : null;
    if (c.speaker === 0 && spreadDb !== null && spreadDb > 12)
      reasons.push(
        `無音区間の変動 ${spreadDb.toFixed(1)}dB（12dB以下必要）: 発話・突発音を避けて再測定`,
      );
    if (c.speaker !== 0 && snr === null) reasons.push("静音STEP未完了");
    else if (snr !== null && snr < 6)
      reasons.push(`発話SNR ${snr.toFixed(1)}dB（6dB以上必要）`);
    quality[key] = {
      samples: rows.length,
      receivedSamples: received.length,
      rejectedSamples: rejected.length,
      expectedSamples,
      coverage,
      peak: Math.max(0, ...values),
      rms: values.length
        ? percentile(values, c.speaker === 0 ? 0.5 : 0.75)
        : null,
      dbfs: values.length ? dbfs(rms[key]) : null,
      noiseRms: c.speaker === 0 ? rms[key] : (study.noise[key] ?? null),
      noiseDb:
        c.speaker === 0
          ? dbfs(rms[key])
          : study.noise[key]
            ? dbfs(study.noise[key])
            : null,
      clippedFraction,
      maxClippedFraction,
      spreadDb,
      snr,
      lateSamples: received.filter((f) => f.receivedAt >= c.end).length,
      clockRejected: received.filter(
        (f) => f.uncertainty > study.config.maxUncertaintyMs,
      ).length,
      maxUncertaintyMs: Math.max(0, ...received.map((f) => f.uncertainty)),
      maxDelayMs: Math.max(
        0,
        ...received.map((f) => f.receivedAt - f.acquiredAt),
      ),
      settings: received.at(-1)?.settings ?? {},
      passed: reasons.length === 0,
      reasons,
    };
  }
  const failed = keys.filter((k) => !quality[k].passed);
  study.calibrationResults ||= {};
  study.calibrationResults[c.speaker] = {
    speaker: c.speaker,
    start: c.start,
    end: c.end,
    measuredAt: now,
    quality,
    passed: !failed.length,
  };
  if (failed.length)
    study.calibrationError = `STEP ${c.speaker + 1} 不合格。端末別の判定理由を確認し、このSTEPを再測定してください。`;
  else if (c.speaker === 0) study.noise = rms;
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
    calibrationResults: study.calibrationResults || {},
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
