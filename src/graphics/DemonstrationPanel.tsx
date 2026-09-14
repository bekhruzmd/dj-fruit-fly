import { useEffect, useRef, useState, type RefObject } from 'react';
import type { FlyWireCircuit } from '../neural/FlyWireCircuit';
import { trainDemonstrations, type DemoFrame, type Demonstration, type ImitationResult } from '../neural/DemonstrationLearning';

export interface DemoSample { frame: DemoFrame; source: string; eligible: boolean }
interface Props {
  circuit: RefObject<FlyWireCircuit | null>;
  sink: RefObject<((sample: DemoSample) => void) | null>;
  onApply: (result: ImitationResult) => void;
}

export function DemonstrationPanel({ circuit, sink, onApply }: Props) {
  const [takes, setTakes] = useState<Demonstration[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<ImitationResult | null>(null);
  const capture = useRef<Demonstration | null>(null);
  const duration = useRef(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    sink.current = sample => {
      const take = capture.current;
      if (!take) return;
      // Do not silently join different songs, paused transport, or hidden-tab
      // gaps into one sequence: the replay's short memory assumes continuity.
      if (!sample.eligible || document.hidden || (take.source && take.source !== sample.source)) {
        capture.current = null;
        setCapturing(false);
        setMessage('Take discarded: keep the same preset playing with Guided Set on and learning frozen.');
        return;
      }
      take.source = sample.source;
      take.frames.push(sample.frame);
      duration.current += sample.frame.dt;
      setSeconds(Math.floor(duration.current));
      // Sixty-four seconds captures about two preset hold/blend cycles at 125
      // BPM. It bounds in-memory data; it is not a required musical phrase length.
      if (duration.current >= 64 || take.frames.length >= 8000) {
        capture.current = null;
        setCapturing(false);
        const positions = take.frames.map(frame => frame.targets[0]);
        if (duration.current >= 32 && Math.max(...positions) - Math.min(...positions) >= 0.5) {
          setTakes(previous => [...previous, take].slice(-2));
          setMessage('Take saved. Record a separate take for evaluation.');
        } else setMessage('Take discarded: a full blend was not captured within the recording limit.');
      }
    };
    return () => { sink.current = null; abort.current?.abort(); };
  }, [sink]);
  // Summary: This captures live sensory/action pairs without recording another copy of the audio.
  // Only frozen guided presets qualify, making the teacher an explicit authored baseline.
  // Pauses, source changes, and hidden pages invalidate a take instead of inventing continuity.

  function toggleCapture() {
    setResult(null);
    if (capture.current) {
      const take = capture.current;
      capture.current = null;
      setCapturing(false);
      // Short snippets can contain only a hold, making a motionless predictor
      // look successful. Require 32 seconds and observable crossfader movement.
      const positions = take.frames.map(frame => frame.targets[0]);
      if (duration.current < 32 || Math.max(...positions) - Math.min(...positions) < 0.5) {
        setMessage('Take discarded: record at least 32 seconds including a full blend.');
        return;
      }
      setTakes(previous => [...previous, take].slice(-2));
      setMessage('Take saved. The first take trains; the second evaluates.');
    } else {
      capture.current = { id: crypto.randomUUID(), source: '', frames: [] };
      duration.current = 0;
      setSeconds(0);
      setCapturing(true);
      setMessage('Recording teacher moves. Keep the page visible; capture stops at 64 seconds.');
    }
  }
  // Summary: This starts or finishes one bounded example and requires meaningful fader movement.
  // Two independently captured takes prevent scoring on the exact recording used for updates.
  // The same preset pair in both takes still cannot demonstrate skill on unfamiliar music.

  async function train() {
    if (!circuit.current || takes.length !== 2) return;
    setBusy(true);
    setResult(null);
    setMessage('Training a separate brain for 20 passes through take 1…');
    const controller = new AbortController();
    abort.current = controller;
    try {
      const next = await trainDemonstrations(circuit.current, takes[0], takes[1], controller.signal);
      setResult(next);
      setMessage(next.improved ? 'Candidate passed the command-imitation check. Listen before judging quality.'
        : 'Candidate did not pass. Your live brain is unchanged; its inputs may be insufficient for this example.');
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Training failed');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  // Summary: This fits only take 1 and reports raw-command error on take 2 before and after fitting.
  // Training yields between epochs and can be cancelled without touching the live brain.
  // Offline replay omits the candidate's acoustic consequences, so a passing score requires live listening next.

  function apply() {
    if (!result) return;
    try {
      onApply(result);
      setResult(null);
      setMessage('Candidate applied, playback stopped, Guided Set off, learning frozen. Press Play to listen. Reload your saved baseline to compare.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not apply'); }
  }
  // Summary: This asks the parent to stop audio and install a verified candidate for frozen listening.
  // Stale results are rejected if the live brain changed after training started.
  // Applying does not save over the user's baseline checkpoint; Save Brain remains explicit.

  return <details className="demo-panel">
    <summary>Learn from a demonstration</summary>
    <p>Choose a built-in preset, enable Guided Set, freeze Learning Loop, and press Play.
      Record two 32–64 second takes, including a blend in each. Take 1 teaches; take 2 checks.</p>
    <p>Teacher: our authored director. Supervised KC→DN training, separate from dopamine learning.
      Save Brain before applying a candidate so you can restore your baseline.</p>
    <div className="analysis-actions">
      <button className="pill-btn" disabled={busy} onClick={toggleCapture}>{capturing ? `Finish take (${seconds}s)` : 'Record teacher take'}</button>
      <button className="pill-btn" disabled={busy || capturing || takes.length !== 2} onClick={train}>Train candidate</button>
      <button className="pill-btn" disabled={!busy} onClick={() => {
        abort.current?.abort(); setBusy(false); setMessage('Training cancelled. Live brain unchanged.');
      }}>Cancel</button>
      <button className="pill-btn" disabled={busy || capturing} onClick={() => {
        setTakes([]); setResult(null); setMessage('Recordings cleared.');
      }}>Clear takes</button>
    </div>
    <p>{takes.length}/2 takes in memory · closing the page clears recordings.</p>
    {result && <>
      <table><caption>Evaluation take: mean squared command error (lower is closer)</caption>
        <thead><tr><th>Command</th><th>Before</th><th>After</th></tr></thead>
        <tbody>{['Crossfader', 'Filter', 'Stutter'].map((name, i) => <tr key={name}>
          <th>{name}</th><td>{result.before[i].toFixed(4)}</td><td>{result.after[i].toFixed(4)}</td>
        </tr>)}</tbody></table>
      <button className="pill-btn" disabled={!result.improved || busy || capturing} onClick={apply}>Apply candidate & freeze</button>
    </>}
    <p role="status">{message}</p>
    <p>These scores measure imitation, not sound quality. No videos or professional mixes were used.
      The fly still lacks phrase context; successful replay may fail when its own actions change the sound.</p>
  </details>;
}
// Module summary: This provides a local demonstration experiment with separate teaching and evaluation takes.
// The user retains control over applying weights and can freeze the resulting unassisted brain for listening.
// It is a training instrument, not proof of musical improvement or autonomous track selection.
