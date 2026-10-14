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
    } else if (/^\/room\/[a-f0-9-]{36}$/.test(url.pathname)) {
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
    ctx.blockConcurrencyWhile(async () => {
      this.room = await ctx.storage.get("room");
    });
  }
  async fetch(req) {
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
  advance() {
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
      if (m.role === "host" && m.key === this.room.hostKey)
        a = { role: "host" };
      else if (
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
        person.voice = newVoice();
      } else {
        ws.close(1008, "Invalid credentials");
        return;
      }
      ws.serializeAttachment(a);
      this.broadcast();
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
      if (m.type === "start") {
        this.room.running = true;
        this.room.lastTick = now;
      }
      if (m.type === "stop") {
        this.room.running = false;
        this.room.active = null;
      }
      if (m.type === "reset") {
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
      if (m.type === "mic") {
        person.mic = m.mic === true;
        person.level = 0;
        person.vad = false;
      }
    }
    this.broadcast();
    if (
      !this.lastSave ||
      now - this.lastSave > 5000 ||
      ["start", "stop", "reset", "register", "name", "calibration"].includes(
        m.type,
      )
    ) {
      this.lastSave = now;
      await this.ctx.storage.put("room", this.room);
    }
  }
  async webSocketClose(ws) {
    const a = ws.deserializeAttachment();
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
