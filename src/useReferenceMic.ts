import { useEffect, useRef, useState } from "react";
import { newVoice, updateVad } from "./audio";
export function useReferenceMic(
  send: (m: object) => void,
  enabled: boolean,
  sessionId: string,
  status: string,
) {
  const callback = useRef(send);
  callback.current = send;
  const stream = useRef<MediaStream | null>(null),
    context = useRef<AudioContext | null>(null),
    timer = useRef<ReturnType<typeof setInterval> | null>(null),
    seq = useRef(0);
  const [active, setActive] = useState(false),
    [error, setError] = useState(""),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [device, setDevice] = useState(""),
    [settings, setSettings] = useState<Record<string, any>>({}),
    [diagnostic, setDiagnostic] = useState<any>(null),
    [busy, setBusy] = useState(false);
  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    stream.current = null;
    context.current?.close();
    context.current = null;
    setActive(false);
    callback.current({ type: "pc-mic", mic: false });
  };
  useEffect(() => {
    if (!enabled) stop();
    return () => stop();
  }, [enabled, sessionId]);
  useEffect(() => {
    if (status === "接続済み" && active)
      callback.current({ type: "pc-mic", mic: true });
  }, [status]);
  useEffect(() => {
    if (!enabled || !navigator.mediaDevices) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === "audioinput",
        );
        if (!disposed) setDevices(inputs);
        if (
          device &&
          stream.current &&
          !inputs.some((d) => d.deviceId === device)
        ) {
          setError(
            "選択したPCマイクがなくなりました。デバイスを選び直してください。",
          );
          stop();
        }
      } catch {}
    };
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => {
      disposed = true;
      navigator.mediaDevices.removeEventListener("devicechange", refresh);
    };
  }, [enabled, device]);
  const start = async () => {
    if (!enabled) return;
    setBusy(true);
    setError("");
    stop();
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("HTTPSまたはlocalhostとマイク対応ブラウザが必要です");
      const s = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(device ? { deviceId: { exact: device } } : {}),
          autoGainControl: { ideal: false },
          echoCancellation: { ideal: false },
          noiseSuppression: { ideal: false },
        },
      });
      stream.current = s;
      const track = s.getAudioTracks()[0];
      const actual = track.getSettings();
      const recorded = Object.fromEntries(
        [
          "autoGainControl",
          "echoCancellation",
          "noiseSuppression",
          "sampleRate",
          "channelCount",
        ]
          .filter((k) => actual[k] !== undefined)
          .map((k) => [k, actual[k]]),
      );
      setSettings(recorded);
      setDevices(
        (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === "audioinput",
        ),
      );
      const ctx = new AudioContext();
      context.current = ctx;
      await ctx.resume();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(s).connect(analyser);
      const values = new Float32Array(analyser.fftSize),
        voice = newVoice();
      let previous = performance.now(),
        lastDb = -120;
      track.onended = () => {
        setError(
          "PCマイクが切断されました。再取得・再キャリブレーションしてください。",
        );
        stop();
      };
      timer.current = setInterval(() => {
        const now = performance.now();
        if (ctx.state !== "running" || track.muted) {
          callback.current({ type: "pc-mic", mic: false });
          setError(
            "PC音声処理が停止／消音されています。マイクを再取得してください。",
          );
          return;
        }
        analyser.getFloatTimeDomainData(values);
        const rms = Math.sqrt(
          values.reduce((s, v) => s + v * v, 0) / values.length,
        );
        const f = updateVad(voice, rms, now - previous);
        previous = now;
        setDiagnostic({ ...f, deltaDb: f.dbfs - lastDb });
        lastDb = f.dbfs;
        callback.current({
          type: "pc-sample",
          peak: Math.max(...values.map((v) => Math.abs(v))),
          clippedFraction:
            values.filter((v) => Math.abs(v) >= 0.999).length / values.length,
          rawRms: rms,
          mic: true,
          seq: ++seq.current,
          monotonic: now,
          captureAgeMs: 0,
          audioState: ctx.state,
          trackMuted: track.muted,
          settings: recorded,
        });
      }, 100);
      setActive(true);
      callback.current({ type: "pc-mic", mic: true });
    } catch (e) {
      stop();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return {
    active,
    error,
    devices,
    device,
    setDevice,
    settings,
    diagnostic,
    busy,
    start,
    stop,
  };
}
