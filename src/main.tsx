import {
  newVoice,
  updateVad,
  validCalibration,
  percentile,
  dbfs,
  type Calibration,
} from "./audio";
import { AudioDiagnostics } from "./AudioDiagnostics";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import {
  configuredEndpoint,
  createSession,
  joinLink,
  normalizeEndpoint,
  useRoom,
  type Person,
  type Session,
} from "./realtime";
import {
  csv,
  initialLayout,
  seats,
  type Layout,
  type Position,
} from "./layout";
import "./styles.css";
const colors = [
  "#2563eb",
  "#0ea5e9",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#14b8a6",
  "#84cc16",
  "#eab308",
  "#64748b",
  "#ef4444",
];
const format = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
function QR({ link, name }: { link: string; name: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(link, {
      width: 220,
      margin: 2,
      errorCorrectionLevel: "M",
    }).then((s) => {
      if (alive) setSrc(s);
    });
    return () => {
      alive = false;
    };
  }, [link]);
  return (
    <div className="qr">
      <img src={src || undefined} alt={`${name} の参加QR`} />
      <a href={link} target="_blank" rel="noreferrer">
        {name} の参加リンク
      </a>
    </div>
  );
}
function Room({
  people,
  layout,
  setLayout,
  active,
  links,
}: {
  people: Person[];
  layout: Layout;
  setLayout?: (l: Layout) => void;
  active?: number | null;
  links?: string[];
}) {
  const drag = useRef<{
    kind: "seat" | "move" | "resize";
    id?: number;
    start: Position;
    layout: Layout;
  } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const g = layout.geometry;
  const point = (e: React.PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * 100,
      y: ((e.clientY - r.top) / r.height) * 100,
    };
  };
  const down = (
    e: React.PointerEvent,
    kind: "seat" | "move" | "resize",
    id?: number,
  ) => {
    if (!setLayout) return;
    e.preventDefault();
    e.stopPropagation();
    stage.current!.setPointerCapture(e.pointerId);
    drag.current = {
      kind,
      id,
      start: point(e),
      layout: structuredClone(layout),
    };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !setLayout) return;
    const p = point(e),
      dx = p.x - d.start.x,
      dy = p.y - d.start.y;
    const next = structuredClone(d.layout);
    if (d.kind === "seat")
      next.positions[d.id! - 1] = {
        x: Math.max(5, Math.min(95, d.layout.positions[d.id! - 1].x + dx)),
        y: Math.max(5, Math.min(95, d.layout.positions[d.id! - 1].y + dy)),
      };
    else if (d.kind === "move") {
      const tx = Math.max(
        Math.max(
          12 - d.layout.geometry.x,
          5 - Math.min(...d.layout.positions.map((s) => s.x)),
        ),
        Math.min(
          Math.min(
            88 - d.layout.geometry.x - d.layout.geometry.width,
            95 - Math.max(...d.layout.positions.map((s) => s.x)),
          ),
          dx,
        ),
      );
      const ty = Math.max(
        Math.max(
          12 - d.layout.geometry.y,
          5 - Math.min(...d.layout.positions.map((s) => s.y)),
        ),
        Math.min(
          Math.min(
            88 - d.layout.geometry.y - d.layout.geometry.height,
            95 - Math.max(...d.layout.positions.map((s) => s.y)),
          ),
          dy,
        ),
      );
      next.geometry.x += tx;
      next.geometry.y += ty;
      next.positions = next.positions.map((s) => ({
        x: s.x + tx,
        y: s.y + ty,
      }));
    } else {
      const old = next.geometry;
      const w = Math.max(20, Math.min(88 - old.x, old.width + dx)),
        h = Math.max(20, Math.min(88 - old.y, old.height + dy));
      next.positions = next.positions.map((s) => ({
        x: old.x + ((s.x - old.x) * w) / old.width,
        y: old.y + ((s.y - old.y) * h) / old.height,
      }));
      next.geometry.width = w;
      next.geometry.height = h;
    }
    setLayout(next);
  };
  return (
    <div
      ref={stage}
      className={`room-stage ${links ? "with-qr" : ""}`}
      onPointerMove={move}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <div
        className={`table-shape ${layout.shape}`}
        style={{
          left: `${g.x}%`,
          top: `${g.y}%`,
          width: `${g.width}%`,
          height: `${g.height}%`,
        }}
        onPointerDown={(e) => down(e, "move")}
        aria-label="会議テーブル"
      >
        <span>{setLayout ? "ドラッグで移動" : ""}</span>
        {setLayout && (
          <button
            className="resize"
            aria-label="図形を変形"
            onPointerDown={(e) => down(e, "resize")}
          >
            ↘
          </button>
        )}
      </div>
      {people.map((p, i) => (
        <div
          key={p.id}
          className={`avatar ${active === p.id ? "speaking" : ""} ${links ? "qr-seat" : ""}`}
          style={{
            left: `${layout.positions[i]?.x ?? 50}%`,
            top: `${layout.positions[i]?.y ?? 50}%`,
          }}
        >
          <div
            onPointerDown={(e) => down(e, "seat", p.id)}
            aria-label={`${p.name} の座席`}
          >
            <b style={{ background: colors[i] }}>
              <svg
                viewBox="0 0 24 24"
                width="28"
                height="28"
                aria-hidden="true"
              >
                <circle cx="12" cy="5" r="3" fill="currentColor" />
                <path
                  d="M8 10h8l2 7h-3v6h-2v-6h-2v6H9v-6H6z"
                  fill="currentColor"
                />
              </svg>
            </b>
            <span>{p.name}</span>
          </div>
          {links ? (
            <QR link={links[i]} name={p.name} />
          ) : (
            <em>
              {p.connected ? (p.mic ? "マイク OK" : "マイク待ち") : "未接続"}
            </em>
          )}
        </div>
      ))}
    </div>
  );
}
function App() {
  const params = new URLSearchParams(location.hash.replace(/^#join\?/, ""));
  if (location.hash.startsWith("#join?"))
    return <Participant params={params} />;
  return <Host />;
}
function Host() {
  const [session, setSession] = useState<Session | null>(() => {
    try {
      return JSON.parse(localStorage.getItem("meeting-session") || "null");
    } catch {
      return null;
    }
  });
  const [page, setPage] = useState<
    "home" | "register" | "layout" | "live" | "report"
  >("home");
  const [count, setCount] = useState(5),
    [shape, setShape] = useState<"circle" | "rect">("circle");
  const [endpoint, setEndpoint] = useState(configuredEndpoint),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState<"single" | "bulk">("single"),
    [seat, setSeat] = useState(1);
  const [layout, setLayout] = useState<Layout>(initialLayout(5, "circle")),
    [notice, setNotice] = useState("");
  const [options, setOptions] = useState({
    turns: true,
    average: true,
    csv: true,
    json: true,
  });
  const { state, status, send } = useRoom(
    session?.endpoint || "",
    session?.id || "",
    "host",
    session?.hostKey || "",
  );
  const people =
    state?.people ||
    Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      name: `参加者 ${String.fromCharCode(65 + i)}`,
      connected: false,
      registered: false,
      mic: false,
      level: 0,
      vad: false,
      talkMs: 0,
      turns: 0,
    }));
  useEffect(() => {
    if (page === "live" && state?.running) {
      const id = setInterval(() => send({ type: "tick" }), 100);
      return () => clearInterval(id);
    }
  }, [page, state?.running, status]);
  const restoreLayout = (n: number, s: "circle" | "rect") => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`meeting-layout-${n}-${s}`) || "null",
      );
      setLayout(saved?.positions?.length === n ? saved : initialLayout(n, s));
    } catch {
      setLayout(initialLayout(n, s));
    }
  };
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await createSession(endpoint, count);
      setSession(result);
      localStorage.setItem("meeting-session", JSON.stringify(result));
      localStorage.setItem("meeting-relay", result.endpoint);
      restoreLayout(count, shape);
      setSeat(1);
      setPage("register");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const changeShape = (s: "circle" | "rect") => {
    setShape(s);
    setLayout(initialLayout(people.length, s));
  };
  const save = () => {
    localStorage.setItem(
      `meeting-layout-${people.length}-${layout.shape}`,
      JSON.stringify(layout),
    );
    setNotice("配置を保存しました。次回の同じ人数・図形で復元します。");
  };
  const download = (kind: "csv" | "json") => {
    const rows = people.map((p) => ({
      name: p.name,
      speakingSeconds: +(p.talkMs / 1000).toFixed(1),
      turns: p.turns,
      unknownSeconds: +((state?.unknownMs || 0) / 1000).toFixed(2),
      confidence: p.talkMs ? (p.confidenceMs || 0) / p.talkMs : 0,
    }));
    const url = URL.createObjectURL(
      new Blob([kind === "csv" ? csv(rows) : JSON.stringify(rows, null, 2)], {
        type: kind === "csv" ? "text/csv;charset=utf-8" : "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `meeting-dynamics.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const total =
    people.reduce((s, p) => s + p.talkMs, 0) + (state?.unknownMs || 0) || 1;
  const connected = status === "接続済み";
  return (
    <main>
      <header>
        <button className="brand" onClick={() => setPage("home")}>
          ◉ <span>Meeting Dynamics</span>
        </button>
        <span role="status">{session ? status : "セッション未作成"}</span>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {page === "home" && (
        <section className="hero">
          <p className="lead">
            スマホのマイクで発話量をリアルタイムに可視化。音声は録音・送信・保存せず、音量と発話状態だけを共有します。
          </p>
          <div className="card settings">
            <label>
              話者数
              <select
                aria-label="話者数"
                value={count}
                onChange={(e) => setCount(+e.target.value)}
              >
                {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <label>
              部屋レイアウト
              <select
                aria-label="部屋レイアウト"
                value={shape}
                onChange={(e) => setShape(e.target.value as any)}
              >
                <option value="circle">円形</option>
                <option value="rect">長方形（初期は正方形）</option>
              </select>
            </label>
            <label className="relay-field">
              中継サーバー URL
              <input
                placeholder="https://meeting-dynamics-relay.…workers.dev"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </label>
            <div className="options">
              {Object.entries({
                turns: "発話回数",
                average: "平均発話時間",
                csv: "CSV 出力",
                json: "JSON 出力",
              }).map(([k, label]) => (
                <label key={k} className="check">
                  <input
                    type="checkbox"
                    checked={options[k]}
                    onChange={() => setOptions((o) => ({ ...o, [k]: !o[k] }))}
                  />
                  {label}
                </label>
              ))}
            </div>
            <button
              className="primary"
              disabled={busy || !endpoint}
              onClick={create}
            >
              {busy ? "接続中…" : "セッションを作成"}
            </button>
            {session && (
              <button
                onClick={() => {
                  restoreLayout(session.seatKeys.length, shape);
                  setPage("register");
                }}
              >
                前のセッションを再開
              </button>
            )}
          </div>
        </section>
      )}
      {page === "register" && (
        <section>
          <h1>参加者を登録</h1>
          <p>
            各座席の固有QRをスマートフォンで読み取り、名前とマイクを登録してください。
          </p>
          <div className="seg">
            <button
              className={mode === "single" ? "selected" : ""}
              onClick={() => setMode("single")}
            >
              1人ずつ登録
            </button>
            <button
              className={mode === "bulk" ? "selected" : ""}
              onClick={() => setMode("bulk")}
            >
              一括登録
            </button>
          </div>
          {mode === "single" ? (
            <div className="card single-qr">
              <label>
                座席
                <select value={seat} onChange={(e) => setSeat(+e.target.value)}>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              {session && (
                <QR
                  link={joinLink(session, seat)}
                  name={people[seat - 1]?.name || ""}
                />
              )}
              <p>
                {people[seat - 1]?.connected ? "接続済み" : "未接続"} ·{" "}
                {people[seat - 1]?.mic ? "マイク OK" : "マイク待ち"}
              </p>
              <button
                disabled={seat === people.length}
                onClick={() => setSeat((s) => s + 1)}
              >
                次の参加者
              </button>
            </div>
          ) : (
            <Room
              people={people}
              layout={layout}
              links={
                session ? people.map((p) => joinLink(session, p.id)) : undefined
              }
            />
          )}
          <div className="list">
            {people.map((p) => (
              <div className="person-row" key={p.id}>
                <span>{p.name}</span>
                <span className={p.connected ? "status ok" : "status"}>
                  {p.connected
                    ? p.registered
                      ? "登録済み"
                      : "接続済み・未登録"
                    : "未接続"}
                </span>
                <span className={p.mic ? "status ok" : "status"}>
                  {p.mic ? "マイク OK" : "マイク待ち"}
                </span>
              </div>
            ))}
          </div>
          <div className="actions">
            <button
              className="primary"
              disabled={!connected}
              onClick={() => setPage("layout")}
            >
              座席配置へ進む
            </button>
          </div>
        </section>
      )}
      {page === "layout" && (
        <section>
          <h1>座席を配置</h1>
          <p>
            人型をドラッグして配置。テーブルをドラッグして移動し、右下のハンドルで縦横を変形できます。
          </p>
          <div className="toolbar">
            <div className="seg">
              <button onClick={() => changeShape("circle")}>円形</button>
              <button onClick={() => changeShape("rect")}>長方形</button>
            </div>
            <button
              onClick={() =>
                setLayout({
                  ...layout,
                  positions: seats(
                    people.length,
                    layout.shape,
                    layout.geometry,
                  ),
                })
              }
            >
              均等配置に戻す
            </button>
          </div>
          <Room people={people} layout={layout} setLayout={setLayout} />
          <p role="status">{notice}</p>
          <div className="actions">
            <button onClick={save}>配置を保存</button>
            <button
              className="primary"
              disabled={!connected}
              onClick={() => setPage("live")}
            >
              計測画面へ進む
            </button>
          </div>
        </section>
      )}
      {page === "live" && (
        <section>
          <div className="livehead">
            <h2>{state?.running ? "計測中" : "計測の準備"}</h2>
            <strong className="timer">{format(state?.elapsed || 0)}</strong>
          </div>
          <p>
            接続した参加者の実際のマイク音量・VADで集計します。
            {
              people.filter((p) => p.connected && p.registered && p.mic).length
            }{" "}
            人がマイク接続中
          </p>
          <div className="dashboard">
            <div className="card">
              <Room people={people} layout={layout} active={state?.active} />
            </div>
            <div className="card summary">
              <h3>発話量サマリー</h3>
              {people.map((p) => (
                <div className="metric" key={p.id}>
                  <div>
                    <span>{p.name}</span>
                    <b>
                      {format(p.talkMs)} ·{" "}
                      {Math.round((p.talkMs / total) * 100)}%
                    </b>
                  </div>
                  <div className="bar">
                    <i
                      style={{
                        width: `${(p.talkMs / total) * 100}%`,
                        background: colors[p.id - 1],
                      }}
                    />
                  </div>
                  <small>
                    音量 {p.level.toFixed(0)} · {p.vad ? "発話中" : "無音"}
                    {options.turns && ` · 発話回数 ${p.turns}`}
                    {options.average &&
                      ` · 平均 ${p.turns ? format(p.talkMs / p.turns) : "0:00"}`}
                  </small>
                </div>
              ))}
            </div>
          </div>
          <AudioDiagnostics people={people} state={state} />
          <p>
            話者不明 {format(state?.unknownMs || 0)} · 判定信頼度{" "}
            {Math.round((state?.confidence || 0) * 100)}% ·{" "}
            {state?.reason || "無音"}
          </p>
          <div className="actions">
            <button
              disabled={
                !connected ||
                !people.some((p) => p.connected && p.registered && p.mic)
              }
              className="primary"
              onClick={() => send({ type: state?.running ? "stop" : "start" })}
            >
              {state?.running
                ? "一時停止"
                : state?.elapsed
                  ? "再開"
                  : "計測開始"}
            </button>
            <button
              disabled={!connected}
              onClick={() => send({ type: "reset" })}
            >
              リセット
            </button>
            <button
              disabled={!connected}
              onClick={() => {
                send({ type: "stop" });
                setPage("report");
              }}
            >
              計測終了
            </button>
          </div>
        </section>
      )}
      {page === "report" && (
        <section>
          <h1>会議のふり返り</h1>
          <p>
            話者不明 {format(state?.unknownMs || 0)} · 無音／受信不足{" "}
            {format(state?.silenceMs || 0)}
          </p>
          <p>全体 {format(state?.elapsed || 0)}</p>
          <div className="card">
            {people.map((p) => (
              <div className="metric" key={p.id}>
                <b>{p.name}</b>　{format(p.talkMs)} ·{" "}
                {Math.round((p.talkMs / total) * 100)}%　{p.turns} 回
                <div className="bar">
                  <i
                    style={{
                      width: `${(p.talkMs / total) * 100}%`,
                      background: colors[p.id - 1],
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="actions">
            {options.csv && (
              <button disabled={state?.running} onClick={() => download("csv")}>
                CSV をダウンロード
              </button>
            )}
            {options.json && (
              <button disabled={state?.running} onClick={() => download("json")}>
                JSON をダウンロード
              </button>
            )}
            <button onClick={() => setPage("home")}>新しいセッション</button>
          </div>
        </section>
      )}
    </main>
  );
}
function Participant({ params }: { params: URLSearchParams }) {
  let endpoint = "";
  try {
    endpoint = normalizeEndpoint(params.get("relay") || configuredEndpoint);
  } catch {}
  const seat = Number(params.get("seat"));
  const { state, status, send } = useRoom(
    endpoint,
    params.get("session") || "",
    "seat",
    params.get("key") || "",
    seat,
  );
  const [name, setName] = useState(""),
    [mic, setMic] = useState(false),
    [level, setLevel] = useState(0),
    [joined, setJoined] = useState(false),
    [error, setError] = useState("");
  const [processing, setProcessing] = useState({
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  });
  const [settings, setSettings] = useState<MediaTrackSettings>({});
  const [calibration, setCalibration] = useState<Calibration | undefined>();
  const calibrationRef = useRef<Calibration | undefined>(undefined);
  const draft = useRef({ noiseRms: 0, speechRms: 0 });
  const voice = useRef(newVoice());
  const [phase, setPhase] = useState("");
  const [calibrationNote, setCalibrationNote] = useState("");
  const collection = useRef<{
    kind: "noise" | "speech";
    start: number;
    values: number[];
  } | null>(null);
  const sequence = useRef(0);
  const media = useRef<MediaStream | null>(null),
    audio = useRef<AudioContext | null>(null),
    interval = useRef<ReturnType<typeof setInterval> | null>(null),
    sample = useRef({ level: 0, vad: false, rawRms: 0, captured: 0 });
  const stop = () => {
    if (interval.current) clearInterval(interval.current);
    media.current?.getTracks().forEach((t) => t.stop());
    audio.current?.close();
    media.current = null;
    audio.current = null;
    setMic(false);
    sample.current = { level: 0, vad: false, rawRms: 0, captured: 0 };
    collection.current = null;
    setPhase("");
    setLevel(0);
    send({ type: "mic", mic: false });
  };
  useEffect(
    () => () => {
      if (interval.current) clearInterval(interval.current);
      media.current?.getTracks().forEach((t) => t.stop());
      audio.current?.close();
    },
    [],
  );
  useEffect(() => {
    if (status !== "接続済み" || !mic) return;
    const id = setInterval(
      () =>
        send({
          type: "sample",
          ...sample.current,
          mic: true,
          seq: ++sequence.current,
          monotonic: performance.now(),
          captureAgeMs: performance.now() - sample.current.captured,
          settings,
          audioState: audio.current?.state,
          trackMuted: media.current?.getAudioTracks()[0]?.muted,
          calibrating: !!collection.current,
        }),
      100,
    );
    return () => clearInterval(id);
    if (calibrationRef.current)
      send({ type: "calibration", calibration: calibrationRef.current });
  }, [status, mic, settings]);
  useEffect(() => {
    if (status === "接続済み" && joined) send({ type: "register", name, mic });
  }, [status]);
  const allow = async () => {
    setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("HTTPS とマイク対応ブラウザが必要です");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: { ideal: processing.echoCancellation },
          noiseSuppression: { ideal: processing.noiseSuppression },
          autoGainControl: { ideal: processing.autoGainControl },
        },
      });
      media.current = stream;
      setSettings(stream.getAudioTracks()[0].getSettings());
      voice.current = newVoice();
      calibrationRef.current = undefined;
      setCalibration(undefined);
      draft.current = { noiseRms: 0, speechRms: 0 };
      send({ type: "calibration-reset" });
      const ctx = new AudioContext();
      audio.current = ctx;
      await ctx.resume();
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      interval.current = setInterval(() => {
        if (ctx.state !== "running" || stream.getAudioTracks()[0].muted) return;
        an.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
        const f = updateVad(voice.current, rms, 100, calibrationRef.current);
        sample.current = {
          level: rms * 100,
          vad: f.vad,
          rawRms: rms,
          captured: performance.now(),
        };
        setLevel(rms * 100);
        const c = collection.current;
        if (c) {
          c.values.push(rms);
          if (performance.now() - c.start >= 3000) {
            collection.current = null;
            setPhase("");
            if (c.values.length < 15) {
              setError(
                "十分な測定データがありません。画面を開いたまま再測定してください。",
              );
              return;
            }
            if (c.kind === "noise") {
              draft.current.noiseRms = Math.max(
                1e-6,
                percentile(c.values, 0.5),
              );
              setCalibrationNote(
                "静音測定完了。次に本人だけが普段の声で発話してください。",
              );
            } else {
              draft.current.speechRms = percentile(c.values, 0.75);
              const result = { ...draft.current };
              if (validCalibration(result)) {
                calibrationRef.current = result;
                setCalibration(result);
                voice.current = newVoice();
                send({ type: "calibration", calibration: result });
                setCalibrationNote("キャリブレーション完了");
              } else
                setError(
                  "発話とノイズの差が小さすぎます。スマホを本人に近づけ、静音測定からやり直してください。",
                );
            }
          }
        }
      }, 100);
      stream.getAudioTracks()[0].onended = stop;
      setMic(true);
    } catch (e) {
      stop();
      setError(`マイクを開始できません: ${String(e)}`);
    }
  };
  return (
    <main className="participant">
      <header>
        <span className="brand">Meeting Dynamics</span>
        <span role="status">{status}</span>
      </header>
      <section>
        <h1>参加登録</h1>
        <p>
          座席 {seat} ·
          音声は送信・保存されません。音量と発話状態だけを中継します。
        </p>
        {!endpoint && <p role="alert">参加リンクの中継URLが無効です。</p>}
        {error && <p role="alert">{error}</p>}
        <div className="card join">
          <label>
            表示名
            <input
              placeholder="例：Aさん"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button disabled={status !== "接続済み"} onClick={mic ? stop : allow}>
            {mic ? "マイクを停止" : "マイクを許可"}
          </button>
          <p>{mic ? "マイク OK" : "マイク待ち"}</p>
          <fieldset disabled={mic}>
            <legend>マイク処理（変更後は停止・再取得・再測定）</legend>
            {Object.entries(processing).map(([key, value]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={value}
                  onChange={(e) =>
                    setProcessing((o) => ({ ...o, [key]: e.target.checked }))
                  }
                />
                {key}
              </label>
            ))}
          </fieldset>
          <p>
            実際の設定:{" "}
            {["echoCancellation", "noiseSuppression", "autoGainControl"]
              .map(
                (k) =>
                  `${k}: ${settings[k] === undefined ? "不明／非対応" : String(settings[k])}`,
              )
              .join(" · ")}
          </p>
          <div className="calibration">
            <p>
              計測前に、端末の位置を固定して1台ずつ測定してください。発話測定中は本人だけが話してください。
            </p>
            <button
              disabled={!mic || !!phase || !!state?.running}
              onClick={() => {
                calibrationRef.current = undefined;
                setCalibration(undefined);
                send({ type: "calibration-reset" });
                collection.current = {
                  kind: "noise",
                  start: performance.now(),
                  values: [],
                };
                setPhase("静かな状態を3秒測定中");
              }}
            >
              静音を測定（3秒）
            </button>
            <button
              disabled={
                !mic || !!phase || !!state?.running || !draft.current.noiseRms
              }
              onClick={() => {
                collection.current = {
                  kind: "speech",
                  start: performance.now(),
                  values: [],
                };
                setPhase("本人の発話を3秒測定中");
              }}
            >
              本人の発話を測定（3秒）
            </button>
            <p>{calibrationNote}</p>
            <p role="status">
              {phase ||
                (calibration
                  ? "補正設定済み"
                  : "未キャリブレーション：話者推定を保留")}
            </p>
            <p>
              生RMS {sample.current.rawRms.toFixed(5)} ·{" "}
              {dbfs(sample.current.rawRms).toFixed(1)} dBFS · 補正後{" "}
              {calibration
                ? updateVad(
                    { ...voice.current },
                    sample.current.rawRms,
                    0,
                    calibration,
                  ).correctedDb.toFixed(1) + " dB（本人基準）"
                : "未設定"}
            </p>
          </div>
          <div className="meter">
            <i style={{ width: `${level}%` }} />
          </div>
          <p>
            VAD 状態：<b>{sample.current.vad ? "発話中" : "無音"}</b>
          </p>
          <button
            className="primary"
            disabled={!mic || !name.trim() || status !== "接続済み"}
            onClick={() => {
              send({ type: "register", name, mic });
              setJoined(true);
            }}
          >
            参加登録を完了
          </button>
          {joined && (
            <p className="success">
              登録が完了しました。
              {state?.running
                ? "計測中です。"
                : "ホストの開始をお待ちください。"}
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
