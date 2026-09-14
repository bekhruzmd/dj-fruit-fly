import { gridTimes, validateGrid, type BeatGrid } from './TrackAnalysis';

export function auditionGrid(ctx: AudioContext, buffer: AudioBuffer, grid: BeatGrid, from: number, onEnd: () => void): () => void {
  if (!validateGrid(grid, buffer.duration) || !Number.isFinite(from) || from < 0 || from >= buffer.duration) {
    throw new Error('Choose a valid BPM, anchor, and preview position.');
  }
  const duration = Math.min(12, buffer.duration - from);
  const start = ctx.currentTime + 0.05;
  const source = ctx.createBufferSource();
  const musicGain = ctx.createGain();
  const clickGain = ctx.createGain();
  const nodes: OscillatorNode[] = [];
  source.buffer = buffer;
  musicGain.gain.value = 0.35;
  clickGain.gain.value = 0.12;
  source.connect(musicGain).connect(ctx.destination);
  clickGain.connect(ctx.destination);
  // Schedule against the audio clock, not setTimeout: visual timer jitter must
  // not make a correct grid sound wrong. All clicks have equal pitch because
  // an unlabelled beat grid does not tell us which beat is a bar's downbeat.
  for (const beat of gridTimes(grid, from, from + duration)) {
    const at = start + beat - from;
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();
    oscillator.frequency.value = 1400;
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(1, at + 0.002);
    envelope.gain.exponentialRampToValueAtTime(0.001, at + 0.025);
    oscillator.connect(envelope).connect(clickGain);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
    oscillator.start(at);
    oscillator.stop(at + 0.03);
    nodes.push(oscillator);
  }
  let ended = false;
  const stop = () => {
    if (ended) return;
    ended = true;
    source.onended = null;
    try { source.stop(); } catch { /* Source may already have finished naturally. */ }
    source.disconnect(); musicGain.disconnect(); clickGain.disconnect();
    for (const node of nodes) { try { node.stop(); } catch { /* Already stopped. */ } }
    onEnd();
  };
  // Summary: This cleanup ends both the preview track and every scheduled click exactly once.
  // Disconnecting the preview branch prevents tails or cancelled clicks from leaking into the live set.
  // A closed audio context may already have ended sources, so repeated stop requests are harmless.
  source.onended = stop;
  source.start(start, from, duration);
  return stop;
}
// Summary: This lets a listener compare a fitted beat grid with twelve seconds of the original track.
// The preview uses a separate quiet music-and-click branch so audition does not feed dopamine or recording.
// Codec timing differences and variable tempo can still cause drift; audition at several positions before saving.

// Module summary: This module provides an audio-clock-based check of BPM and beat phase.
// It deliberately adds no bar accents because downbeats have not been detected.
// The caller must stop the live mix before previewing, and dispose the returned cleanup when closing the editor.
