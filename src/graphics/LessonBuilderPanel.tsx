import { useEffect, useRef, useState } from 'react';
import {
  checkHealth,
  getLesson,
  importLocalFile,
  importUrl,
  lessonFileUrl,
  listLessons,
  saveAnnotations,
  type LessonEntry,
} from '../audio/LessonBuilderClient';
import type { Lesson, SuggestedTransitionRegion } from '../audio/LessonBuilder';

interface Props {
  onClose: () => void;
}

interface WavePoint {
  time: number;
  rms: number;
  peak: number;
}

type Technique = '' | 'crossfade' | 'bass_swap' | 'filter_sweep' | 'echo_out' | 'loop_roll';

const WINDOW_SECONDS = 20;
const techniques: Technique[] = ['', 'crossfade', 'bass_swap', 'filter_sweep', 'echo_out', 'loop_roll'];
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

function initialSegment(lesson: Lesson): { startSeconds: number; endSeconds: number } {
  const saved = lesson.humanAnnotations.reviewedTransitionSegment;
  const duration = lesson.audio.referenceDurationSeconds;
  if (record(saved) && finite(saved.startSeconds) && finite(saved.endSeconds)
    && saved.startSeconds >= 0 && saved.endSeconds > saved.startSeconds && saved.endSeconds <= duration) {
    return { startSeconds: saved.startSeconds, endSeconds: saved.endSeconds };
  }
  return {
    startSeconds: clamp(lesson.segment.startSeconds, 0, duration),
    endSeconds: clamp(lesson.segment.endSeconds, 0, duration),
  };
}

function initialGrid(lesson: Lesson): { bpm: number; offsetSeconds: number } {
  const saved = lesson.humanAnnotations.reviewedBeatGrid;
  const duration = lesson.audio.referenceDurationSeconds;
  if (record(saved) && finite(saved.bpm) && finite(saved.offsetSeconds)
    && saved.bpm >= 40 && saved.bpm <= 300 && saved.offsetSeconds >= 0 && saved.offsetSeconds < duration) {
    return { bpm: saved.bpm, offsetSeconds: saved.offsetSeconds };
  }
  return {
    bpm: lesson.heuristicEstimates.rhythm.bpm ?? 120,
    offsetSeconds: lesson.heuristicEstimates.rhythm.gridOffsetSeconds ?? 0,
  };
}

function gridTimes(bpm: number, offset: number, from: number, to: number): number[] {
  if (!finite(bpm) || bpm <= 0 || !finite(offset)) return [];
  const period = 60 / bpm;
  const first = Math.max(0, Math.ceil((from - offset - 1e-8) / period));
  const times: number[] = [];
  for (let index = first; offset + index * period < to && times.length < 2000; index++) {
    times.push(offset + index * period);
  }
  return times;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function LessonBuilderPanel({ onClose }: Props) {
  const [lessons, setLessons] = useState<LessonEntry[]>([]);
  const [folder, setFolder] = useState('');
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [localPermission, setLocalPermission] = useState(false);
  const [url, setUrl] = useState('');
  const [urlPermission, setUrlPermission] = useState(false);
  const [busy, setBusy] = useState<'loading' | 'local' | 'url' | 'save' | ''>('loading');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState<number | null>(null);
  const [segment, setSegment] = useState({ startSeconds: 0, endSeconds: 0 });
  const [grid, setGrid] = useState({ bpm: 120, offsetSeconds: 0 });
  const [technique, setTechnique] = useState<Technique>('');
  const [notes, setNotes] = useState('');
  const [from, setFrom] = useState(0);
  const [wave, setWave] = useState<WavePoint[]>([]);
  const [waveMessage, setWaveMessage] = useState('');
  const panelRef = useRef<HTMLElement | null>(null);
  const localInputRef = useRef<HTMLInputElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const selectEntry = (entry: LessonEntry) => {
    setFolder(entry.folder);
    setLesson(entry.lesson);
    setSegment(initialSegment(entry.lesson));
    setGrid(initialGrid(entry.lesson));
    const label = entry.lesson.humanAnnotations.techniqueLabel;
    setTechnique(typeof label === 'string' && techniques.includes(label as Technique) ? label as Technique : '');
    const savedNotes = entry.lesson.humanAnnotations.notes;
    setNotes(typeof savedNotes === 'string' ? savedNotes : '');
    setFrom(0);
    setRevision(null);
    setMessage('');
    setError('');
  };

  useEffect(() => {
    let active = true;
    Promise.all([checkHealth(), listLessons()]).then(([, entries]) => {
      if (!active) return;
      setLessons(entries);
      setBusy('');
    }).catch(reason => {
      if (!active) return;
      setError(errorMessage(reason, 'Could not load lessons.'));
      setBusy('');
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLButtonElement>('button')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), audio[controls], summary',
      ));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    panel?.addEventListener('keydown', keyboard);
    return () => { panel?.removeEventListener('keydown', keyboard); previous?.focus(); };
  }, [onClose]);

  useEffect(() => () => {
    const context = audioContextRef.current;
    if (context && context.state !== 'closed') void context.close();
  }, []);

  useEffect(() => {
    if (!lesson || !folder) { setWave([]); return; }
    let active = true;
    setWave([]);
    setWaveMessage('Decoding reference audio for the overview…');
    const loadWave = async () => {
      try {
        const response = await fetch(lessonFileUrl(folder, 'reference.wav'));
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: unknown } | null;
          throw new Error(typeof body?.error === 'string' ? body.error : 'Reference audio is unavailable.');
        }
        const bytes = await response.arrayBuffer();
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const context = audioContextRef.current ?? new AudioCtx();
        audioContextRef.current = context;
        const buffer = await context.decodeAudioData(bytes.slice(0));
        if (!active) return;
        const bucket = Math.max(1, Math.ceil(buffer.length / 1800));
        const points: WavePoint[] = [];
        for (let start = 0; start < buffer.length; start += bucket) {
          const end = Math.min(buffer.length, start + bucket);
          const sampleStep = Math.max(1, Math.ceil((end - start) / 256));
          let sumSquares = 0, peak = 0, count = 0;
          for (let frame = start; frame < end; frame += sampleStep) {
            for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
              const sample = buffer.getChannelData(channel)[frame];
              sumSquares += sample * sample;
              peak = Math.max(peak, Math.abs(sample));
              count++;
            }
          }
          points.push({ time: start / buffer.sampleRate, rms: Math.sqrt(sumSquares / Math.max(1, count)), peak });
        }
        setWave(points);
        setWaveMessage('');
      } catch (reason) {
        if (active) setWaveMessage(errorMessage(reason, 'Could not decode the reference audio overview.'));
      }
    };
    void loadWave();
    return () => { active = false; };
  }, [folder, lesson]);

  const openLesson = async (nextFolder: string) => {
    setBusy('loading');
    setError('');
    try { selectEntry(await getLesson(nextFolder)); }
    catch (reason) { setError(errorMessage(reason, 'Could not open this lesson.')); }
    finally { setBusy(''); }
  };

  const addEntry = (entry: LessonEntry) => {
    setLessons(current => [entry, ...current.filter(item => item.folder !== entry.folder)]);
    selectEntry(entry);
  };

  const submitLocal = async () => {
    if (!localFile || !localPermission) return;
    setBusy('local');
    setError('');
    setMessage('');
    try {
      const entry = await importLocalFile(localFile, localPermission);
      addEntry(entry);
      setLocalFile(null);
      setLocalPermission(false);
      if (localInputRef.current) localInputRef.current.value = '';
      setMessage('Local media imported. Review the lesson before saving annotations.');
    } catch (reason) { setError(errorMessage(reason, 'Local import failed.')); }
    finally { setBusy(''); }
  };

  const submitUrl = async () => {
    if (!url.trim() || !urlPermission) return;
    setBusy('url');
    setError('');
    setMessage('');
    try {
      const entry = await importUrl(url.trim(), urlPermission);
      addEntry(entry);
      setUrl('');
      setUrlPermission(false);
      setMessage('URL media imported. Review the lesson before saving annotations.');
    } catch (reason) { setError(errorMessage(reason, 'URL import failed.')); }
    finally { setBusy(''); }
  };

  const chooseSuggested = (region: SuggestedTransitionRegion) => {
    if (!lesson) return;
    const duration = lesson.audio.referenceDurationSeconds;
    setSegment({
      startSeconds: clamp(region.startSeconds, 0, duration),
      endSeconds: clamp(region.endSeconds, 0, duration),
    });
    setMessage('Suggested region copied into the review fields. Press Save annotations to persist it.');
  };

  const save = async () => {
    if (!lesson || !folder) return;
    const annotations: Record<string, unknown> = {
      ...lesson.humanAnnotations,
      reviewedTransitionSegment: { ...segment, reviewed: true },
      reviewedBeatGrid: { ...grid, reviewed: true },
      techniqueLabel: technique || null,
      notes,
    };
    setBusy('save');
    setError('');
    setMessage('');
    try {
      const result = await saveAnnotations(folder, annotations);
      const updated = { ...lesson, humanAnnotations: result.humanAnnotations };
      setLesson(updated);
      setLessons(current => current.map(item => item.folder === folder ? { ...item, lesson: updated } : item));
      setRevision(result.revision);
      setMessage(`Annotations saved as revision ${result.revision}.`);
    } catch (reason) { setError(errorMessage(reason, 'Could not save annotations.')); }
    finally { setBusy(''); }
  };

  const duration = lesson?.audio.referenceDurationSeconds ?? 0;
  const end = Math.min(from + WINDOW_SECONDS, duration);
  const span = Math.max(0.001, end - from);
  const visibleWave = wave.filter(point => point.time >= from && point.time <= end);
  const scale = Math.max(0.01, ...visibleWave.map(point => point.peak));
  const upper = visibleWave.map(point => `${(point.time - from) / span * 1000},${60 - point.peak / scale * 44}`);
  const lower = [...visibleWave].reverse().map(point => `${(point.time - from) / span * 1000},${60 + point.peak / scale * 44}`);
  const envelope = [...upper, ...lower].join(' ');
  const rmsPath = visibleWave.map(point => `${(point.time - from) / span * 1000},${60 - point.rms / scale * 44}`).join(' ');
  const rhythm = lesson?.heuristicEstimates.rhythm;
  const validGrid = !!lesson && finite(grid.bpm) && grid.bpm >= 40 && grid.bpm <= 300
    && finite(grid.offsetSeconds) && grid.offsetSeconds >= 0 && grid.offsetSeconds < duration;
  const validSegment = !!lesson && finite(segment.startSeconds) && finite(segment.endSeconds)
    && segment.startSeconds >= 0 && segment.endSeconds > segment.startSeconds && segment.endSeconds <= duration;
  const beats = validGrid ? gridTimes(grid.bpm, grid.offsetSeconds, from, end) : [];
  const visibleRegions = lesson?.heuristicEstimates.suggestedTransitionRegions
    .filter(region => region.endSeconds >= from && region.startSeconds <= end) ?? [];
  const untouchedKeys = lesson ? Object.keys(lesson.humanAnnotations)
    .filter(key => !['reviewedTransitionSegment', 'reviewedBeatGrid', 'techniqueLabel', 'notes'].includes(key)) : [];

  return <div className="analysis-backdrop">
    <section ref={panelRef} className="analysis-panel lesson-builder-panel glass-panel" role="dialog" aria-modal="true" aria-label="DJ Lesson Builder">
      <div className="analysis-heading"><div><h2>DJ Lesson Builder</h2><p>Import, inspect, and review local lesson artifacts.</p></div>
        <button className="guide-btn" onClick={onClose}>Close builder</button></div>

      <div className="lesson-builder-layout">
        <aside className="lesson-library" aria-label="Lesson imports and library">
          <h3>Lesson library</h3>
          {busy === 'loading' && <p>Loading lessons…</p>}
          {!busy && lessons.length === 0 && <p className="analysis-note">No exported lessons yet.</p>}
          <div className="lesson-list">
            {lessons.map(item => <button key={item.folder} className="guide-btn" aria-pressed={folder === item.folder}
              onClick={() => void openLesson(item.folder)}>
              <span>{item.lesson.title}</span><small>{item.folder}</small>
            </button>)}
          </div>

          <fieldset className="lesson-import-group">
            <legend>Local-file import</legend>
            <input ref={localInputRef} type="file" accept="video/mp4,video/quicktime,video/webm,audio/*"
              onChange={event => setLocalFile(event.target.files?.[0] ?? null)} />
            <label className="lesson-permission"><input type="checkbox" checked={localPermission}
              onChange={event => setLocalPermission(event.target.checked)} /> I own or have permission to use this material</label>
            <button className="guide-btn" disabled={!localFile || !localPermission || !!busy} onClick={() => void submitLocal()}>
              {busy === 'local' ? 'Importing and analyzing…' : 'Import local file'}
            </button>
          </fieldset>

          <fieldset className="lesson-import-group">
            <legend>URL import</legend>
            <input type="url" value={url} placeholder="https://…" onChange={event => setUrl(event.target.value)} />
            <label className="lesson-permission"><input type="checkbox" checked={urlPermission}
              onChange={event => setUrlPermission(event.target.checked)} /> I own or have permission to use this material</label>
            <button className="guide-btn" disabled={!url.trim() || !urlPermission || !!busy} onClick={() => void submitUrl()}>
              {busy === 'url' ? 'Importing and analyzing…' : 'Import public URL'}
            </button>
            <p className="analysis-note">Platform support is best-effort for YouTube, TikTok, and Instagram. Neuro-DJ never bypasses login, DRM, or private-account restrictions. If import fails, download the clip yourself and use local-file import.</p>
          </fieldset>
        </aside>

        <main className="lesson-editor">
          {!lesson && <p className="lesson-empty">Choose a lesson or import media to begin review.</p>}
          {lesson && <>
            <div className="lesson-title"><div><h3>{lesson.title}</h3><p className="analysis-note">{folder}</p></div>
              <span className="lesson-readiness">{lesson.readiness}</span></div>
            <audio controls preload="metadata" src={lessonFileUrl(folder, 'reference.wav')} />
            <p className="analysis-note">This plays the extracted reference audio only. The original source video is not retained or played back here.</p>

            <div className="lesson-wave-scroll">
              <svg viewBox="0 0 1000 120" className="analysis-plot lesson-waveform" role="img"
                aria-label="Reference waveform and RMS overview with onset candidates, editable beat grid, and suggested transition regions">
                <polygon points={envelope} fill="#ffb703" opacity="0.2" />
                <polyline points={rmsPath} fill="none" stroke="#ffb703" strokeWidth="2" />
                {rhythm?.onsetTimes.filter(time => time >= from && time < end).map(time => <line key={`o${time}`}
                  x1={(time - from) / span * 1000} x2={(time - from) / span * 1000} y1="92" y2="114" stroke="#ff4d89" />)}
                {beats.map(time => <line key={`b${time}`} x1={(time - from) / span * 1000} x2={(time - from) / span * 1000}
                  y1="6" y2="114" stroke="#00e5ff" opacity="0.65" />)}
                {visibleRegions.map((region, index) => {
                  const left = clamp((region.startSeconds - from) / span * 1000, 0, 1000);
                  const right = clamp((region.endSeconds - from) / span * 1000, 0, 1000);
                  return <g key={`s${region.startSeconds}-${index}`} className="lesson-suggestion" role="button" tabIndex={0}
                    onClick={() => chooseSuggested(region)}
                    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseSuggested(region); } }}>
                    <title>Suggested region {region.startSeconds.toFixed(2)}–{region.endSeconds.toFixed(2)} seconds. Click to copy into the review fields.</title>
                    <rect x={left} y="4" width={Math.max(3, right - left)} height="112" fill="#a78bfa" fillOpacity="0.14"
                      stroke="#a78bfa" strokeDasharray="8 5" />
                  </g>;
                })}
              </svg>
            </div>
            <p className="analysis-note">Gold: client-decoded peak/RMS overview · Pink: onset candidates · Cyan: editable beat grid · Violet dashed: Suggested regions (click to copy, then Save) · {from.toFixed(1)}–{end.toFixed(1)} seconds</p>
            {waveMessage && <p className="analysis-note">{waveMessage}</p>}
            <div className="analysis-fields">
              <label>Preview from (seconds)<input type="number" min="0" max={Math.max(0, duration - 0.1)} step="1" value={from}
                onChange={event => setFrom(clamp(Number(event.target.value), 0, Math.max(0, duration - 0.1)))} /></label>
              <label className="lesson-window-slider">Scroll preview window<input type="range" min="0" max={Math.max(0, duration - WINDOW_SECONDS)} step="0.25"
                value={Math.min(from, Math.max(0, duration - WINDOW_SECONDS))} onChange={event => setFrom(Number(event.target.value))} /></label>
            </div>

            <section className="lesson-review-section">
              <h3>Reviewed transition segment</h3>
              <div className="analysis-fields">
                <label>Segment start (seconds)<input type="number" min="0" max={duration} step="0.01" value={segment.startSeconds}
                  onChange={event => setSegment({ ...segment, startSeconds: clamp(Number(event.target.value), 0, duration) })} /></label>
                <label>Segment end (seconds)<input type="number" min="0" max={duration} step="0.01" value={segment.endSeconds}
                  onChange={event => setSegment({ ...segment, endSeconds: clamp(Number(event.target.value), 0, duration) })} /></label>
              </div>
              {!validSegment && <p role="alert">Enter an increasing segment within 0–{duration.toFixed(2)} seconds.</p>}
            </section>

            <section className="lesson-review-section">
              <h3>Reviewed beat grid</h3>
              <p>{rhythm?.bpm === null ? 'No reliable tempo detected; this is a manual starting point at 120 BPM.'
                : `Estimate: ${rhythm?.bpm.toFixed(2)} BPM · Rhythm support: ${Math.round((rhythm?.confidence.score ?? 0) * 100)}%`}</p>
              <div className="analysis-fields">
                <label>BPM<input type="number" min="40" max="300" step="0.01" value={grid.bpm}
                  onChange={event => setGrid({ ...grid, bpm: Number(event.target.value) })} /></label>
                <label>Beat-anchor offset (seconds)<input type="number" min="0" max={duration} step="0.005" value={grid.offsetSeconds}
                  onChange={event => setGrid({ ...grid, offsetSeconds: Number(event.target.value) })} /></label>
              </div>
              <div className="analysis-actions">
                <button className="guide-btn" disabled={grid.bpm / 2 < 40} onClick={() => setGrid({ ...grid, bpm: grid.bpm / 2 })}>Half tempo</button>
                <button className="guide-btn" disabled={grid.bpm * 2 > 300} onClick={() => setGrid({ ...grid, bpm: grid.bpm * 2 })}>Double tempo</button>
                <button className="guide-btn" onClick={() => setGrid({ ...grid, offsetSeconds: Math.max(0, Math.round((grid.offsetSeconds - 0.025) * 1000) / 1000) })}>−25 ms</button>
                <button className="guide-btn" onClick={() => setGrid({ ...grid, offsetSeconds: Math.round((grid.offsetSeconds + 0.025) * 1000) / 1000 })}>+25 ms</button>
                <button className="guide-btn" onClick={() => setGrid({ bpm: rhythm?.bpm ?? 120, offsetSeconds: rhythm?.gridOffsetSeconds ?? 0 })}>Restore estimate</button>
              </div>
              {!validGrid && <p role="alert">Enter 40–300 BPM and an offset inside this reference.</p>}
              <p className="analysis-note">A beat anchor is not necessarily the first beat of a bar. Downbeats and phrases are not supplied.</p>
            </section>

            <section className="lesson-review-section">
              <h3>Technique and notes</h3>
              <div className="analysis-fields">
                <label>Technique label<select value={technique} onChange={event => setTechnique(event.target.value as Technique)}>
                  <option value="">none</option><option value="crossfade">crossfade</option><option value="bass_swap">bass_swap</option>
                  <option value="filter_sweep">filter_sweep</option><option value="echo_out">echo_out</option><option value="loop_roll">loop_roll</option>
                </select></label>
              </div>
              <label className="lesson-notes">Notes<textarea value={notes} rows={4} onChange={event => setNotes(event.target.value)} /></label>
            </section>

            <section className="lesson-review-section">
              <h3>Possible key candidates</h3>
              <p className="analysis-note">Confidence is heuristic, not a probability of correctness. These are candidates, never a confirmed key.</p>
              <ol className="lesson-key-list">
                {lesson.heuristicEstimates.possibleKeys.slice(0, 5).map(candidate => <li key={candidate.key}>
                  <span>{candidate.key}</span><span>{Math.round(candidate.confidence * 100)}% confidence</span>
                </li>)}
              </ol>
            </section>

            <section className="lesson-review-section lesson-summary">
              <h3>Save preview and immutable analysis context</h3>
              <dl>
                <div><dt>Readiness</dt><dd>{lesson.readiness}</dd></div>
                <div><dt>Source type</dt><dd>{lesson.provenance.sourceType}</dd></div>
                <div><dt>Creator</dt><dd>{lesson.provenance.creator ?? 'unknown'}</dd></div>
                <div><dt>Upload date</dt><dd>{lesson.provenance.uploadDate ?? 'unknown'}</dd></div>
                <div><dt>Platform</dt><dd>{lesson.provenance.platform ?? 'local / unknown'}</dd></div>
                <div><dt>Performance group</dt><dd>{lesson.performance_group_id}</dd></div>
                <div><dt>Analyzed segment</dt><dd>{lesson.segment.startSeconds.toFixed(2)}–{lesson.segment.endSeconds.toFixed(2)} s</dd></div>
                <div><dt>Reference audio</dt><dd>{duration.toFixed(2)} s · {lesson.audio.referenceSampleRate} Hz · {lesson.audio.referenceChannels} channel(s)</dd></div>
                <div><dt>Analysis version</dt><dd>{lesson.analysisVersion.lessonBuilder} · {lesson.analysisVersion.rhythmAlgorithm}</dd></div>
                <div><dt>Measured arrays</dt><dd>times, RMS, spectral flux, band energy (stored in features.npz; not parsed here)</dd></div>
                <div><dt>Observed controller actions</dt><dd>{lesson.observedControllerActions === null ? 'none' : `${lesson.observedControllerActions.length} supplied`}</dd></div>
                <div><dt>Will save: segment</dt><dd>{segment.startSeconds}–{segment.endSeconds} s · reviewed</dd></div>
                <div><dt>Will save: beat grid</dt><dd>{grid.bpm} BPM · {grid.offsetSeconds} s anchor · reviewed</dd></div>
                <div><dt>Will save: technique</dt><dd>{technique || 'none (null)'}</dd></div>
                <div><dt>Will save: notes</dt><dd>{notes || 'empty'}</dd></div>
                <div><dt>Preserved annotation keys</dt><dd>{untouchedKeys.length ? untouchedKeys.join(', ') : 'none'}</dd></div>
                {untouchedKeys.map(key => <div key={key}><dt>Will preserve: {key}</dt>
                  <dd>{JSON.stringify(lesson.humanAnnotations[key]) ?? 'undefined'}</dd></div>)}
              </dl>
              <h4>Warnings</h4>
              {[...lesson.heuristicEstimates.warnings, ...lesson.heuristicEstimates.rhythm.warnings].map((warning, index) =>
                <p className="analysis-note" key={`${warning}-${index}`}>{warning}</p>)}
              <details><summary>Show raw lesson JSON</summary><pre>{JSON.stringify(lesson, null, 2)}</pre></details>
            </section>

            <div className="analysis-actions lesson-save-row">
              <button className="guide-btn" disabled={!validSegment || !validGrid || !!busy} onClick={() => void save()}>
                {busy === 'save' ? 'Saving…' : 'Save annotations'}
              </button>
              <span>{revision === null ? 'No revision saved this session' : `Saved revision ${revision}`}</span>
            </div>
          </>}
        </main>
      </div>
      {message && <p role="status" className="lesson-status">{message}</p>}
      {error && <p role="alert" className="lesson-error">{error}</p>}
    </section>
  </div>;
}

// Module summary: This modal owns local lesson import, reference-only audition, review edits, and annotation saves.
// Its Web Audio decoding exists only to draw a lightweight overview and never touches the live mixer context.
// Heuristic onsets, grid estimates, regions, and keys remain visibly distinct from explicit human review.
