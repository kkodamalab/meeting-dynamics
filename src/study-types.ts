import type { Mode, Config } from "./study";
export type StudySummary = {
  mode: Mode;
  legacyMs?: number;
  config: Config;
  layout: any;
  noise: Record<string, number>;
  profiles: Record<string, any>;
  calibration: { speaker: number; start: number; end: number } | null;
  calibrationError: string;
  ready: boolean;
  A: any;
  B: any;
  dataSource: string;
  labels: any[];
  clock: Record<string, any>;
  recordedWindows: number;
  recordingLimit: number;
};
