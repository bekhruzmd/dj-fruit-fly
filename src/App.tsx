import { analyzeTrack } from './audio/AnalysisClient';
import { type TrackAnalysis, type BeatGrid } from './audio/TrackAnalysis';
import { TrackAnalysisPanel } from './graphics/TrackAnalysisPanel';
import { SetRecorder } from './audio/SetRecorder';
import { DemonstrationPanel, type DemoSample } from './graphics/DemonstrationPanel';
import { applyImitation, type ImitationResult } from './neural/DemonstrationLearning';
import { EvolutionPanel } from './graphics/EvolutionPanel';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { 
  Play, Pause, Disc, Upload, RotateCcw, Lock, Unlock, 
  Sparkles, Zap, Activity, Sliders, 
  Eye, HelpCircle, TrendingUp
} from 'lucide-react';
import confetti from 'canvas-confetti';

import { AudioFeatureExtractor, type AudioFeatures } from './audio/AudioFeatureExtractor';
import { DJAudioEngine } from './audio/DJAudioEngine';
import { FlyWireCircuit, type CircuitTelemetry } from './neural/FlyWireCircuit';
import { FlyAvatar3D } from './graphics/FlyAvatar3D';
import { CircuitHUD } from './graphics/CircuitHUD';
import { LearningPlotsPanel } from './graphics/LearningPlotsPanel';

type AnalysisState = { status: 'idle' | 'loading' | 'analyzing' | 'ready' | 'error'; analysis?: TrackAnalysis; cacheHit?: boolean; error?: string };

export const App: React.FC = () => {
  // Canvas Refs
  const viewport3DRef = useRef<HTMLCanvasElement | null>(null);
  const hudCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputARef = useRef<HTMLInputElement | null>(null);
  const fileInputBRef = useRef<HTMLInputElement | null>(null);

  // Engine Instances
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioExtractorRef = useRef<AudioFeatureExtractor | null>(null);
  const djEngineRef = useRef<DJAudioEngine | null>(null);
  const circuitRef = useRef<FlyWireCircuit | null>(null);
  const demonstrationSink = useRef<((sample: DemoSample) => void) | null>(null);
  const avatar3DRef = useRef<FlyAvatar3D | null>(null);
  const hudVisualizerRef = useRef<CircuitHUD | null>(null);

  const analysisGeneration = useRef({ A: 0, B: 0 });
  const analysisAbort = useRef<Record<'A' | 'B', AbortController | null>>({ A: null, B: null });
  const importedFiles = useRef<Record<'A' | 'B', File | null>>({ A: null, B: null });
  const [deckAnalysis, setDeckAnalysis] = useState<Record<'A' | 'B', AnalysisState>>({ A: { status: 'idle' }, B: { status: 'idle' } });
  const [editingDeck, setEditingDeck] = useState<'A' | 'B' | null>(null);
  const closeGrid = useCallback(() => setEditingDeck(null), []);
  // Summary: This closes the grid editor using a stable callback across live telemetry renders.
  // Stable identity prevents the dialog focus effect from restarting twenty times per second.
  // The editor still owns stopping any scheduled audition when it unmounts.
  const recorderRef = useRef<SetRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [customAudio, setCustomAudio] = useState(false);
  const [recordingError, setRecordingError] = useState('');
  const [recordingUrl, setRecordingUrl] = useState('');
  const recordingUrlRef = useRef('');
  const trainingTargetRef = useRef<number | null>(null);
  const [trainingTarget, setTrainingTarget] = useState<number | null>(null);
  const [guidedSet, setGuidedSet] = useState(true);
  const [transportLabel, setTransportLabel] = useState('125 BPM · Guided Set');

  // UI State
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [trackAName, setTrackAName] = useState<string>('Neuro-DJ - Chicago Afterhours (Deck A)');
  const [trackBName, setTrackBName] = useState<string>('Neuro-DJ - Terrace Tools (Deck B)');
  const [showHUD, setShowHUD] = useState<boolean>(true);
  const [showPlots, setShowPlots] = useState<boolean>(false);
  const [showGuide, setShowGuide] = useState<boolean>(false);

  // Circuit Tuning State
  const [learningEnabled, setLearningEnabled] = useState<boolean>(true);
  const [learningRate, setLearningRate] = useState<number>(0.04);
  const [sparsityK, setSparsityK] = useState<number>(4);

  // Live Telemetry State
  const [telemetry, setTelemetry] = useState<CircuitTelemetry>({
    stage: 'naive',
    activeKCs: 0,
    sparsityPercent: 6.2,
    dopamine: 0,
    rewardBreakdown: {
      totalReward: 0,
      beatTransitionBonus: 0,
      rmsStabilityBonus: 0,
      trainwreckPenalty: 0,
      discontinuityPenalty: 0,
      phraseBonus: 0,
      bassSwapBonus: 0,
      tensionBonus: 0
    },
    rewardHistory: [],
    cumulativeRewardCurrentPass: 0,
    passHistory: [],
    crossfaderTrajectory: [],
    controls: {
      crossfader: 0.0,
      filterCutoff: 0.5,
      stutterTrigger: false,
      rawCrossfader: 0.0,
      rawFilter: 0.5,
      rawStutter: 0.0
    },
    avgSynapticWeight: 0.20,
    totalPlasticityEvents: 0,
    currentPass: 1,
    passProgress: 0
  });

  const [audioStats, setAudioStats] = useState<AudioFeatures>({
    subBass: 0,
    lowMids: 0,
    highMids: 0,
    highs: 0,
    spectralFlux: 0,
    onset: 0,
    isBeat: false
  });

  // Initialize Closed-Loop Engines on Mount
  useEffect(() => {
    const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtxClass();
    audioContextRef.current = ctx;

    // 1. Dual-Deck Consequential Audio Engine
    const djEngine = new DJAudioEngine(ctx);
    djEngineRef.current = djEngine;
    const recorder = new SetRecorder(ctx, blob => {
      if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
      recordingUrlRef.current = URL.createObjectURL(blob);
      setRecordingUrl(recordingUrlRef.current);
      setRecording(false);
      setRecordingBusy(false);
    }, message => {
      setRecordingError(message);
      setRecording(false);
      setRecordingBusy(false);
    });
    recorderRef.current = recorder;

    // 2. Audio Feature Extractor (Johnston's Organ)
    const extractor = new AudioFeatureExtractor(ctx);
    audioExtractorRef.current = extractor;

    // Route: DJ Engine Out -> Speakers (Destination) AND Johnston's Organ Analyser
    djEngine.outputNode.connect(ctx.destination);
    extractor.connectSource(djEngine.outputNode);

    // Initial track names
    const names = djEngine.getTrackNames();
    setTrackAName(names.trackA);
    setTrackBName(names.trackB);

    // 3. Connectome Circuit with 3-Factor Plasticity on W_KC_DN
    const circuit = new FlyWireCircuit();
    circuitRef.current = circuit;

    // 4. Three.js 3D Avatar
    if (viewport3DRef.current) {
      const avatar = new FlyAvatar3D(viewport3DRef.current);
      avatar3DRef.current = avatar;
    }

    // 5. Circuit HUD Visualizer
    if (hudCanvasRef.current) {
      const hud = new CircuitHUD(hudCanvasRef.current);
      hudVisualizerRef.current = hud;
    }

    // Resize Handler
    const handleResize = () => {
      if (viewport3DRef.current && avatar3DRef.current) {
        avatar3DRef.current.resize(window.innerWidth, window.innerHeight);
      }
    };
    window.addEventListener('resize', handleResize);

    // 6. MAIN CLOSED-LOOP SIMULATION & AUDIO CONTROL TICK
    let animationFrameId: number;
    let lastTime = performance.now();
    let telemetryThrottle = 0;

    const renderLoop = (time: number) => {
      const elapsed = (time - lastTime) / 1000.0;
      const dt = Math.min(0.05, elapsed);
      lastTime = time;

      // (a) Read acoustic feedback from Johnston's Organ FFT
      const features = extractor.update();
      const { currentRMS, deltaRMS } = djEngine.updateAcoustics();

      // (b) Step connectome: PNs -> KCs (APL sparse) -> Descending Neurons -> Dopamine Reward
      const sensoryInputs = [features.subBass, features.lowMids, features.highMids, features.highs];
      const isStandby = !djEngine.isPlaying;
      const curTelemetry = circuit.step(
        sensoryInputs,
        features.onset,
        features.isBeat,
        currentRMS,
        deltaRMS,
        dt,
        isStandby,
        undefined,
        djEngine.getPlaybackTiming()
      );

      // (c) CLOSED LOOP: APPLY NEURAL OUTPUTS DIRECTLY TO REAL AUDIO DSP NODES!
      demonstrationSink.current?.({
        frame: { bands: sensoryInputs, dt: elapsed,
          targets: [curTelemetry.controls.crossfader, curTelemetry.controls.filterCutoff,
            curTelemetry.controls.stutterTrigger ? 1 : 0] },
        source: JSON.stringify(djEngine.getTrackNames()),
        eligible: !isStandby && circuit.guidedSet && !circuit.learningEnabled
          && !djEngine.hasImportedTracks() && elapsed > 0 && elapsed <= 0.1,
      });
      if (djEngine.isPlaying) {
        djEngine.setCrossfader(curTelemetry.controls.crossfader);
        djEngine.setFilter(curTelemetry.controls.filterCutoff, curTelemetry.controls.filterDeck);
        djEngine.setStutter(curTelemetry.controls.stutterTrigger);
      }

      if (trainingTargetRef.current !== null && circuit.currentPass >= trainingTargetRef.current) {
        circuit.learningEnabled = false;
        trainingTargetRef.current = null;
        setTrainingTarget(null);
        setLearningEnabled(false);
      }

      // (d) Animate 3D Rig & Canvas HUD
      if (avatar3DRef.current) {
        avatar3DRef.current.update(features, curTelemetry, dt);
      }
      if (hudVisualizerRef.current) {
        hudVisualizerRef.current.render(features, circuit, curTelemetry);
      }

      // Throttle React state updates to 20fps for peak performance
      telemetryThrottle += dt;
      if (telemetryThrottle > 0.05) {
        telemetryThrottle = 0;
        setTelemetry({ ...curTelemetry });
        setAudioStats({ ...features });
        const grid = djEngine.getPlaybackTiming();
        const blendBeat = grid.totalBeats % 64;
        setTransportLabel(djEngine.hasImportedTracks()
          ? `Imported tracks · Deck A grid: ${djEngine.getDeckGrid('A')?.bpm.toFixed(2) ?? 'unknown'} BPM · Phrases unknown`
          : `${djEngine.masterBpm} BPM · Bar ${Math.floor(blendBeat / 4) + 1}/16 · ${blendBeat < 32 ? 'Let it groove' : 'Blend & bass handoff'}`);
      }

      animationFrameId = requestAnimationFrame(renderLoop);
    };

    animationFrameId = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
      analysisAbort.current.A?.abort();
      analysisAbort.current.B?.abort();
      analysisGeneration.current.A++;
      analysisGeneration.current.B++;
      recorder.dispose();
      if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
      if (djEngine) djEngine.stop();
      if (ctx.state !== 'closed') ctx.close();
    };
  }, []);

  // Update Circuit Tuning Parameters
  useEffect(() => {
    if (circuitRef.current) {
      circuitRef.current.learningEnabled = learningEnabled;
      circuitRef.current.learningRate = learningRate;
      circuitRef.current.sparsityK = sparsityK;
      circuitRef.current.guidedSet = guidedSet;
    }
  }, [learningEnabled, learningRate, sparsityK, guidedSet]);

  // Master Playback Toggle
  const handleTogglePlay = async () => {
    if (!audioContextRef.current || !djEngineRef.current) return;
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    if (djEngineRef.current.isPlaying) recorderRef.current?.stop();
    circuitRef.current?.resetPerformance();
    const nowPlaying = djEngineRef.current.toggle();
    setIsPlaying(nowPlaying);
  };

  const handleRecord = async () => {
    if (!recorderRef.current || !djEngineRef.current || recordingBusy) return;
    setRecordingBusy(true);
    setRecordingError('');
    if (recording) {
      recorderRef.current.stop();
      return;
    }
    try {
      if (!djEngineRef.current.isPlaying) await handleTogglePlay();
      await recorderRef.current.start(djEngineRef.current.outputNode);
      setRecording(true);
    } catch (error) {
      setRecordingError(error instanceof Error ? error.message : 'Could not start recording.');
    } finally { setRecordingBusy(false); }
  };

  const requestDeckAnalysis = async (deck: 'A' | 'B', file: File, generation: number, controller: AbortController) => {
    setDeckAnalysis(prev => ({ ...prev, [deck]: { status: 'analyzing' } }));
    try {
      const result = await analyzeTrack(file, controller.signal);
      if (generation !== analysisGeneration.current[deck] || controller.signal.aborted) return;
      djEngineRef.current?.setDeckAnalysis(deck, result.analysis);
      setDeckAnalysis(prev => ({ ...prev, [deck]: { status: 'ready', ...result } }));
    } catch (error) {
      if (generation !== analysisGeneration.current[deck] || controller.signal.aborted) return;
      setDeckAnalysis(prev => ({ ...prev, [deck]: { status: 'error', error: error instanceof Error ? error.message : 'Analysis unavailable.' } }));
    }
  };
  // Summary: This attaches asynchronous analysis only to the upload that requested it.
  // Cancellation and generation checks stop an older answer from overwriting a newer deck or preset.
  // Analysis can fail independently of decoding; the audio remains playable and the interface offers retry.

  const loadDeckFile = async (deck: 'A' | 'B', file?: File) => {
    if (!file || !djEngineRef.current) return;
    setAudioError('');
    setEditingDeck(null);
    const generation = ++analysisGeneration.current[deck];
    analysisAbort.current[deck]?.abort();
    const controller = new AbortController();
    analysisAbort.current[deck] = controller;
    importedFiles.current[deck] = null;
    setDeckAnalysis(prev => ({ ...prev, [deck]: { status: 'loading' } }));
    try {
      const name = await djEngineRef.current.loadAudioFile(deck, file);
      if (generation !== analysisGeneration.current[deck]) return;
      circuitRef.current?.resetPerformance();
      if (deck === 'A') setTrackAName(name); else setTrackBName(name);
      setCustomAudio(true);
      setGuidedSet(false);
      importedFiles.current[deck] = file;
      await requestDeckAnalysis(deck, file, generation, controller);
    } catch (error) {
      if (generation !== analysisGeneration.current[deck]) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setAudioError('Could not decode this track. Try a WAV or MP3 file.');
      setDeckAnalysis(prev => ({ ...prev, [deck]: { status: 'idle' } }));
    }
  };
  // Summary: Uploads become playable first, then receive cached or freshly analyzed metadata.
  // Each deck has independent cancellation, and imported audio disables unsupported preset phrase assistance.
  // Browser/Python codec differences can still prevent analysis even when browser playback succeeds.

  const handleDropFile = async (deck: 'A' | 'B', e: React.DragEvent) => {
    e.preventDefault();
    await loadDeckFile(deck, e.dataTransfer.files?.[0]);
  };
  // Summary: Dropping a track enters the same guarded loading flow as file selection.
  // This avoids different analysis or race behavior depending on how the file arrived.
  // Only the first dropped file is used because each deck currently holds one track.

  const handleFileUploadA = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    await loadDeckFile('A', input.files?.[0]);
    input.value = '';
  };
  // Summary: This loads Deck A through the shared upload-and-analysis workflow.
  // Clearing the input afterward lets the user retry the same file without renaming it.
  // A cancelled picker has no file and therefore makes no changes.

  const handleFileUploadB = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    await loadDeckFile('B', input.files?.[0]);
    input.value = '';
  };
  // Summary: This loads Deck B with the same cancellation and caching behavior as Deck A.
  // Capturing the input element before awaiting keeps the reset independent of event lifetime.
  // A cancelled picker leaves the existing deck untouched.

  const inspectGrid = (deck: 'A' | 'B') => {
    if (recording || recordingBusy) return;
    const state = deckAnalysis[deck];
    if (state.status === 'error' && importedFiles.current[deck]) {
      const generation = ++analysisGeneration.current[deck];
      analysisAbort.current[deck]?.abort();
      const controller = new AbortController();
      analysisAbort.current[deck] = controller;
      void requestDeckAnalysis(deck, importedFiles.current[deck]!, generation, controller);
      return;
    }
    if (!state.analysis) return;
    djEngineRef.current?.stop();
    circuitRef.current?.resetPerformance();
    setIsPlaying(false);
    setEditingDeck(deck);
  };
  // Summary: This opens a clean audition environment or retries a failed analysis request.
  // Live playback stops before the editor opens, and active recording blocks opening until capture finishes.
  // The user must restart the mix afterward; audition does not train the fly or alter audio tempo.

  const applyGrid = (deck: 'A' | 'B', grid: BeatGrid) => {
    const analysis = deckAnalysis[deck].analysis;
    if (analysis) djEngineRef.current?.setDeckAnalysis(deck, analysis, grid);
  };
  // Summary: This sends an explicit listener correction into the deck's metadata state.
  // The original detector events stay intact while the constant grid becomes the reviewed interpretation.
  // No resampling, beatmatching, or phrase labels are created by applying a grid.

  // Switch between instant genre pairings
  const handleGenrePreset = (preset: 'deep_tech_house' | 'acid_house' | 'french_touch' | 'melodic_afro' | 'rnb_house' | 'funk_disco' | 'afro_amapiano' | 'dnb_jungle') => {
    if (!djEngineRef.current) return;
    setEditingDeck(null);
    for (const deck of ['A', 'B'] as const) {
      analysisGeneration.current[deck]++;
      analysisAbort.current[deck]?.abort();
      importedFiles.current[deck] = null;
    }
    setDeckAnalysis({ A: { status: 'idle' }, B: { status: 'idle' } });
    setGuidedSet(true);
    setCustomAudio(false);
    setAudioError('');
    const names = djEngineRef.current.loadGenrePreset(preset);
    setTrackAName(names.trackA);
    setTrackBName(names.trackB);
    circuitRef.current?.resetPerformance();
  };

  // Summary: Preset selection restores the known authored pair and cancels pending imported-track work.
  // Resetting both UI and engine generations prevents late analysis results from being attached to a preset.
  // User corrections remain in browser storage and can be restored when the same file is loaded later.

  // Reset to Naive Untrained State
  const handleResetWeights = () => {
    if (circuitRef.current) {
      circuitRef.current.resetWeights();
      trainingTargetRef.current = null;
      setTrainingTarget(null);
    }
  };

  // Pre-load Converged Expert Weights
  const handleLoadExpert = () => {
    if (circuitRef.current) {
      circuitRef.current.loadExpertWeights();
      confetti({
        particleCount: 50,
        spread: 70,
        origin: { y: 0.7 },
        colors: ['#00ff88', '#00f0ff', '#ffb703']
      });
    }
  };

  // Practice against real audio. End by freezing weights for a listening check.
  const handleRunAcceleratedPasses = async (numPasses: number) => {
    const circuit = circuitRef.current;
    const engine = djEngineRef.current;
    if (!circuit || !engine || !audioContextRef.current) return;
    await audioContextRef.current.resume();
    if (!engine.isPlaying) {
      circuit.resetPerformance();
      engine.start();
      setIsPlaying(true);
    }
    circuit.learningEnabled = true;
    setLearningEnabled(true);
    const target = circuit.currentPass + numPasses;
    trainingTargetRef.current = target;
    setTrainingTarget(target);
  };

  // Manual Reward Burst ("Good Fly!" / Spacebar)
  const handleManualReward = useCallback(() => {
    if (!circuitRef.current) return;
    circuitRef.current.injectManualDopamine(1.5);
    confetti({
      particleCount: 40,
      spread: 60,
      origin: { y: 0.8 },
      colors: ['#00ff88', '#00f0ff', '#ffb703']
    });
  }, []);

  // Manual Penalty Burst ("Trainwreck / Backspace / X")
  const handleManualPenalty = useCallback(() => {
    if (!circuitRef.current) return;
    circuitRef.current.injectManualDopamine(-1.5);
  }, []);

  // Install an evolved genome's W_kc_dn weights into the live circuit
  const handleApplyEvolvedBest = useCallback((W_kc_dn: Float32Array) => {
    const circuit = circuitRef.current;
    if (!circuit) return;
    for (let i = 0; i < circuit.W_kc_dn.length; i++) {
      circuit.W_kc_dn[i] = W_kc_dn[i];
    }
    circuit.stage = 'training';
    circuit.resetPerformance();
  }, []);

  // Save Trained Brain to LocalStorage
  const handleSaveBrain = useCallback(() => {
    if (!circuitRef.current) return;
    circuitRef.current.saveBrain();
    alert("🧠 Trained Fly Brain saved to browser memory! It will persist across refreshes.");
  }, []);

  // Load Trained Brain from LocalStorage
  const handleLoadBrain = useCallback(() => {
    if (!circuitRef.current) return;
    const ok = circuitRef.current.loadBrain();
    if (ok) {
      alert("🧠 Trained Fly Brain successfully loaded!");
      confetti({
        particleCount: 50,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#00ff88', '#00f0ff', '#ffb703']
      });
      setTelemetry(prev => ({
        ...prev,
        stage: circuitRef.current!.stage,
        currentPass: circuitRef.current!.currentPass,
        passHistory: [...circuitRef.current!.passHistory]
      }));
    } else {
      alert("No saved brain found in browser memory. Train the fly and click Save Brain first!");
    }
  }, []);

  // Keyboard Shortcuts: Space = Play/Pause, R = +PAM Reward, Backspace/X = -PPL1 Penalty
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (editingDeck) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.code === 'KeyR' && !e.repeat) {
        handleManualReward();
      } else if ((e.code === 'Backspace' || e.code === 'KeyX') && !e.repeat) {
        e.preventDefault();
        handleManualPenalty();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleManualReward, handleManualPenalty, editingDeck]);

  return (
    <div className="neuro-dj-container">
      {/* 3D WebGL Canvas */}
      <canvas ref={viewport3DRef} className="viewport-canvas" />

      {editingDeck && deckAnalysis[editingDeck].analysis && audioContextRef.current && djEngineRef.current?.getDeckBuffer(editingDeck) &&
        <TrackAnalysisPanel key={`${editingDeck}-${deckAnalysis[editingDeck].analysis!.trackId}`}
          deck={editingDeck} name={editingDeck === 'A' ? trackAName : trackBName}
          analysis={deckAnalysis[editingDeck].analysis!} cacheHit={deckAnalysis[editingDeck].cacheHit ?? false}
          context={audioContextRef.current} buffer={djEngineRef.current.getDeckBuffer(editingDeck)!}
          onApply={grid => applyGrid(editingDeck, grid)} onClose={closeGrid} />}

      {/* Hidden File Inputs for Deck A and Deck B */}
      <input
        type="file"
        ref={fileInputARef}
        onChange={handleFileUploadA}
        accept="audio/*"
        style={{ display: 'none' }}
      />
      <input
        type="file"
        ref={fileInputBRef}
        onChange={handleFileUploadB}
        accept="audio/*"
        style={{ display: 'none' }}
      />

      {/* TOP HEADER: DUAL DECK CONTROLS */}
      <header className="top-header glass-panel">
        <div className="brand-zone">
          <div className="logo-icon-pulse">
            <Zap size={22} className="text-cyan" />
          </div>
          <div>
            <h1 className="brand-title">NEURO-DJ</h1>
            <p className="brand-sub">Connectome-inspired · Live House Sets</p>
          </div>
        </div>

        {/* Dual Deck Audio Selectors */}
        <div className="dual-deck-bar">
          {/* Deck A */}
          <div 
            className="deck-control-chip deck-a"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleDropFile('A', e)}
            title="Drop ANY audio file (MP3, WAV, FLAC, M4A) here for Deck A"
          >
            <Disc size={16} className="text-cyan animate-spin-slow" />
            <div className="deck-info">
              <span className="deck-label">DECK A (DROP ANY TRACK)</span>
              <span className="deck-track" title={trackAName}>{trackAName}</span>
            </div>
            <button
              className="deck-upload-btn"
              onClick={() => fileInputARef.current?.click()}
              title="Load custom audio into Deck A"
            >
              <Upload size={13} /> Load
            </button>
            {deckAnalysis.A.status !== 'idle' && <button className="deck-upload-btn"
              onClick={() => inspectGrid('A')}
              disabled={recording || recordingBusy || ['loading', 'analyzing'].includes(deckAnalysis.A.status)}
              title={deckAnalysis.A.error || 'Audition and correct the beat grid'}>
              {deckAnalysis.A.status === 'ready' ? 'Grid A' : deckAnalysis.A.status === 'error' ? 'Retry A' : 'Analyzing…'}
            </button>}
          </div>

          {/* Active Crossfader Position Meter */}
          <div className="crossfader-meter-bar">
            <span className="cf-label">A</span>
            <div className="cf-track">
              <div 
                className="cf-thumb" 
                style={{ left: `${telemetry.controls.crossfader * 100}%` }} 
              />
            </div>
            <span className="cf-label">B</span>
          </div>

          {/* Deck B (e.g. Club Beat or ANY second track) */}
          <div 
            className="deck-control-chip deck-b"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleDropFile('B', e)}
            title="Drop ANY audio file (MP3, WAV, FLAC, M4A) here for Deck B"
          >
            <Disc size={16} className="text-pink animate-spin-slow" />
            <div className="deck-info">
              <span className="deck-label">DECK B (DROP ANY TRACK)</span>
              <span className="deck-track" title={trackBName}>{trackBName}</span>
            </div>
            <button
              className="deck-upload-btn"
              onClick={() => fileInputBRef.current?.click()}
              title="Load second track into Deck B"
            >
              <Upload size={13} /> Load
            </button>
            {deckAnalysis.B.status !== 'idle' && <button className="deck-upload-btn"
              onClick={() => inspectGrid('B')}
              disabled={recording || recordingBusy || ['loading', 'analyzing'].includes(deckAnalysis.B.status)}
              title={deckAnalysis.B.error || 'Audition and correct the beat grid'}>
              {deckAnalysis.B.status === 'ready' ? 'Grid B' : deckAnalysis.B.status === 'error' ? 'Retry B' : 'Analyzing…'}
            </button>}
          </div>
        </div>

        {/* Actions */}
        <div className="header-actions">
          <button 
            className="guide-btn"
            onClick={() => setShowPlots(!showPlots)}
            title="Toggle learning dashboard"
          >
            <TrendingUp size={15} /> {showPlots ? 'Hide Learning' : 'Show Learning'}
          </button>
          <button 
            className="guide-btn"
            onClick={() => setShowGuide(!showGuide)}
            title="Connectome & DJing Architecture Guide"
          >
            <HelpCircle size={15} /> Guide
          </button>
        </div>
      </header>

      {/* LEFT DOCK: REAL ACOUSTIC TELEMETRY & CONVERGENCE STATS */}
      <aside className="left-dock glass-panel">
        <div className="dock-section-title">
          <Activity size={16} className="text-cyan" />
          <span>CLOSED-LOOP TELEMETRY</span>
        </div>

        {/* Stage Status */}
        <div className="metric-card stage-card">
          <div className="metric-header">
            <span>FLY LEARNING STATE</span>
            <span className={`badge ${
              telemetry.stage === 'master' ? 'badge-pam' : 
              telemetry.stage === 'training' ? 'badge-gold' : 'badge-neutral'
            }`}>
              {telemetry.stage === 'master' ? 'HANDCRAFTED PRESET' : 
               telemetry.stage === 'training' ? 'TRAINING (PLASTIC)' : 'NAIVE (UNTRAINED)'}
            </span>
          </div>
          <p className="metric-caption">
            {telemetry.stage === 'master'
              ? 'Starting weights designed by hand; not a trained checkpoint'
              : telemetry.stage === 'training'
              ? `Hebbian adaptation active on Pass ${telemetry.currentPass}`
              : 'New brain. Guided Set keeps its first mixes musical.'}
          </p>
        </div>

        <div className="metric-card">
          <div className="metric-header"><span>SET STYLE</span>
            <button className="guide-btn" aria-pressed={guidedSet} disabled={customAudio} onClick={() => setGuidedSet(!guidedSet)}>
              {guidedSet ? 'Guided Set' : 'Unassisted'}
            </button>
          </div>
          <p className="metric-caption">{guidedSet ? 'Eight bars to groove, eight to blend. Neural outputs shape the mix; musical assistance controls phrasing and bass handoffs.' : customAudio ? 'Imported tracks use direct neural controls. Phrase assistance requires detected structure, which is not available yet.' : 'Direct neural controls with bass protection. Expect exploratory movement.'}</p>
          <p className="metric-caption">{transportLabel}</p>
          {customAudio && <p className="metric-caption">Open Grid A/B to audition and correct estimates. Applying a grid does not stretch or beatmatch audio.</p>}
          {(['A', 'B'] as const).map(deck => deckAnalysis[deck].error && <p key={deck} role="alert" className="metric-caption text-pink">Deck {deck}: {deckAnalysis[deck].error}</p>)}
          {audioError && <p role="alert" className="metric-caption text-pink">{audioError}</p>}
          <div className="capture-actions">
          <button className="guide-btn" onClick={handleRecord} disabled={recordingBusy}
            aria-pressed={recording} title="Capture up to two minutes of the live master as stereo WAV">
            {recording ? '● Stop capture' : '○ Record WAV'}
          </button>
          {recordingUrl && <a className="guide-btn" href={recordingUrl} download="neuro-dj-live-set.wav">Download WAV</a>}
          {recordingError && <span role="alert" className="text-pink">{recordingError}</span>}
          </div>
          <p className="metric-caption">{trainingTarget !== null ? `Live practice: ${Math.max(0, trainingTarget - telemetry.currentPass)} passes left, then weights freeze.` : 'Reward what sounds good with R. Press X after a bad move.'}</p>
        </div>

        {/* Live Consequential Control Readouts */}
        <div className="metric-card">
          <div className="metric-header">
            <span>CONSEQUENTIAL DJ CONTROLS</span>
          </div>
          <div className="controls-readout-grid">
            <div className="control-item">
              <span className="c-name">Crossfader</span>
              <span className="c-val text-cyan">{(telemetry.controls.crossfader * 100).toFixed(0)}% Deck B</span>
            </div>
            <div className="control-item">
              <span className="c-name">DJ Filter</span>
              <span className="c-val text-gold">
                {telemetry.controls.filterCutoff < 0.48 ? 'LPF (Dark)' : telemetry.controls.filterCutoff > 0.52 ? 'HPF (Bass Cut)' : 'Flat Pass'}
              </span>
            </div>
            <div className="control-item">
              <span className="c-name">Stutter FX</span>
              <span className={`c-val ${telemetry.controls.stutterTrigger ? 'text-green font-bold' : 'text-dim'}`}>
                {telemetry.controls.stutterTrigger ? 'ACTIVE (ROLL)' : 'CLEAN'}
              </span>
            </div>
          </div>
        </div>

        {/* 4-Part Dopamine Reward Breakdown */}
        <div className="metric-card">
          <div className="metric-header">
            <span>DOPAMINE R(t)</span>
            <span className={`badge ${telemetry.dopamine >= 0 ? 'badge-pam' : 'badge-ppl1'}`}>
              {telemetry.dopamine >= 0 ? `+${telemetry.dopamine.toFixed(2)}` : telemetry.dopamine.toFixed(2)}
            </span>
          </div>
          <div className="dopamine-factors-list">
            <div className="factor-row">
              <span className="f-title">Beat Transition Bonus:</span>
              <span className="f-val text-green">+{telemetry.rewardBreakdown.beatTransitionBonus.toFixed(2)}</span>
            </div>
            <div className="factor-row">
              <span className="f-title">RMS Stability Bonus:</span>
              <span className="f-val text-green">+{telemetry.rewardBreakdown.rmsStabilityBonus.toFixed(2)}</span>
            </div>
            <div className="factor-row">
              <span className="f-title">Phrase Drop Bonus:</span>
              <span className={`f-val ${telemetry.rewardBreakdown.phraseBonus >= 0 ? 'text-green' : 'text-pink'}`}>
                {telemetry.rewardBreakdown.phraseBonus >= 0 ? `+${telemetry.rewardBreakdown.phraseBonus.toFixed(2)}` : telemetry.rewardBreakdown.phraseBonus.toFixed(2)}
              </span>
            </div>
            <div className="factor-row">
              <span className="f-title">Bass-Swap Carve:</span>
              <span className={`f-val ${telemetry.rewardBreakdown.bassSwapBonus >= 0 ? 'text-green' : 'text-pink'}`}>
                {telemetry.rewardBreakdown.bassSwapBonus >= 0 ? `+${telemetry.rewardBreakdown.bassSwapBonus.toFixed(2)}` : telemetry.rewardBreakdown.bassSwapBonus.toFixed(2)}
              </span>
            </div>
            <div className="factor-row">
              <span className="f-title">Tension Buildup:</span>
              <span className={`f-val ${telemetry.rewardBreakdown.tensionBonus >= 0 ? 'text-green' : 'text-pink'}`}>
                {telemetry.rewardBreakdown.tensionBonus >= 0 ? `+${telemetry.rewardBreakdown.tensionBonus.toFixed(2)}` : telemetry.rewardBreakdown.tensionBonus.toFixed(2)}
              </span>
            </div>
            <div className="factor-row">
              <span className="f-title">Trainwreck Jump Penalty:</span>
              <span className="f-val text-pink">-{telemetry.rewardBreakdown.trainwreckPenalty.toFixed(2)}</span>
            </div>
            <div className="factor-row">
              <span className="f-title">Energy Cut Penalty:</span>
              <span className="f-val text-pink">-{telemetry.rewardBreakdown.discontinuityPenalty.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Johnston's Organ Audio Inputs */}
        <div className="freq-bands-container">
          <div className="dock-section-title" style={{ marginBottom: '4px' }}>
            <span>JOHNSTON'S ORGAN FFT</span>
          </div>
          <div className="band-row">
            <span className="band-name">JON-B (Bass)</span>
            <div className="band-meter"><div className="band-meter-fill bg-cyan" style={{ width: `${audioStats.subBass * 100}%` }} /></div>
          </div>
          <div className="band-row">
            <span className="band-name">JON-AB (Mids)</span>
            <div className="band-meter"><div className="band-meter-fill bg-green" style={{ width: `${audioStats.lowMids * 100}%` }} /></div>
          </div>
          <div className="band-row">
            <span className="band-name">JON-A1 (Melody)</span>
            <div className="band-meter"><div className="band-meter-fill bg-purple" style={{ width: `${audioStats.highMids * 100}%` }} /></div>
          </div>
          <div className="band-row">
            <span className="band-name">JON-A2 (Highs)</span>
            <div className="band-meter"><div className="band-meter-fill bg-pink" style={{ width: `${audioStats.highs * 100}%` }} /></div>
          </div>
        </div>
      </aside>

      {/* RIGHT DOCK: CONNECTOME HUD & SYNAPSE TUNING */}
      <aside className="right-dock">
        <div className="hud-toggle-bar">
          <button className="pill-btn" onClick={() => setShowHUD(!showHUD)}>
            <Eye size={14} /> {showHUD ? 'Hide Connectome HUD' : 'Show Connectome HUD'}
          </button>
        </div>

        {showHUD && (
          <div className="hud-panel glass-panel">
            <canvas ref={hudCanvasRef} width={380} height={460} className="hud-canvas" />
          </div>
        )}

        {/* Synapse Tuning & Experiment Controls */}
        <div className="tuning-panel glass-panel">
          <EvolutionPanel circuit={circuitRef} onApplyBest={handleApplyEvolvedBest} />
          <DemonstrationPanel circuit={circuitRef} sink={demonstrationSink} onApply={(result: ImitationResult) => {
            const circuit = circuitRef.current;
            if (!circuit) return;
            if (recording || recordingBusy) throw new Error('Finish WAV recording before applying a candidate.');
            applyImitation(circuit, result);
            djEngineRef.current?.stop();
            setIsPlaying(false);
            setLearningEnabled(false);
            setGuidedSet(false);
            trainingTargetRef.current = null;
            setTrainingTarget(null);
          }} />
          <div className="dock-section-title">
            <Sliders size={16} className="text-cyan" />
            <span>W_KC_DN PLASTICITY CONTROLS</span>
          </div>

          <div className="control-row">
            <label className="control-label">Learning Loop</label>
            <button 
              className={`toggle-switch ${learningEnabled ? 'active' : ''}`}
              onClick={() => setLearningEnabled(!learningEnabled)}
            >
              {learningEnabled ? <Unlock size={14} /> : <Lock size={14} />}
              {learningEnabled ? 'ACTIVE (ADAPTING)' : 'FROZEN (TEST)'}
            </button>
          </div>

          <div className="control-row-slider">
            <div className="slider-label-row">
              <span>Learning Rate (η)</span>
              <span className="slider-num">{learningRate.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0.01"
              max="0.12"
              step="0.01"
              value={learningRate}
              onChange={(e) => setLearningRate(parseFloat(e.target.value))}
              className="slider-range"
            />
          </div>

          <div className="control-row-slider">
            <div className="slider-label-row">
              <span>APL Sparsity (k KCs)</span>
              <span className="slider-num">{sparsityK} / 64 ({(sparsityK / 64 * 100).toFixed(0)}%)</span>
            </div>
            <input
              type="range"
              min="1"
              max="12"
              step="1"
              value={sparsityK}
              onChange={(e) => setSparsityK(parseInt(e.target.value))}
              className="slider-range"
            />
          </div>

          <div className="action-buttons-grid">
            <button className="reward-btn" onClick={handleManualReward}>
              <Sparkles size={16} /> Good Fly! (+PAM)
            </button>
            <button className="reset-btn" onClick={handleResetWeights} title="Reset to Naive Untrained State">
              <RotateCcw size={15} /> Reset
            </button>
          </div>

          <div className="experiments-container">
            <div className="dock-section-title" style={{ marginTop: '4px' }}>
              <span>LISTEN & TRAIN</span>
            </div>
            <div className="experiment-buttons-row">
              <button className="exp-btn exp-naive" onClick={handleResetWeights} title="Reset to Pass 1">
                Naive
              </button>
              <button className="exp-btn exp-train" onClick={() => handleRunAcceleratedPasses(5)} title="Practice on live audio for 5 passes, then freeze weights">
                Train 5 Live Passes
              </button>
              <button className="exp-btn exp-master" onClick={handleLoadExpert} title="Load handcrafted starting weights">
                ★ Preset
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* REINFORCEMENT LEARNING PROOF DASHBOARD (BOTTOM OVERLAY) */}
      {showPlots && (
        <div className="plots-panel-container">
          <LearningPlotsPanel
            telemetry={telemetry}
            onRunAcceleratedPasses={handleRunAcceleratedPasses}
            onResetWeights={handleResetWeights}
            onSaveBrain={handleSaveBrain}
            onLoadBrain={handleLoadBrain}
          />
        </div>
      )}

      {/* BOTTOM TRANSPORT BAR */}
      <footer className="bottom-bar glass-panel">
        <div className="transport-controls">
          <button 
            className={`play-master-btn ${isPlaying ? 'playing' : ''}`}
            onClick={handleTogglePlay}
            title="Start / Pause Real Audio Remix"
          >
            {isPlaying ? <Pause size={22} /> : <Play size={22} className="ml-1" />}
          </button>
          <div className="transport-track-summary">
            <span className="text-white font-bold text-sm">
              {isPlaying ? 'LIVE MIXING ACTIVE' : 'PRESS PLAY TO START CLOSED-LOOP REMIX'}
            </span>
            <span className="text-dim text-xs">
              {trackAName} ◄──► {trackBName}
            </span>
          </div>
        </div>

        {/* Quick Genre Pairings Selector */}
        <div className="genre-presets-row">
          <span className="text-dim text-xs font-mono font-bold mr-1">HOUSE FLAVORS:</span>
          <button className="genre-chip" onClick={() => handleGenrePreset('deep_tech_house')} title="125 BPM - Kerri Chandler Deep House vs Chris Lake Tech House">
            Deep / Tech House
          </button>
          <button className="genre-chip" onClick={() => handleGenrePreset('acid_house')} title="126 BPM - Phuture Chicago Acid 303 vs Armand Warehouse Rave">
            Acid 303 House
          </button>
          <button className="genre-chip" onClick={() => handleGenrePreset('french_touch')} title="124 BPM - Daft Club French Touch vs Cassius Disco House">
            French Touch
          </button>
          <button className="genre-chip" onClick={() => handleGenrePreset('melodic_afro')} title="122 BPM - Keinemusik Melodic Afro vs Black Coffee Sunset House">
            Melodic / Afro
          </button>
        </div>

        <div className="transport-right-stats">
          <div className="stat-pill">
            <span className="text-dim text-xs">PASS</span>
            <span className="font-mono text-cyan font-bold">{telemetry.currentPass}</span>
          </div>
          <div className="stat-pill">
            <span className="text-dim text-xs">PLASTIC UPDATES</span>
            <span className="font-mono text-gold font-bold">{telemetry.totalPlasticityEvents}</span>
          </div>
        </div>
      </footer>

      {/* GUIDE MODAL */}
      {showGuide && (
        <div className="modal-overlay" onClick={() => setShowGuide(false)}>
          <div className="modal-card glass-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Neuro-DJ: Closed-Loop Connectome Guide</h2>
              <button className="close-btn" onClick={() => setShowGuide(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="guide-concept">
                <h4>1. Start with the House Presets</h4>
                <p>The built-in loops share a tempo and beat grid. Guided Set holds a groove for eight bars, blends for eight, and hands the bass to the incoming deck. Uploaded tracks need matching tempo and aligned downbeats; automatic beatmatching is not implemented.</p>
              </div>
              <div className="guide-concept">
                <h4>2. The Closed Acoustic Feedback Loop</h4>
                <p>When the fly crossfades or sweeps the filter, the actual sound output changes. Johnston's Organ analyzes the newly mixed audio, completing the closed sensory-motor loop.</p>
              </div>
              <div className="guide-concept">
                <h4>3. The 4-Part Dopamine Reward</h4>
                <p>Dopamine rewards smooth crossfades that align with beat onsets and maintain stable RMS loudness. Sudden trainwreck jumps and energy dropouts trigger negative dopamine punishment.</p>
              </div>
              <div className="guide-concept">
                <h4>4. Proving Convergence</h4>
                <p>Train 5 Live Passes listens to the actual mix for about 80 seconds, then freezes learning. Reward good moments with R and discourage bad moves with X. Compare frozen playback before and after training; reward growth alone does not prove better DJing.</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;

// Module summary: The application coordinates playback, track analysis, and optional demonstration capture.
// The recorder pairs live sensory inputs with authored motor targets, and applying a candidate freezes unassisted playback for listening.
// Imported grids still do not align arbitrary tracks, and offline imitation scores cannot certify live musical quality.
