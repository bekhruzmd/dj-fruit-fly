import { useState } from 'react';
import type { TransitionState } from '../bridge/protocol';
import type { DjayBridgeClient } from '../bridge/DjayBridgeClient';

export function TransitionPanel({ client, state, liveAudio }: {
  client: DjayBridgeClient; state: TransitionState | null; liveAudio: boolean;
}) {
  const [bpm, setBpm] = useState('120');
  const [source, setSource] = useState(1);
  const [confirmed, setConfirmed] = useState(false);
  const active = !!state && ['preparing', 'running', 'settling'].includes(state.phase);
  const tempo = Number(bpm);
  const enabled = !!state?.ready && liveAudio && Number.isFinite(tempo) && tempo >= 60 && tempo <= 180;
  const command = (operation: 'prepare' | 'start') => {
    client.transitionCommand(operation, { liveAudio, source, bpm: tempo, confirmed });
    if (operation === 'start') setConfirmed(false);
  };
  return <section className="transition-panel glass-panel" aria-label="Assisted DJ transition">
    <div className="transition-heading"><strong>First clean blend</strong><span>8 bars · 2 decks</span></div>
    <p>Load two tracks in djay. Use classic EQ, center filters, raise channel volumes, and move the crossfader fully to the source deck. Turn Automix and Crossfader FX off.</p>
    <div className="transition-options">
      <label>Direction<select value={source} disabled={active} onChange={e => { setSource(Number(e.target.value)); setConfirmed(false); }}>
        <option value={1}>Deck 1 → Deck 2</option><option value={2}>Deck 2 → Deck 1</option>
      </select></label>
      <label>Synced BPM<input type="number" min="60" max="180" step="0.1" value={bpm} disabled={active}
        onChange={e => { setBpm(e.target.value); setConfirmed(false); }} /></label>
    </div>
    <div className="transition-decks">{[1, 2].map(deck => <div key={deck}>
      <span>Deck {deck}</span>
      {(['playing', 'cue', 'sync'] as const).map(action => {
        const field = `${action}${deck}` as keyof TransitionState['writable'];
        const title = action === 'playing' ? 'Play / pause' : action === 'cue' ? 'Cue' : 'Sync';
        return <button key={field} disabled={active || !state?.writable[field]}
          onClick={() => { setConfirmed(false); client.transitionCommand('press', { field }); }}>{title}</button>;
      })}
    </div>)}</div>
    <button disabled={!enabled || active} onClick={() => { setConfirmed(false); command('prepare'); }}>1. Prepare incoming bass</button>
    <label className="transition-confirm"><input type="checkbox" checked={confirmed} disabled={active}
      onChange={e => setConfirmed(e.target.checked)} />Both decks are playing in BPM + Beat Sync; the entered BPM matches.</label>
    <div className="transition-buttons">
      <button disabled={!enabled || active || !confirmed} onClick={() => command('start')}>2. Start on phrase downbeat</button>
      <button className="transition-stop" onClick={() => client.transitionCommand('stop')}>Stop blend</button>
    </div>
    <progress max={1} value={state?.progress ?? 0} aria-label="Transition progress" />
    <p role="status">{client.lastError ?? (!liveAudio ? 'Start audio listening to prepare a blend.' : state?.blocker ?? state?.reason ?? 'Start npm run bridge to connect to djay.')}</p>
    <small>Start on beat 1 of a new phrase. Timing uses your BPM and click; automatic phrase detection is not enabled. Stop holds the current mixer position.</small>
  </section>;
}
