/** Serialized analysis uses seconds on the ORIGINAL file, never resampled indices. */
export interface TrackAnalysis {
  schemaVersion: 1;
  trackId: string;
  durationSeconds: number;
  source: { bytes: number; sampleRate: number; channels: number };
  provenance: { algorithm: string; configVersion: string; config: Record<string, unknown>; rhythmChannel: number };
  bpm: number | null;
  beatTimes: number[];
  gridOffsetSeconds: number | null;
  confidence: { score: number; kind: 'heuristic'; regularity: number; onsetSupport: number };
  tempoAlternatives: number[];
  onsetTimes: number[];
  energyCurve: { time: number; rms: number; dbfs: number }[];
  downbeatTimes: null;
  phrases: null;
  key: null;
  vocalRegions: null;
  warnings: string[];
}

export interface BeatGrid {
  bpm: number;
  offsetSeconds: number;
  reviewed: boolean;
}

export function validateGrid(grid: BeatGrid, duration: number): boolean {
  // Wider than the initial DJ tempo prior so users can fix half/double-time errors.
  // Bounds prevent accidental zero/negative periods and unbounded metronome scheduling.
  return Number.isFinite(grid.bpm) && grid.bpm >= 40 && grid.bpm <= 300
    && Number.isFinite(grid.offsetSeconds) && grid.offsetSeconds >= 0
    && grid.offsetSeconds < duration && typeof grid.reviewed === 'boolean';
}
// Summary: This rejects grid settings that cannot describe a usable rhythmic clock.
// It checks a deliberately broad tempo range and an anchor inside the original recording.
// Passing validation establishes numerical safety, not whether the beat interpretation sounds right.

export function gridTimes(grid: BeatGrid, from: number, to: number): number[] {
  const end = Math.min(to, from + 600);
  if (!validateGrid(grid, Math.max(end, grid.offsetSeconds + 1)) || !Number.isFinite(from) || !Number.isFinite(end)) return [];
  const period = 60 / grid.bpm;
  const first = Math.max(0, Math.ceil((from - grid.offsetSeconds - 1e-8) / period));
  const times: number[] = [];
  for (let beat = first; grid.offsetSeconds + beat * period < end; beat++) {
    times.push(grid.offsetSeconds + beat * period);
  }
  return times;
}
// Summary: This expands a constant-tempo grid into audible or visible beat markers.
// An anchor plus integer multiples of the beat period preserves phase when previewing later in a track.
// It cannot follow tempo drift, and the ten-minute bound prevents accidentally huge scheduling loops.

export function isTrackAnalysis(value: unknown): value is TrackAnalysis {
  if (!value || typeof value !== 'object') return false;
  const a = value as TrackAnalysis;
  const duration = a.durationSeconds;
  const events = (v: unknown): v is number[] => Array.isArray(v) && v.length <= 100000
    && v.every((t, i) => Number.isFinite(t) && t >= 0 && t < duration && (i === 0 || t > v[i - 1]));
  // Validate the API boundary instead of letting malformed cache/server data
  // become oscillator timestamps, SVG coordinates, or neural timing inputs.
  return a.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(a.trackId)
    && Number.isFinite(duration) && duration > 0 && duration <= 600
    && !!a.source && Number.isFinite(a.source.sampleRate) && a.source.sampleRate > 0
    && Number.isInteger(a.source.channels) && a.source.channels > 0
    && Number.isFinite(a.source.bytes) && a.source.bytes > 0
    && !!a.provenance && typeof a.provenance.algorithm === 'string' && typeof a.provenance.configVersion === 'string'
    && (a.bpm === null || (Number.isFinite(a.bpm) && a.bpm > 0 && a.bpm <= 1000))
    && (a.gridOffsetSeconds === null || (Number.isFinite(a.gridOffsetSeconds) && a.gridOffsetSeconds >= 0 && a.gridOffsetSeconds < duration))
    && events(a.beatTimes) && events(a.onsetTimes)
    && !!a.confidence && a.confidence.kind === 'heuristic'
    && [a.confidence.score, a.confidence.regularity, a.confidence.onsetSupport].every(n => Number.isFinite(n) && n >= 0 && n <= 1)
    && Array.isArray(a.tempoAlternatives) && a.tempoAlternatives.every(n => Number.isFinite(n) && n > 0)
    && Array.isArray(a.energyCurve) && a.energyCurve.length <= 10000
    && a.energyCurve.every((p, i) => p && Number.isFinite(p.time) && p.time >= 0 && p.time < duration
      && (i === 0 || p.time > a.energyCurve[i - 1].time) && Number.isFinite(p.rms) && p.rms >= 0 && Number.isFinite(p.dbfs))
    && a.downbeatTimes === null && a.phrases === null && a.key === null && a.vocalRegions === null
    && Array.isArray(a.warnings) && a.warnings.every(w => typeof w === 'string');
}
// Summary: This verifies the versioned metadata contract before the mixer consumes it.
// It checks event ordering, finite ranges, and explicitly unknown musical labels.
// It cannot detect a musically wrong but structurally valid analysis; audition remains necessary.

export function correctionKey(analysis: TrackAnalysis): string {
  return `neuro-dj-grid:${analysis.trackId}:${analysis.provenance.algorithm}:${analysis.provenance.configVersion}`;
}
// Summary: This gives a user's correction a stable identity across reloads and file renames.
// Including analysis provenance prevents silently applying an old correction to a changed algorithm.
// Browser storage is local to an origin, so another browser or port will not share these corrections.

export function initialGrid(analysis: TrackAnalysis): BeatGrid {
  try {
    const saved = JSON.parse(localStorage.getItem(correctionKey(analysis)) || 'null');
    if (saved && validateGrid(saved, analysis.durationSeconds) && saved.reviewed) return saved;
  } catch { /* Storage may be unavailable; the detector result still works. */ }
  return { bpm: analysis.bpm ?? 120, offsetSeconds: analysis.gridOffsetSeconds ?? 0, reviewed: false };
}
// Summary: This restores a reviewed correction or supplies an editable starting grid.
// The 120 BPM fallback is an explicitly unreviewed manual starting value, never a detected tempo.
// Blocked/corrupt browser storage falls back safely and must not imply that the user reviewed the grid.

// Module summary: This contract separates detected beat events from an editable constant grid.
// It also makes unsupported downbeat, phrase, key, and vocal analysis explicitly unknown.
// A future variable-tempo map will need a new representation rather than pretending a single BPM suffices.
