import { evaluate, intervals } from "./study";
import { useState } from "react";
import type { Person, Session, Snapshot } from "./realtime";
import type { Mode } from "./study";
import { useReferenceMic } from "./useReferenceMic";
const saveFile = (name: string, body: string, type: string) => {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export function ResearchPanel({
  mode,
  setMode,
  state,
  session,
  people,
  mic,
  send,
}: {
  mode: Mode;
  setMode: (v: Mode) => void;
  state: Snapshot | null;
  session: Session | null;
  people: Person[];
  mic: ReturnType<typeof useReferenceMic>;
  send: (m: object) => void;
}) {
  const [error, setError] = useState(""),
    [selected, setSelected] = useState<number[]>([]),
    [test, setTest] = useState(false),
    [source, setSource] = useState<"live" | "synthetic">("live"),
    [evaluated, setEvaluated] = useState<any>(null),
    [busy, setBusy] = useState(false);
  const study = state?.research;
  const exportData = async (kind: "json" | "csv" | "evaluate") => {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`${session.endpoint}/room/${session.id}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostKey: session.hostKey }),
      });
      if (!r.ok) throw new Error(`詳細出力 ${r.status}`);
      const data = await r.json();
      data.study.windows = data.study.windows.map((w: any) => {
        const at = data.study.sessionStartAt + w.start + w.duration / 2;
        const label = data.study.labels.findLast(
          (l: any) => l.start <= at && (l.end === undefined || l.end > at),
        );
        return { ...w, ...(label ? { truth: label.speakers } : {}) };
      });
      data.study.intervals = {
        A: intervals(data.study.windows, "A", data.study.config),
        B: intervals(data.study.windows, "B", data.study.config),
      };
      data.study.evaluation = {
        A: evaluate(data.study.windows, "A", people.length, data.study.config),
        B: evaluate(data.study.windows, "B", people.length, data.study.config),
      };
      if (kind === "evaluate") {
        setEvaluated(data.study.evaluation);
        return;
      }
      if (kind === "json")
        saveFile(
          "meeting-dynamics-research.json",
          JSON.stringify(data, null, 2),
          "application/json",
        );
      else {
        const quote = (value: any) =>
          `"${JSON.stringify(value ?? "").replaceAll('"', '""')}"`;
        const metadata = {
          ...data,
          study: { ...data.study, windows: undefined },
        };
        const lines = [
          "recordType,startMs,durationMs,features,A,B,truth,metadata",
          `metadata,,,,,,,${quote(metadata)}`,
          ...data.study.windows.map(
            (w: any) =>
              `window,${w.start},${w.duration},${quote(w.features)},${quote(w.A)},${quote(w.B)},${quote(w.truth)},`,
          ),
        ];
        saveFile(
          "meeting-dynamics-features.csv",
          lines.join("\r\n"),
          "text/csv;charset=utf-8",
        );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="research-panel">
      <p>
        <b>
          {mode === "reference"
            ? "SMARTPHONE + PC REFERENCE"
            : "SMARTPHONE ONLY"}
        </b>{" "}
        · PCマイク{" "}
        {mode === "reference"
          ? mic.active
            ? state?.pc?.lastSample &&
              (state.serverTime || 0) - state.pc.lastSample < 600
              ? "取得・受信正常"
              : "取得中／受信停止"
            : "未取得／停止"
          : "不使用"}{" "}
        · 共同校正 {study?.ready ? "完了" : "未完了"}
      </p>
      {mode === "reference" && (
        <div className="card pc-controls">
          <h3>PC参照マイク</h3>
          <p>
            音声は送信・録音しません。特徴量・表示名・座席・評価ラベルをセッションに保持し、研究用出力に含めます。
          </p>
          <label>
            PC入力デバイス
            <select
              aria-label="PC入力デバイス"
              value={mic.device}
              disabled={mic.active}
              onChange={(e) => mic.setDevice(e.target.value)}
            >
              <option value="">既定のマイク</option>
              {mic.devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || "マイク"}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={mic.busy || mic.active || !session}
            onClick={mic.start}
          >
            PCマイクを開始／再取得
          </button>
          <button disabled={!mic.active} onClick={mic.stop}>
            PCマイクを停止
          </button>
          {mic.error && <p role="alert">{mic.error}</p>}
          <button
            onClick={() => {
              send({ type: "stop" });
              setMode("smartphone");
            }}
          >
            明示的にSMARTPHONE ONLYへ切替
          </button>
          <p>
            実設定: {JSON.stringify(mic.settings)} · PC音量変化{" "}
            {mic.diagnostic?.deltaDb?.toFixed(1) ?? "—"} dB / 100ms
          </p>
          <details>
            <summary>共同キャリブレーション</summary>
            <p>
              全端末の画面を開き、位置を固定します。STEP
              1は全員無言。以降は指定された本人だけ通常の声で5秒発話してください。PCと全スマホを同時測定します。
            </p>
            <button
              disabled={!mic.active || !!state?.running || !!study?.calibration}
              onClick={() => send({ type: "calibration-step", speaker: 0 })}
            >
              STEP 1 全員無言（3秒）
            </button>
            {people.map((p) => (
              <button
                key={p.id}
                disabled={
                  !mic.active ||
                  !!state?.running ||
                  !!study?.calibration ||
                  !study?.noise.pc
                }
                onClick={() =>
                  send({ type: "calibration-step", speaker: p.id })
                }
              >
                STEP {p.id + 1} {p.name}のみ発話（5秒）
                {study?.profiles[p.id] ? " ✓" : ""}
              </button>
            ))}
            <p role="status">
              {study?.calibration
                ? `${study.calibration.speaker === 0 ? "全員無言" : people[study.calibration.speaker - 1]?.name + "のみ発話"} 測定中`
                : study?.calibrationError ||
                  (study?.ready
                    ? "全マイクの応答ベクトル測定完了"
                    : "各STEPを完了してください")}
            </p>
            {study?.calibrationError && (
              <p role="alert">{study.calibrationError}</p>
            )}
            <p>
              無音、受信率70%未満、飽和、発話SNR 6
              dB未満は再測定。PC再取得や位置変更後も再測定してください。位置は相対座標で、実距離・音源定位ではありません。
            </p>
          </details>
        </div>
      )}
      <details>
        <summary>研究用詳細・A/B比較・評価テスト</summary>
        <label>
          短いギャップ統合ms
          <input
            type="number"
            min="100"
            max="2000"
            step="50"
            value={study?.config.gapMs ?? 350}
            disabled={!!state?.running}
            onChange={(e) =>
              send({
                type: "configure-study",
                mode,
                config: { gapMs: Number(e.target.value) },
              })
            }
          />
        </label>
        <label>
          最小発話区間長ms（発話回数）
          <input
            type="number"
            min="100"
            max="2000"
            step="50"
            value={study?.config.minTurnMs ?? 300}
            disabled={!!state?.running}
            onChange={(e) =>
              send({
                type: "configure-study",
                mode,
                config: { minTurnMs: Number(e.target.value) },
              })
            }
          />
        </label>
        <p>
          時間は100ms共通窓、350msの待機で整列。最小区間長は発話回数に適用し、短い帰属時間を隠しません。同時発話候補は個人へ重複計上せず専用時間へ集計。割合の分母は「個人帰属＋話者不明＋同時発話」の実時間です。
        </p>
        <div className="diagnostic-scroll">
          <table>
            <thead>
              <tr>
                <th>方式</th>
                <th>VAD時間</th>
                <th>話者別秒／回数</th>
                <th>不明</th>
                <th>無音</th>
                <th>不足</th>
                <th>同時発話候補</th>
                <th>平均信頼度</th>
              </tr>
            </thead>
            <tbody>
              {(["A", "B"] as const).map((method) => {
                const value = study?.[method];
                return (
                  <tr key={method}>
                    <td>
                      {method === "A"
                        ? "スマホ単独"
                        : "PC参照（PC取得窓のみ有効）"}
                    </td>
                    <td>{((value?.speechMs || 0) / 1000).toFixed(1)}</td>
                    <td>
                      {value?.people
                        .map(
                          (p: any) =>
                            `${people[p.id - 1]?.name}: ${(p.talkMs / 1000).toFixed(1)}秒 / ${p.turns}回`,
                        )
                        .join(" · ")}
                    </td>
                    <td>{((value?.unknownMs || 0) / 1000).toFixed(1)}</td>
                    <td>{((value?.silenceMs || 0) / 1000).toFixed(1)}</td>
                    <td>{((value?.missingMs || 0) / 1000).toFixed(1)}</td>
                    <td>{((value?.overlapMs || 0) / 1000).toFixed(1)}</td>
                    <td>
                      {value?.speechMs
                        ? (value.confidenceMs / value.speechMs).toFixed(2)
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p>
          時刻同期：時計差はRTT中点から推定し、最小RTTを採用します。遅延の非対称性を不確かさとして扱い、到着順で音源距離を推定しません。
        </p>
        <pre>{JSON.stringify(study?.clock || {}, null, 2)}</pre>
        <p>
          {!!study?.legacyMs&&<>旧集計{(study.legacyMs/1000).toFixed(1)}秒を保持。比較・評価は今回の取得窓のみ。<br/></>}
          記録 {study?.recordedWindows || 0} / {study?.recordingLimit || 36000}
          窓（最大60分または特徴量32MiB。上限で停止し、データを黙って破棄しません）。実機精度の向上は未検証です。
        </p>
        <label>
          <input
            type="checkbox"
            checked={test}
            onChange={(e) => setTest(e.target.checked)}
          />
          評価用テストモード（人手の正解ラベル）
        </label>
        {test && (
          <div>
            <label>
              データ由来
              <select
                aria-label="評価データ由来"
                value={source}
                onChange={(e) =>
                  setSource(e.target.value as "live" | "synthetic")
                }
              >
                <option value="live">実機・人手ラベル</option>
                <option value="synthetic">模擬データ</option>
              </select>
            </label>
            <p>
              例：A 10秒→無音5秒→B 10秒→無音5秒→A+B
              5秒。各区間の開始時に正解を記録。ラベルのない窓は評価対象外です。
            </p>
            {people.map((p) => (
              <label key={p.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(p.id)}
                  onChange={(e) =>
                    setSelected((v) =>
                      e.target.checked
                        ? [...v, p.id]
                        : v.filter((id) => id !== p.id),
                    )
                  }
                />
                {p.name}
              </label>
            ))}
            <button
              disabled={!state?.running}
              onClick={() =>
                send({
                  type: "label",
                  speakers: selected,
                  source,
                  monotonic: performance.now(),
                })
              }
            >
              現在の正解ラベルを記録（未選択＝無音）
            </button>
          </div>
        )}
        <button
          disabled={busy || !!state?.running}
          onClick={() => exportData("evaluate")}
        >
          評価指標を計算
        </button>
        {evaluated && (
          <pre>
            {JSON.stringify(
              { dataSource: study?.dataSource, metrics: evaluated },
              null,
              2,
            )}
          </pre>
        )}
        <button
          disabled={busy || !!state?.running}
          onClick={() => exportData("json")}
        >
          研究データJSON（時系列・校正・評価）
        </button>
        <button
          disabled={busy || !!state?.running}
          onClick={() => exportData("csv")}
        >
          特徴量CSV
        </button>
        {error && <p role="alert">{error}</p>}
        <p>
          特定の声紋を認識する方式ではありません。信頼度は正答確率ではありません。PCが切断されるとBはデータ不足になり、Aへの自動切替は行いません。
        </p>
      </details>
    </div>
  );
}
