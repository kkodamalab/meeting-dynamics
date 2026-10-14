import {
  newStudy,
  ingest,
  startStudy,
  processStudy,
  beginCalibration,
  finishCalibration,
  studySummary,
  evaluate,
  intervals,
  defaults,
} from "../src/study.ts";
import {
  newVoice,
  updateVad,
  inferSpeaker,
  validCalibration,
} from "../src/audio.ts";
const cors = (origin) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  Vary: "Origin",
});
export default {
  async fetch(req, env) {
    const url = new URL(req.url),
      origin = req.headers.get("Origin");
    const allowed =
      origin === env.ALLOWED_ORIGIN ||
      /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin || "");
    if (origin && !allowed)
      return new Response("Origin denied", { status: 403 });
    const headers = cors(origin || env.ALLOWED_ORIGIN);
    if (req.method === "OPTIONS") return new Response(null, { headers });
    if (url.pathname === "/health")
      return Response.json({ ok: true }, { headers });
    let result;
    if (url.pathname === "/sessions" && req.method === "POST") {
      if (Number(req.headers.get("Content-Length") || 0) > 4096)
        return new Response("Too large", { status: 413, headers });
      const id = crypto.randomUUID();
      result = await env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(
        new Request("https://room/init", {
          method: "POST",
          body: JSON.stringify({ ...(await req.json()), id }),
        }),
      );
    } else if (/^\/room\/[a-f0-9-]{36}(?:\/export)?$/.test(url.pathname)) {
      result = await env.ROOMS.get(
        env.ROOMS.idFromName(url.pathname.split("/")[2]),
      ).fetch(req);
    } else return new Response("Not found", { status: 404, headers });
    if (result.status === 101) return result;
    return new Response(result.body, {
      status: result.status,
      headers: { ...Object.fromEntries(result.headers), ...headers },
    });
  },
};
export class Room {
  constructor(ctx) {
    this.ctx = ctx;
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS research_windows (epoch INTEGER, idx INTEGER, value TEXT, PRIMARY KEY(epoch, idx))",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS research_meta (id INTEGER PRIMARY KEY, value TEXT)",
    );
    ctx.blockConcurrencyWhile(async () => {
      this.room = await ctx.storage.get("room");
      const meta = Array.from(
        ctx.storage.sql.exec("SELECT value FROM research_meta WHERE id=1"),
      )[0];
      this.study = meta
        ? JSON.parse(meta.value)
        : await ctx.storage.get("study");
      if (this.study) {
        this.study.buffers = {};
        this.study.smooth = {};
        this.study.trace = Array.from(
          ctx.storage.sql.exec(
            "SELECT value FROM research_windows WHERE epoch=? ORDER BY idx DESC LIMIT 20",
            this.study.epoch,
          ),
        )
          .reverse()
          .map((row) => JSON.parse(row.value));
      }
      this.pendingTrace = new Set();
    });
  }
  async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/export")) {
      const request = await req.json();
      if (!this.room || request.hostKey !== this.room.hostKey)
        return new Response("Forbidden", { status: 403 });
      const summary = studySummary(this.study),
        pc = this.room.pc
          ? (({ voice, timing, ...p }) => p)(this.room.pc)
          : undefined;
      const metadata = {
        version: 2,
        sessionId: this.room.id,
        participants: this.room.people.map(({ voice, timing, ...p }) => p),
        pc,
      };
      const cursor = this.ctx.storage.sql
        .exec(
          "SELECT value FROM research_windows WHERE epoch=? ORDER BY idx",
          this.study.epoch,
        )
        [Symbol.iterator]();
      const encoder = new TextEncoder();
      let first = true,
        started = false;
      const stream = new ReadableStream({
        pull(controller) {
          if (!started) {
            started = true;
            controller.enqueue(
              encoder.encode(
                JSON.stringify(metadata).slice(0, -1) +
                  ',"study":' +
                  JSON.stringify(summary).slice(0, -1) +
                  ',"windows":[',
              ),
            );
          }
          for (let i = 0; i < 10; i++) {
            const row = cursor.next();
            if (row.done) {
              controller.enqueue(encoder.encode("]}}"));
              controller.close();
              return;
            }
            controller.enqueue(
              encoder.encode((first ? "" : ",") + row.value.value),
            );
            first = false;
          }
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (new URL(req.url).pathname === "/init") {
      if (this.room) return new Response("Already exists", { status: 409 });
      const body = await req.json();
      if (!Number.isInteger(body.count) || body.count < 2 || body.count > 10)
        return new Response("Invalid count", { status: 400 });
      const hostKey = crypto.randomUUID(),
        seatKeys = Array.from({ length: body.count }, () =>
          crypto.randomUUID(),
        );
      this.room = {
        id: body.id,
        hostKey,
        seatKeys,
        expires: Date.now() + 12 * 3600000,
        running: false,
        elapsed: 0,
        lastTick: Date.now(),
        active: null,
        people: seatKeys.map((_, i) => ({
          id: i + 1,
          name: `参加者 ${String.fromCharCode(65 + i)}`,
          connected: false,
          registered: false,
          mic: false,
          level: 0,
          vad: false,
          talkMs: 0,
          turns: 0,
          lastSample: 0,
        })),
      };
      this.study = newStudy(body.count);
      this.study.epoch = Date.now();
      this.pendingTrace = new Set();
      await this.ctx.storage.put("study", this.study);
      await this.ctx.storage.put("room", this.room);
      await this.ctx.storage.setAlarm(this.room.expires);
      return Response.json({ id: this.room.id, hostKey, seatKeys });
    }
    if (!this.room || Date.now() > this.room.expires)
      return new Response("Session expired", { status: 410 });
    if (req.headers.get("Upgrade") !== "websocket")
      return new Response("WebSocket required", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ role: "pending" });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async persistStudy() {
    if (!this.study) return;
    const { trace, buffers, smooth, ...meta } = this.study;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO research_meta (id,value) VALUES (1,?)",
      JSON.stringify(meta),
    );
    await this.ctx.storage.put("study", meta);
    this.pendingTrace.clear();
  }
  syncStudy(finish = false) {
    if (!this.room.studyEnabled || !this.study) return;
    const added = processStudy(
      this.study,
      Date.now(),
      this.room.people,
      finish,
    );
    added.forEach((window, i) => {
      const value = JSON.stringify(window);
      this.study.recordedBytes += new TextEncoder().encode(value).length;
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO research_windows (epoch,idx,value) VALUES (?,?,?)",
        this.study.epoch,
        this.study.recordedWindows - added.length + i,
        value,
      );
    });
    if (this.study.recordedBytes >= this.study.byteLimit)
      this.study.running = false;
    if (added.length) {
      const { trace, buffers, smooth, ...meta } = this.study;
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO research_meta (id,value) VALUES (1,?)",
        JSON.stringify(meta),
      );
    }
    const selected =
      this.study.mode === "reference" ? this.study.B : this.study.A;
    this.room.elapsed = selected.elapsedMs;
    this.room.unknownMs = selected.unknownMs;
    this.room.silenceMs = selected.silenceMs;
    this.room.missingMs = selected.missingMs;
    this.room.overlapMs = selected.overlapMs;
    selected.people.forEach((p, i) => Object.assign(this.room.people[i], p));
    const last =
      this.study.trace.at(-1)?.[this.study.mode === "reference" ? "B" : "A"];
    if (last) {
      this.room.active = last.id;
      this.room.confidence = last.confidence;
      this.room.reason = last.reason;
    }
    if (!this.study.running && this.room.running) {
      this.room.running = false;
      this.room.reason = "記録上限（60分または32MiB）に到達";
    }
  }
  acceptStudyFrame(person, m, channel, now) {
    this.study ||= newStudy(this.room.people.length);
    const uncertainty = Number.isFinite(m.clockUncertainty)
      ? Math.min(10000, Math.max(0, m.clockUncertainty))
      : 999;
    const acquiredAt = Number.isFinite(m.acquiredAt) ? m.acquiredAt : now;
    person.peak = Number.isFinite(m.peak)
      ? Math.min(1, Math.max(0, m.peak))
      : undefined;
    person.clippedFraction = Number.isFinite(m.clippedFraction)
      ? Math.min(1, Math.max(0, m.clippedFraction))
      : 0;
    ingest(this.study, {
      channel,
      clockOffsetMs: m.clockOffsetMs,
      roundTripMs: m.roundTripMs,
      capturedMonotonic: Number.isFinite(m.monotonic)
        ? m.monotonic - (m.captureAgeMs || 0)
        : undefined,
      peak: person.peak,
      clippedFraction: person.clippedFraction,
      seq: person.seq,
      acquiredAt,
      receivedAt: now,
      rawRms: person.rawRms,
      vad: person.vad,
      snr: person.snr,
      dbfs: person.dbfs,
      noiseDb: person.noiseDb,
      correctedDb: person.correctedDb,
      uncertainty,
      settings: person.settings,
      healthy:
        person.mic &&
        (!person.audioState || person.audioState === "running") &&
        !person.trackMuted,
    });
    this.study.clock[channel] = {
      offsetMs: Number.isFinite(m.clockOffsetMs) ? m.clockOffsetMs : null,
      roundTripMs: Number.isFinite(m.roundTripMs) ? m.roundTripMs : null,
      uncertaintyMs: uncertainty,
      receivedAt: now,
      acquiredAt,
      delayMs: now - acquiredAt,
      sequence: person.seq,
    };
  }
  advance() {
    if (this.room.studyEnabled) {
      this.syncStudy();
      return;
    }
    const now = Date.now(),
      dt = Math.min(500, Math.max(0, now - this.room.lastTick));
    this.room.lastTick = now;
    if (!this.room.running) return;
    this.room.elapsed += dt;
    const decision = inferSpeaker(this.room.people, now);
    if (decision.id !== this.room.pendingSpeaker) {
      this.room.pendingSpeaker = decision.id;
      this.room.pendingSince = now;
    }
    const stable =
      decision.id !== null && now - (this.room.pendingSince || now) >= 250;
    const active = stable ? decision.id : null;
    this.room.confidence = stable ? decision.confidence : 0;
    this.room.reason =
      decision.id && !stable ? "判定安定待ち" : decision.reason;
    if (active !== null) {
      const p = this.room.people.find((p) => p.id === active);
      p.talkMs += dt;
      p.confidenceMs = (p.confidenceMs || 0) + dt * decision.confidence;
      if (active !== this.room.active) p.turns++;
    } else if (decision.speech)
      this.room.unknownMs = (this.room.unknownMs || 0) + dt;
    else this.room.silenceMs = (this.room.silenceMs || 0) + dt;
    this.room.active = active;
  }
  snapshot() {
    return {
      type: "state",
      id: this.room.id,
      running: this.room.running,
      elapsed: this.room.elapsed,
      active: this.room.active,
      serverTime: Date.now(),
      unknownMs: this.room.unknownMs || 0,
      silenceMs: this.room.silenceMs || 0,
      confidence: this.room.confidence || 0,
      reason: this.room.reason || "無音",
      pc: this.room.pc
        ? (({ voice, timing, ...p }) => p)(this.room.pc)
        : undefined,
      research: this.study ? studySummary(this.study) : undefined,
      missingMs: this.room.missingMs || 0,
      overlapMs: this.room.overlapMs || 0,
      people: this.room.people.map(({ voice, timing, ...p }) => p),
    };
  }
  broadcast() {
    const state = JSON.stringify(this.snapshot());
    for (const ws of this.ctx.getWebSockets())
      if (ws.deserializeAttachment()?.role !== "pending") {
        try {
          ws.send(state);
        } catch {}
      }
  }
  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 4096) {
      ws.close(1008, "Invalid message");
      return;
    }
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      ws.close(1008, "Invalid JSON");
      return;
    }
    let a = ws.deserializeAttachment();
    if (a.role === "pending") {
      if (m.type !== "auth") {
        ws.close(1008, "Authentication required");
        return;
      }
      if (m.role === "host" && m.key === this.room.hostKey) {
        a = { role: "host" };
        if (this.room.pc) this.room.pc.seq = -1;
        if (this.study) {
          this.study.lastSeq.pc = -1;
          this.study.buffers.pc = [];
        }
      } else if (
        m.role === "seat" &&
        Number.isInteger(m.seat) &&
        this.room.seatKeys[m.seat - 1] === m.key
      ) {
        if (
          this.ctx
            .getWebSockets()
            .some((s) => s !== ws && s.deserializeAttachment()?.seat === m.seat)
        ) {
          ws.close(1008, "Seat already connected");
          return;
        }
        a = { role: "seat", seat: m.seat };
        this.room.people[m.seat - 1].connected = true;
        const person = this.room.people[m.seat - 1];
        person.timing = null;
        person.seq = -1;
        if (this.study) {
          this.study.lastSeq[String(m.seat)] = -1;
          this.study.buffers[String(m.seat)] = [];
        }
        person.voice = newVoice();
      } else {
        ws.close(1008, "Invalid credentials");
        return;
      }
      ws.serializeAttachment(a);
      this.broadcast();
      return;
    }
    if (m.type === "sync") {
      ws.send(
        JSON.stringify({
          type: "sync",
          nonce: m.nonce,
          serverTime: Date.now(),
        }),
      );
      return;
    }
    // Limit messages from each socket; never accept audio buffers.
    const now = Date.now();
    if (
      ["sample", "tick"].includes(m.type) &&
      a.lastSampleMessage &&
      now - a.lastSampleMessage < 75
    )
      return;
    if (["sample", "tick"].includes(m.type)) a.lastSampleMessage = now;
    a.lastMessage = now;
    ws.serializeAttachment(a);
    this.advance();
    if (a.role === "host") {
      if (m.type === "configure-study" && !this.room.running) {
        this.study ||= newStudy(this.room.people.length);
        if (!this.room.studyEnabled && this.room.elapsed > 0) {
          this.study.legacyMs = this.room.elapsed;
          Object.assign(this.study.A, {
            elapsedMs: this.room.elapsed,
            speechMs:
              this.room.people.reduce((s, p) => s + p.talkMs, 0) +
              (this.room.unknownMs || 0) +
              (this.room.overlapMs || 0),
            unknownMs: this.room.unknownMs || 0,
            silenceMs: this.room.silenceMs || 0,
            missingMs: this.room.missingMs || 0,
            overlapMs: this.room.overlapMs || 0,
            people: this.room.people.map((p) => ({
              id: p.id,
              talkMs: p.talkMs,
              turns: p.turns,
              confidenceMs: p.confidenceMs || 0,
            })),
          });
          this.study.B.elapsedMs = this.room.elapsed;
          this.study.B.missingMs = this.room.elapsed;
        }
        this.room.studyEnabled = true;
        this.study.mode = m.mode === "reference" ? "reference" : "smartphone";
        const layout = m.layout;
        if (
          layout &&
          Array.isArray(layout.positions) &&
          layout.positions.length === this.room.people.length &&
          layout.positions.every(
            (p) =>
              Number.isFinite(p.x) &&
              Number.isFinite(p.y) &&
              p.x >= 0 &&
              p.x <= 100 &&
              p.y >= 0 &&
              p.y <= 100,
          ) &&
          Number.isFinite(layout.pcPosition?.x) &&
          Number.isFinite(layout.pcPosition?.y)
        ) {
          this.study.layout = layout;
        }
        for (const key of ["gapMs", "minTurnMs"])
          if (Number.isFinite(m.config?.[key]))
            this.study.config[key] = Math.max(
              100,
              Math.min(2000, m.config[key]),
            );
      }
      if (m.type === "pc-mic" && m.mic === true && this.study) {
        this.study.profiles = {};
        this.study.noise = {};
      }
      if (m.type === "pc-mic") {
        this.room.pc ||= {
          id: 0,
          name: "PC MIC",
          connected: true,
          registered: false,
          mic: false,
          level: 0,
          vad: false,
          talkMs: 0,
          turns: 0,
        };
        this.room.pc.mic = m.mic === true;
        if (!m.mic) {
          this.room.pc.connected = false;
          this.room.pc.vad = false;
        }
      }
      if (m.type === "pc-sample" && Number.isFinite(m.rawRms)) {
        const pc = (this.room.pc ||= {
          id: 0,
          name: "PC MIC",
          registered: false,
          talkMs: 0,
          turns: 0,
        });
        if (Number.isInteger(m.seq) && m.seq > (pc.seq ?? -1)) {
          const previous = pc.lastSample;
          pc.voice ||= newVoice();
          Object.assign(
            pc,
            updateVad(
              pc.voice,
              m.rawRms,
              previous ? now - previous : 100,
              pc.calibration,
            ),
          );
          Object.assign(pc, {
            connected: true,
            mic: m.mic === true,
            seq: m.seq,
            lastSample: now,
            level: m.rawRms * 100,
            audioState: m.audioState,
            trackMuted: m.trackMuted === true,
            settings: m.settings,
          });
          this.acceptStudyFrame(pc, m, "pc", now);
        }
      }
      if (
        m.type === "calibration-step" &&
        !this.room.running &&
        this.study?.mode === "reference" &&
        Number.isInteger(m.speaker) &&
        m.speaker >= 0 &&
        m.speaker <= this.room.people.length
      ) {
        if (m.speaker === 0) {
          for (const p of this.room.people) delete p.calibration;
          if (this.room.pc) delete this.room.pc.calibration;
        }
        beginCalibration(this.study, m.speaker, now);
      }
      if (
        m.type === "label" &&
        this.study?.running &&
        Array.isArray(m.speakers) &&
        m.speakers.every(
          (id) =>
            Number.isInteger(id) && id > 0 && id <= this.room.people.length,
        ) &&
        this.study.labels.length < 600
      ) {
        const at =
          Number.isFinite(m.acquiredAt) && Math.abs(now - m.acquiredAt) < 2000
            ? m.acquiredAt
            : now;
        const previous = this.study.labels.at(-1);
        if (previous && at < previous.start) return;
        if (previous && !previous.end) previous.end = at;
        this.study.labels.push({
          start: at,
          speakers: [...new Set(m.speakers)],
        });
        this.study.dataSource =
          m.source === "synthetic" ? "synthetic" : "human-labeled-live";
      }
      if (m.type === "start") {
        if(this.room.studyEnabled&&(this.study.recordedWindows>=this.study.recordingLimit||this.study.recordedBytes>=this.study.byteLimit)){ws.send(JSON.stringify({type:"study-error",message:"記録上限です。結果を出力してから新しいセッションまたはリセットを選択してください。"}));return;}
        if (
          this.room.studyEnabled &&
          this.study.mode === "reference" &&
          (!studySummary(this.study).ready || !this.room.pc?.mic)
        ) {
          ws.send(
            JSON.stringify({
              type: "study-error",
              message: "PCマイクと共同キャリブレーションが必要です",
            }),
          );
          this.broadcast();
          return;
        }
        if (this.room.studyEnabled) startStudy(this.study, now);
        this.room.running = true;
        this.room.lastTick = now;
      }
      if (m.type === "stop") {
        this.syncStudy(true);
        this.room.running = false;
        this.room.active = null;
      }
      if (m.type === "reset") {
        this.ctx.storage.sql.exec("DELETE FROM research_windows");
        if (this.study) {
          const previous = this.study;
          this.study = newStudy(previous.count, previous.mode);
          Object.assign(this.study, {
            layout: previous.layout,
            config: previous.config,
            noise: previous.noise,
            profiles: previous.profiles,
            buffers: previous.buffers,
            lastSeq: previous.lastSeq,
            epoch: Date.now(),
          });
          this.pendingTrace.clear();
        }
        this.room.running = false;
        this.room.elapsed = 0;
        this.room.unknownMs = 0;
        this.room.silenceMs = 0;
        this.room.pendingSpeaker = null;
        this.room.confidence = 0;
        this.room.active = null;
        this.room.people.forEach((p) => {
          p.talkMs = 0;
          p.confidenceMs = 0;
          p.turns = 0;
        });
      }
      if (
        m.type === "name" &&
        Number.isInteger(m.seat) &&
        this.room.people[m.seat - 1]
      )
        this.room.people[m.seat - 1].name = String(m.name).slice(0, 80);
    } else {
      const person = this.room.people[a.seat - 1];
      if (m.type === "register") {
        person.name = String(m.name).trim().slice(0, 80) || person.name;
        person.mic = m.mic === true;
        person.registered = !!String(m.name).trim() && person.mic;
      }
      if (m.type === "calibration-reset") {
        if (this.study?.mode === "reference") {
          this.study.profiles = {};
          this.study.calibrationError =
            "スマホの再取得後は共同校正をやり直してください";
        }
        delete person.calibration;
        person.voice = newVoice();
      }
      if (m.type === "calibration" && validCalibration(m.calibration)) {
        person.calibration = {
          noiseRms: m.calibration.noiseRms,
          speechRms: m.calibration.speechRms,
        };
        person.voice = newVoice();
      }
      if (
        m.type === "sample" &&
        (Number.isFinite(m.rawRms) || Number.isFinite(m.level))
      ) {
        if (Number.isFinite(m.seq) && m.seq <= (person.seq ?? -1)) return;
        const previous = person.lastSample;
        person.lastSample = now;
        person.seq = Number.isFinite(m.seq) ? m.seq : (person.seq || 0) + 1;
        const rms = Number.isFinite(m.rawRms) ? m.rawRms : m.level / 100;
        person.voice ||= newVoice();
        Object.assign(
          person,
          updateVad(
            person.voice,
            rms,
            previous ? now - previous : 100,
            person.calibration,
          ),
        );
        person.protocol = Number.isFinite(m.rawRms) ? 2 : 1;
        if (person.protocol === 1) delete person.calibration;
        person.audioState = [
          "running",
          "suspended",
          "closed",
          "interrupted",
        ].includes(m.audioState)
          ? m.audioState
          : undefined;
        person.trackMuted = m.trackMuted === true;
        person.level = person.rawRms * 100;
        person.mic = m.mic === true;
        person.calibrating = m.calibrating === true;
        if (Number.isFinite(m.monotonic)) {
          person.timing ||= { server: now, client: m.monotonic };
          person.sampleDelayMs =
            Math.max(
              0,
              now - person.timing.server - (m.monotonic - person.timing.client),
            ) + Math.max(0, Math.min(10000, Number(m.captureAgeMs) || 0));
        }
        if (m.settings && typeof m.settings === "object")
          person.settings = Object.fromEntries(
            [
              "echoCancellation",
              "noiseSuppression",
              "autoGainControl",
              "sampleRate",
              "channelCount",
            ]
              .filter(
                (k) =>
                  typeof m.settings[k] === "boolean" ||
                  Number.isFinite(m.settings[k]),
              )
              .map((k) => [k, m.settings[k]]),
          );
      }
      if (m.type === "sample" && Number.isFinite(person.rawRms))
        this.acceptStudyFrame(person, m, String(person.id), now);
      if (m.type === "mic") {
        person.mic = m.mic === true;
        person.level = 0;
        person.vad = false;
      }
    }
    if (this.study?.calibration && finishCalibration(this.study, now)) {
      for (const p of this.room.people) {
        if (this.study.noise[p.id]) {
          p.voice ||= newVoice();
          p.voice.noiseRms = this.study.noise[p.id];
        }
        const own = this.study.profiles[p.id];
        if (own)
          p.calibration = {
            noiseRms: this.study.noise[p.id],
            speechRms: own.rms[p.id],
          };
      }
      if (this.room.pc && this.study.noise.pc)
        this.room.pc.calibration = {
          noiseRms: this.study.noise.pc,
          speechRms: Math.max(
            ...Object.values(this.study.profiles).map((p) => p.rms.pc),
            this.study.noise.pc * 4,
          ),
        };
    }
    this.broadcast();
    if (
      !this.lastSave ||
      now - this.lastSave > 5000 ||
      [
        "start",
        "stop",
        "reset",
        "register",
        "name",
        "calibration",
        "configure-study",
        "calibration-step",
        "label",
        "pc-mic",
      ].includes(m.type)
    ) {
      this.lastSave = now;
      const { voice, timing, ...pc } = this.room.pc || {};
      await this.ctx.storage.put("room", {
        ...this.room,
        pc: this.room.pc ? pc : undefined,
      });
      await this.persistStudy();
    }
  }
  async webSocketClose(ws) {
    const a = ws.deserializeAttachment();
    if (a?.role === "host" && this.room?.pc) {
      this.room.pc.connected = false;
      this.room.pc.mic = false;
    }
    if (a?.role === "seat" && this.room) {
      this.advance();
      const p = this.room.people[a.seat - 1];
      p.connected = false;
      p.mic = false;
      p.level = 0;
      p.vad = false;
      this.broadcast();
      await this.ctx.storage.put("room", this.room);
    }
    ws.close();
  }
  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
  async alarm() {
    for (const ws of this.ctx.getWebSockets())
      ws.close(1000, "Session expired");
    await this.ctx.storage.deleteAll();
    this.room = null;
  }
}
