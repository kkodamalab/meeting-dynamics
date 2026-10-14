import { useEffect, useState } from "react";
import type { Person, Snapshot } from "./realtime";
export function AudioDiagnostics({
  people,
  state,
}: {
  people: Person[];
  state: Snapshot | null;
}) {
  const [open, setOpen] = useState(false),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (open) {
      const timer = setInterval(() => setNow(Date.now()), 300);
      return () => clearInterval(timer);
    }
  }, [open]);
  const number = (n: number | undefined, digits = 1) =>
    Number.isFinite(n) ? n!.toFixed(digits) : "—";
  return (
    <details
      className="audio-diagnostics"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>音声診断</summary>
      <p>
        生RMSはブラウザ処理後の波形から算出。dBFSは0が最大。補正後は本人の基準発話を0
        dBとします。通信遅延は初回受信からの遅延増分（片道遅延の絶対値ではありません）。
      </p>
      <div className="diagnostic-scroll">
        <table>
          <thead>
            <tr>
              {[
                "端末",
                "通信／受信経過",
                "生RMS",
                "dBFS",
                "VAD",
                "ノイズ／SNR",
                "開始／終了閾値",
                "補正後dB",
                "測定",
                "受信時刻／連番",
                "遅延増分ms",
                "実際のマイク設定",
              ].map((t) => (
                <th key={t}>{t}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const age = p.lastSample
                ? (state?.serverTime || 0) -
                  p.lastSample +
                  Math.max(0, now - (state?.receivedAt || now))
                : Infinity;
              return (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>
                    {!p.connected
                      ? "切断"
                      : !p.mic
                        ? "マイク停止"
                        : p.trackMuted
                          ? "トラック消音"
                          : p.audioState && p.audioState !== "running"
                            ? "音声処理停止"
                            : !p.lastSample
                              ? "サンプル未受信"
                              : age > 600
                                ? "受信停止／遅延"
                                : "受信中"}{" "}
                    {Number.isFinite(age) ? `${Math.round(age)}ms` : ""}
                  </td>
                  <td>{number(p.rawRms, 5)}</td>
                  <td>{number(p.dbfs)}</td>
                  <td>{p.vad ? "発話" : "無音"}</td>
                  <td>
                    {number(p.noiseDb)} / {number(p.snr)} dB
                  </td>
                  <td>
                    {number(p.startThresholdDb)} / {number(p.endThresholdDb)}
                  </td>
                  <td>{p.calibration ? number(p.correctedDb) : "未設定"}</td>
                  <td>
                    {p.protocol === 1
                      ? "旧画面：再読込"
                      : p.calibrating
                        ? "測定中"
                        : p.calibration
                          ? "補正済み"
                          : "未完了"}
                  </td>
                  <td>
                    {p.lastSample
                      ? new Date(p.lastSample).toISOString()
                      : "未受信"}{" "}
                    / {p.seq ?? "—"}
                  </td>
                  <td>{number(p.sampleDelayMs, 0)}</td>
                  <td>
                    {p.audioState && <div>AudioContext: {p.audioState}</div>}
                    {[
                      "echoCancellation",
                      "noiseSuppression",
                      "autoGainControl",
                      "sampleRate",
                      "channelCount",
                    ].map((k) => (
                      <div key={k}>
                        {k}:{" "}
                        {p.settings?.[k] === undefined
                          ? "不明／非対応"
                          : String(p.settings[k])}
                      </div>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p>
        両方が同じ声を同程度に拾う場合、音量だけでは本人を識別できません。判定を保留し「話者不明」に集計します。未受信・遅延時は送信端末の画面とマイク状態を確認してください。
      </p>
    </details>
  );
}
