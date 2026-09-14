import { useEffect, useRef, useState } from 'react';
import { auditionGrid } from '../audio/GridAudition';
import { correctionKey, gridTimes, initialGrid, validateGrid, type BeatGrid, type TrackAnalysis } from '../audio/TrackAnalysis';

interface Props {
  deck: 'A' | 'B';
  name: string;
  analysis: TrackAnalysis;
  cacheHit: boolean;
  buffer: AudioBuffer;
  context: AudioContext;
  onApply: (grid: BeatGrid) => void;
  onClose: () => void;
}

export function TrackAnalysisPanel({ deck, name, analysis, cacheHit, buffer, context, onApply, onClose }: Props) {
  const [grid, setGrid] = useState(() => initialGrid(analysis));
  const [from, setFrom] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [message, setMessage] = useState('');
  const panelRef = useRef<HTMLElement | null>(null);
  const auditionGeneration = useRef(0);
  const stopRef = useRef<(() => void) | null>(null);
  const valid = validateGrid(grid, analysis.durationSeconds);
  const end = Math.min(from + 12, analysis.durationSeconds);
  const span = Math.max(0.001, end - from);
  const energy = analysis.energyCurve.filter(p => p.time >= from && p.time < end);
  const peak = Math.max(0.01, ...energy.map(p => p.rms));
  const energyPath = energy.map(p => `${(p.time - from) / span * 1000},${90 - p.rms / peak * 70}`).join(' ');
  const beats = valid ? gridTimes(grid, from, end) : [];

  useEffect(() => {
    auditionGeneration.current++;
    stopRef.current?.();
    return () => { auditionGeneration.current++; stopRef.current?.(); };
  }, [grid.bpm, grid.offsetSeconds, from]);
  // Summary: Editing timing cancels the old audition rather than leaving stale clicks playing.
  // The same cleanup runs on dialog unmount so scheduled sources do not leak into playback.
  // A new audition is intentionally required after a change to make comparisons unambiguous.

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLButtonElement>('button')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    // Summary: This keeps keyboard navigation within the active grid dialog and supports Escape to close.
    // Focus wrapping prevents keyboard users from accidentally starting the obscured live mixer.
    // The focusable selector must grow if new kinds of controls are added to this dialog.
    panel?.addEventListener('keydown', keyboard);
    return () => { panel?.removeEventListener('keydown', keyboard); previous?.focus(); };
  }, [onClose]);
  // Summary: Opening the editor moves focus into it and closing returns focus to the opener.
  // This makes the modal behave as a separate audition task for keyboard users as well as mouse users.
  // Replacing its parent callback can reinitialize focus, so the parent keeps that callback stable.

  const preview = async () => {
    if (previewing) { stopRef.current?.(); return; }
    const generation = ++auditionGeneration.current;
    try {
      await context.resume();
      if (generation !== auditionGeneration.current) return;
      stopRef.current = auditionGrid(context, buffer, grid, from, () => setPreviewing(false));
      setPreviewing(true);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Audition could not start.'); }
  };
  // Summary: This previews the original audio with equal-accent grid clicks.
  // Resuming from a user gesture satisfies browser audio playback rules before scheduling on the audio clock.
  // Invalid timing or an unavailable audio context produces a visible error instead of a silent preview.

  const apply = () => {
    const reviewed = { ...grid, reviewed: true };
    if (!validateGrid(reviewed, analysis.durationSeconds)) return;
    stopRef.current?.();
    onApply(reviewed);
    setGrid(reviewed);
    try {
      localStorage.setItem(correctionKey(analysis), JSON.stringify(reviewed));
      setMessage('Reviewed grid applied and saved in this browser. Playback tempo is unchanged.');
    } catch { setMessage('Grid applied for this session. Browser storage could not save it.'); }
  };
  // Summary: This applies a listener-reviewed beat interpretation without altering audio speed.
  // Corrections use the content hash and analyzer version so they survive renames but do not overwrite measured events.
  // Saving cannot fix variable tempo, and browser storage restrictions can limit persistence to this session.

  return <div className="analysis-backdrop">
    <section ref={panelRef} className="analysis-panel glass-panel" role="dialog" aria-modal="true" aria-label={`Deck ${deck} beat grid`}>
      <div className="analysis-heading"><div><h2>Deck {deck} · Beat-grid check</h2><p>{name}</p></div>
        <button className="guide-btn" onClick={onClose}>Close grid</button></div>
      <p>{analysis.bpm === null ? 'No reliable tempo detected. The editable 120 BPM value is a manual starting point.' : `Detector: ${analysis.bpm.toFixed(2)} BPM · Rhythm support: ${Math.round(analysis.confidence.score * 100)}%`}
        {' · '}{cacheHit ? 'Cached analysis' : 'New analysis'}</p>
      <p className="analysis-note">Support is a heuristic, not a probability of correctness. Listen near the start, middle, and end for drift.</p>
      <svg viewBox="0 0 1000 105" className="analysis-plot" role="img" aria-label="Energy curve, onsets, and editable beat grid for preview window">
        <polyline points={energyPath} fill="none" stroke="#ffb703" strokeWidth="2" />
        {analysis.onsetTimes.filter(t => t >= from && t < end).map(t => <line key={`o${t}`} x1={(t - from) / span * 1000} x2={(t - from) / span * 1000} y1="80" y2="98" stroke="#ff4d89" />)}
        {beats.map(t => <line key={`b${t}`} x1={(t - from) / span * 1000} x2={(t - from) / span * 1000} y1="8" y2="98" stroke="#00e5ff" opacity="0.65" />)}
      </svg>
      <p className="analysis-note">Gold: RMS energy · Pink: detected onsets · Cyan: editable beat grid · {from.toFixed(1)}–{end.toFixed(1)} seconds</p>
      <div className="analysis-fields">
        <label>BPM<input type="number" min="40" max="300" step="0.01" value={grid.bpm} onChange={e => setGrid({ ...grid, bpm: Number(e.target.value), reviewed: false })} /></label>
        <label>Beat anchor (seconds)<input type="number" min="0" max={analysis.durationSeconds} step="0.005" value={grid.offsetSeconds} onChange={e => setGrid({ ...grid, offsetSeconds: Number(e.target.value), reviewed: false })} /></label>
        <label>Preview from (seconds)<input type="number" min="0" max={Math.max(0, analysis.durationSeconds - 0.1)} step="1" value={from} onChange={e => setFrom(Math.max(0, Math.min(analysis.durationSeconds - 0.1, Number(e.target.value))))} /></label>
      </div>
      <div className="analysis-actions">
        <button className="guide-btn" disabled={grid.bpm / 2 < 40} onClick={() => setGrid({ ...grid, bpm: grid.bpm / 2, reviewed: false })}>Half tempo</button>
        <button className="guide-btn" disabled={grid.bpm * 2 > 300} onClick={() => setGrid({ ...grid, bpm: grid.bpm * 2, reviewed: false })}>Double tempo</button>
        <button className="guide-btn" onClick={() => setGrid({ ...grid, offsetSeconds: Math.max(0, Math.round((grid.offsetSeconds - 0.025) * 1000) / 1000), reviewed: false })}>−25 ms</button>
        <button className="guide-btn" onClick={() => setGrid({ ...grid, offsetSeconds: Math.round((grid.offsetSeconds + 0.025) * 1000) / 1000, reviewed: false })}>+25 ms</button>
        <button className="guide-btn" onClick={() => setGrid({ bpm: analysis.bpm ?? 120, offsetSeconds: analysis.gridOffsetSeconds ?? 0, reviewed: false })}>Restore estimate</button>
      </div>
      <div className="analysis-actions">
        <button className="guide-btn" disabled={!valid} onClick={preview}>{previewing ? 'Stop audition' : 'Audition with clicks'}</button>
        <button className="guide-btn" disabled={!valid} onClick={apply}>Apply reviewed grid</button>
        <span>{grid.reviewed ? 'Reviewed' : 'Unreviewed'} · No time stretching</span>
      </div>
      {!valid && <p role="alert">Enter 40–300 BPM and an anchor inside this track.</p>}
      <p role="status">{message}</p>
      <p className="analysis-note">Downbeats, phrases, key, and vocals: not analyzed. A beat anchor is not necessarily the first beat of a bar.</p>
      {analysis.warnings.map(w => <p className="analysis-note" key={w}>{w}</p>)}
    </section>
  </div>;
}
// Summary: This editor makes analysis uncertainty audible and lets the listener correct tempo and phase.
// A short RMS/onset display provides context while click audition checks alignment on the original recording.
// A constant grid cannot represent changing tempo, and reviewing it does not supply downbeats or automatic beatmatching.

// Module summary: This is the human-review boundary between a detector estimate and a usable deck grid.
// It keeps local corrections separate from measured analysis and offers explicit half/double-time choices.
// The parent stops live playback and recording before opening it so preview audio never contaminates training.
