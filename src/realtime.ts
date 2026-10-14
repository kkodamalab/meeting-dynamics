import type { Calibration } from "./audio";
import { useEffect, useRef, useState } from "react";
export type Person = {
  id: number;
  name: string;
  connected: boolean;
  registered: boolean;
  mic: boolean;
  level: number;
  vad: boolean;
  talkMs: number;
  turns: number;
  audioState?: string;
  trackMuted?: boolean;
  protocol?: number;
  rawRms?: number;
  dbfs?: number;
  snr?: number;
  correctedDb?: number;
  noiseDb?: number;
  lastSample?: number;
  sampleDelayMs?: number;
  seq?: number;
  calibration?: Calibration;
  calibrating?: boolean;
  confidenceMs?: number;
  startThresholdDb?: number;
  endThresholdDb?: number;
  settings?: Record<string, boolean | number>;
};
export type Snapshot = {
  id: string;
  running: boolean;
  elapsed: number;
  active: number | null;
  people: Person[];
  serverTime?: number;
  receivedAt?: number;
  unknownMs?: number;
  silenceMs?: number;
  confidence?: number;
  reason?: string;
};
export type Session = {
  id: string;
  hostKey: string;
  seatKeys: string[];
  endpoint: string;
};
export const configuredEndpoint =
  import.meta.env.VITE_RELAY_URL || localStorage.getItem("meeting-relay") || "";
export function normalizeEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new Error("中継URLには HTTPS が必要です");
  return url.origin;
}
export async function createSession(
  endpoint: string,
  count: number,
): Promise<Session> {
  const url = normalizeEndpoint(endpoint);
  const r = await fetch(`${url}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count }),
  });
  if (!r.ok) throw new Error(`中継接続エラー (${r.status})`);
  return { ...(await r.json()), endpoint: url };
}
export function useRoom(
  endpoint: string,
  id: string,
  role: "host" | "seat",
  key: string,
  seat?: number,
) {
  const [state, setState] = useState<Snapshot | null>(null),
    [status, setStatus] = useState("未接続");
  const socket = useRef<WebSocket | null>(null);
  useEffect(() => {
    setState(null);
    if (!endpoint || !id || !key) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    function connect() {
      setStatus("接続中");
      const ws = new WebSocket(`${endpoint.replace(/^http/, "ws")}/room/${id}`);
      socket.current = ws;
      ws.onopen = () =>
        ws.send(JSON.stringify({ type: "auth", role, key, seat }));
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.type === "state") {
            attempts = 0;
            setState({ ...m, receivedAt: Date.now() });
            setStatus("接続済み");
          }
        } catch {
          setStatus("通信エラー");
        }
      };
      ws.onerror = () => setStatus("通信エラー");
      ws.onclose = (e) => {
        if (disposed) return;
        if (e.code === 1008) {
          setStatus(
            e.reason === "Seat already connected"
              ? "この座席は別の端末で接続中です"
              : "登録リンクが無効です",
          );
          return;
        }
        setStatus("再接続中");
        timer = setTimeout(connect, Math.min(10000, 1000 * 2 ** attempts++));
      };
    }
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket.current?.close();
      socket.current = null;
    };
  }, [endpoint, id, role, key, seat]);
  const send = (message: object) => {
    if (socket.current?.readyState === WebSocket.OPEN && status === "接続済み")
      socket.current.send(JSON.stringify(message));
  };
  return { state, status, send };
}
export function joinLink(session: Session, seat: number) {
  const u = new URL(location.pathname, location.origin);
  u.hash = `join?${new URLSearchParams({ session: session.id, seat: String(seat), key: session.seatKeys[seat - 1], relay: session.endpoint })}`;
  return u.href;
}
