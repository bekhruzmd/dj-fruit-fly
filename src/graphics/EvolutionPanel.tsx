import { useState, useRef, type RefObject } from 'react';
import type { FlyWireCircuit } from '../neural/FlyWireCircuit';
import {
  EvolutionEngine,
  type EvolutionConfig,
  type EvolutionTelemetry,
  DEFAULT_EVOLUTION_CONFIG,
} from '../neural/EvolutionEngine';

interface Props {
  circuit: RefObject<FlyWireCircuit | null>;
  onApplyBest: (W_kc_dn: Float32Array) => void;
}

export function EvolutionPanel({ circuit, onApplyBest }: Props) {
  const [config, setConfig] = useState<EvolutionConfig>({ ...DEFAULT_EVOLUTION_CONFIG });
  const [telemetry, setTelemetry] = useState<EvolutionTelemetry | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const engineRef = useRef<EvolutionEngine | null>(null);
  const abortRef  = useRef<AbortController | null>(null);

  function initPopulation() {
    const c = circuit.current;
    if (!c) return;
    // Sync sparsity from the live circuit
    const effectiveConfig: EvolutionConfig = { ...config, sparsityK: c.sparsityK };
    const engine = new EvolutionEngine();
    engine.initPopulation(c.W_kc_dn, c.W_pn_kc, effectiveConfig);
    engineRef.current = engine;
    setTelemetry(engine.getTelemetry());
    setMessage(`Population of ${effectiveConfig.populationSize} brains seeded from current weights. Best fitness: ${engine.getBestGenome()?.fitness.toFixed(3)}`);
  }

  async function runGenerations(count: number) {
    const engine = engineRef.current;
    const c = circuit.current;
    if (!engine || !c) { setMessage('Initialize population first.'); return; }
    const snap: EvolutionConfig = { ...config, sparsityK: c.sparsityK };
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    try {
      for (let i = 0; i < count; i++) {
        if (abort.signal.aborted) break;
        const s = engine.runGeneration(c.W_pn_kc, snap);
        setTelemetry(engine.getTelemetry());
        setMessage(`Gen ${s.generation} · Best ${s.bestFitness.toFixed(3)} · Avg ${s.avgFitness.toFixed(3)} · Worst ${s.worstFitness.toFixed(3)}`);
        // Yield between generations so the UI stays responsive
        await new Promise<void>(r => setTimeout(r, 0));
      }
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  function applyBest() {
    const best = engineRef.current?.getBestGenome();
    if (!best) { setMessage('No population — initialize first.'); return; }
    onApplyBest(best.W_kc_dn);
    setMessage(`Best genome (fitness ${best.fitness.toFixed(3)}, gen ${engineRef.current!.generation}) applied to fly brain. Save Brain to keep it.`);
  }

  function cancel() {
    abortRef.current?.abort();
    setBusy(false);
    setMessage('Evolution cancelled.');
  }

  function FitnessChart({ tel }: { tel: EvolutionTelemetry }) {
    const hist = tel.history;
    if (hist.length < 2) return null;
    const W = 252, H = 48;
    const all = hist.flatMap(h => [h.bestFitness, h.worstFitness]);
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const span = Math.max(0.001, hi - lo);
    const px = (i: number) => ((i / (hist.length - 1)) * W).toFixed(1);
    const py = (f: number) => (H - 2 - ((f - lo) / span) * (H - 6)).toFixed(1);
    const bestPath  = hist.map((h, i) => `${i ? 'L' : 'M'}${px(i)},${py(h.bestFitness)}`).join(' ');
    const avgPath   = hist.map((h, i) => `${i ? 'L' : 'M'}${px(i)},${py(h.avgFitness)}`).join(' ');
    const worstPath = hist.map((h, i) => `${i ? 'L' : 'M'}${px(i)},${py(h.worstFitness)}`).join(' ');
    return (
      <svg width={W} height={H} style={{ display: 'block', margin: '4px 0', borderRadius: 4 }}>
        <rect width={W} height={H} fill="rgba(0,0,0,0.35)" rx="4" />
        <path d={worstPath} stroke="rgba(255,0,119,0.4)"  strokeWidth="1"   fill="none" />
        <path d={avgPath}   stroke="rgba(255,183,3,0.7)"  strokeWidth="1"   fill="none" />
        <path d={bestPath}  stroke="rgba(0,255,136,1)"    strokeWidth="1.5" fill="none" />
        <text x="4" y="11" fontSize="8" fill="rgba(0,255,136,0.8)">best</text>
        <text x="4" y="21" fontSize="8" fill="rgba(255,183,3,0.7)">avg</text>
        <text x="4" y="31" fontSize="8" fill="rgba(255,0,119,0.5)">worst</text>
      </svg>
    );
  }

  const pop  = config.populationSize;
  const elite = Math.max(1, Math.round(pop * config.eliteRatio));

  return (
    <details className="demo-panel">
      <summary>Evolutionary Population Training</summary>
      <p>
        Evolve a population of {pop} fly brains on synthetic house beats at {config.bpm} BPM.
        Selects {elite} elites ({(config.eliteRatio * 100).toFixed(0)}%), breeds offspring with σ={config.mutationSigma.toFixed(2)} Gaussian mutations.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, margin: '6px 0' }}>
        <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          Population N: {config.populationSize}
          <input type="range" min="10" max="100" step="5" value={config.populationSize} disabled={busy}
            onChange={e => setConfig(c => ({ ...c, populationSize: +e.target.value }))}
            className="slider-range" style={{ width: '100%' }} />
        </label>
        <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          Elite ratio: {(config.eliteRatio * 100).toFixed(0)}% ({elite} brains)
          <input type="range" min="0.05" max="0.50" step="0.05" value={config.eliteRatio} disabled={busy}
            onChange={e => setConfig(c => ({ ...c, eliteRatio: +e.target.value }))}
            className="slider-range" style={{ width: '100%' }} />
        </label>
        <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          Mutation σ: {config.mutationSigma.toFixed(2)}
          <input type="range" min="0.01" max="0.25" step="0.01" value={config.mutationSigma} disabled={busy}
            onChange={e => setConfig(c => ({ ...c, mutationSigma: +e.target.value }))}
            className="slider-range" style={{ width: '100%' }} />
        </label>
        <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          Eval ticks: {config.evalTicks} (~{(config.evalTicks * 0.04).toFixed(0)} s)
          <input type="range" min="100" max="500" step="50" value={config.evalTicks} disabled={busy}
            onChange={e => setConfig(c => ({ ...c, evalTicks: +e.target.value }))}
            className="slider-range" style={{ width: '100%' }} />
        </label>
        <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          Synthetic BPM: {config.bpm}
          <input type="range" min="118" max="135" step="1" value={config.bpm} disabled={busy}
            onChange={e => setConfig(c => ({ ...c, bpm: +e.target.value }))}
            className="slider-range" style={{ width: '100%' }} />
        </label>
      </div>

      <div className="analysis-actions">
        <button className="pill-btn" disabled={busy} onClick={initPopulation}>Init Pop</button>
        <button className="pill-btn" disabled={busy || !engineRef.current} onClick={() => runGenerations(1)}>Run 1 Gen</button>
        <button className="pill-btn" disabled={busy || !engineRef.current} onClick={() => runGenerations(10)}>Run 10 Gens</button>
        <button className="pill-btn" disabled={!busy} onClick={cancel}>Cancel</button>
        <button className="pill-btn" disabled={busy || !engineRef.current} onClick={applyBest}>Apply Best</button>
      </div>

      {telemetry && (
        <>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0', lineHeight: 1.6 }}>
            <span>Gen {telemetry.generation} &nbsp;·&nbsp; Pop {telemetry.populationSize}</span><br />
            <span style={{ color: 'var(--green)' }}>▲ Best&nbsp;&nbsp;{telemetry.bestFitness.toFixed(3)}</span>
            {' · '}
            <span style={{ color: 'var(--gold)' }}>~ Avg&nbsp;&nbsp;{telemetry.avgFitness.toFixed(3)}</span>
            {' · '}
            <span style={{ color: 'var(--pink)' }}>▼ Worst {telemetry.worstFitness.toFixed(3)}</span>
          </div>
          <FitnessChart tel={telemetry} />
        </>
      )}

      <p role="status">{message}</p>
      <p style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: 4 }}>
        Fitness is scored on synthetic beats, not live audio. After applying, use Save Brain to persist the evolved weights.
        Re-init reseeds from the current (possibly already evolved) brain.
      </p>
    </details>
  );
}
