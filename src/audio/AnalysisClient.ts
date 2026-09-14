import { isTrackAnalysis, type TrackAnalysis } from './TrackAnalysis';

export async function analyzeTrack(file: File, signal: AbortSignal): Promise<{ analysis: TrackAnalysis; cacheHit: boolean }> {
  if (file.size > 100 * 1024 * 1024) throw new Error('Analysis supports files up to 100 MB.');
  const response = await fetch('/api/analysis', {
    method: 'POST', body: file, signal, headers: { 'Content-Type': 'application/octet-stream' },
  });
  // Vite returns non-JSON when the local Python service is absent. Give an
  // actionable message while retaining the already loaded, playable deck.
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(body?.error || 'Start the local analyzer with npm run analysis, then retry.');
  if (!isTrackAnalysis(body.analysis)) throw new Error('The analyzer returned incompatible metadata. Restart it and retry.');
  return { analysis: body.analysis, cacheHit: body.cacheHit === true };
}
// Summary: This uploads a selected file to the local analysis service and validates its answer.
// The same-origin proxy keeps service details out of component code and AbortSignal prevents stale UI updates.
// An offline server, unsupported codec, or cancelled upload leaves playback available but analysis unknown.

// Module summary: This is the browser/Python boundary for imported-track metadata.
// Python owns content-hash caching and expensive analysis; the browser owns audition and corrections.
// Public hosting needs a deployed analysis backend because the local development service is not bundled by Vite.
