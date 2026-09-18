import { useEffect, useRef, useState, useCallback } from 'react';
import { 
  Play, Pause, RotateCcw, 
  Zap, 
  Eye, EyeOff, ThumbsUp, ThumbsDown,
  Radio, Mic, Wifi, WifiOff, Camera
} from 'lucide-react';
import confetti from 'canvas-confetti';

import { AudioFeatureExtractor } from './audio/AudioFeatureExtractor';
import { LiveInputManager, type AudioInputDevice } from './audio/LiveInputManager';
import { DjayBridgeClient } from './bridge/DjayBridgeClient';
import { FlyWireCircuit, type CircuitTelemetry } from './neural/FlyWireCircuit';
import { FlyAvatar3D } from './graphics/FlyAvatar3D';
import { CircuitHUD } from './graphics/CircuitHUD';
import './App.css';

export default function App() {
  // Canvas Refs
  const viewport3DRef = useRef<HTMLCanvasElement | null>(null);
  const hudCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Engine Instances
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioExtractorRef = useRef<AudioFeatureExtractor | null>(null);
  const circuitRef = useRef<FlyWireCircuit | null>(null);
  const avatar3DRef = useRef<FlyAvatar3D | null>(null);
  const hudVisualizerRef = useRef<CircuitHUD | null>(null);

  // Live djay / Spotify Bridge & Live Input
  const liveInputManagerRef = useRef<LiveInputManager>(new LiveInputManager());
  const djayBridgeRef = useRef<DjayBridgeClient>(new DjayBridgeClient());
  const [liveStreamActive, setLiveStreamActive] = useState<boolean>(false);
  const liveStreamActiveRef = useRef<boolean>(false);
  const [bridgeConnected, setBridgeConnected] = useState<boolean>(false);
  const bridgeConnectedRef = useRef<boolean>(false);
  const [audioDevices, setAudioDevices] = useState<AudioInputDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [cameraPreset, setCameraPreset] = useState<'front' | 'dj' | 'side'>('side');

  // UI State
  const [showHUD, setShowHUD] = useState<boolean>(true);

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
      crossfader: 0.5,
      filterCutoff: 0.5,
      stutterTrigger: false,
      rawCrossfader: 0.5,
      rawFilter: 0.5,
      rawStutter: 0.0
    },
    avgSynapticWeight: 0.20,
    totalPlasticityEvents: 0,
    currentPass: 1,
    passProgress: 0
  });

  // Audio Device Enumeration & Stream Control
  const refreshAudioDevices = useCallback(async () => {
    const devices = await liveInputManagerRef.current.getAvailableAudioDevices();
    setAudioDevices(devices);
    return devices;
  }, []);

  const startLiveAudio = useCallback(async (devId?: string) => {
    if (!audioContextRef.current || !audioExtractorRef.current) return;
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }
    try {
      const stream = await liveInputManagerRef.current.startStream(devId);
      audioExtractorRef.current.connectStream(stream);
      liveStreamActiveRef.current = true;
      setLiveStreamActive(true);
    } catch (err) {
      console.warn('Could not start live stream:', err);
      setLiveStreamActive(false);
      liveStreamActiveRef.current = false;
    }
  }, []);

  const stopLiveAudio = useCallback(() => {
    liveInputManagerRef.current.stopStream();
    liveStreamActiveRef.current = false;
    setLiveStreamActive(false);
  }, []);

  const handleSelectAudioDevice = useCallback(async (devId: string) => {
    setSelectedDeviceId(devId);
    if (liveStreamActiveRef.current) {
      await startLiveAudio(devId);
    }
  }, [startLiveAudio]);

  const handleToggleListening = useCallback(async () => {
    if (liveStreamActiveRef.current) {
      stopLiveAudio();
    } else {
      await startLiveAudio(selectedDeviceId);
    }
  }, [selectedDeviceId, startLiveAudio, stopLiveAudio]);

  // Camera preset switcher
  const handleCameraChange = (preset: 'front' | 'dj' | 'side') => {
    setCameraPreset(preset);
    avatar3DRef.current?.setCameraPreset(preset);
  };

  // Dopamine Feedback Burst ("Good Fly!" / R key)
  const handleManualReward = useCallback(() => {
    if (!circuitRef.current) return;
    circuitRef.current.injectManualDopamine(1.5);
    confetti({
      particleCount: 50,
      spread: 70,
      origin: { y: 0.8 },
      colors: ['#00ff88', '#00f0ff', '#ffb703']
    });
  }, []);

  // Dopamine Penalty ("Trainwreck!" / X key)
  const handleManualPenalty = useCallback(() => {
    if (!circuitRef.current) return;
    circuitRef.current.injectManualDopamine(-1.5);
  }, []);

  // Initialize Engines & Main Loop on Mount
  useEffect(() => {
    const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtxClass();
    audioContextRef.current = ctx;

    // 1. Audio Feature Extractor (Johnston's Organ FFT)
    const extractor = new AudioFeatureExtractor(ctx);
    audioExtractorRef.current = extractor;

    // 2. Connectome Circuit with 3-Factor Dopamine Plasticity
    const circuit = new FlyWireCircuit();
    circuitRef.current = circuit;

    // 3. 3D Club Visualizer
    if (viewport3DRef.current) {
      const avatar = new FlyAvatar3D(viewport3DRef.current);
      avatar3DRef.current = avatar;
    }

    // 4. Circuit HUD Visualizer
    if (hudCanvasRef.current) {
      const hud = new CircuitHUD(hudCanvasRef.current);
      hudVisualizerRef.current = hud;
    }

    // 5. Connect to local djay Pro bridge & audio devices
    const unsubscribeBridge = djayBridgeRef.current.onStatusChange((conn) => {
      bridgeConnectedRef.current = conn;
      setBridgeConnected(conn);
    });
    // Forward dispatched native events to the fly limb animator so hand gestures fire
    // on crossfader taps, filter sweeps and cut button presses in djay Pro.
    const unsubscribeAction = djayBridgeRef.current.onAction((action) => {
      avatar3DRef.current?.onBridgeAction(action);
    });
    djayBridgeRef.current.connect();

    // Auto-discover audio devices (prioritizing BlackHole 2ch)
    void refreshAudioDevices().then((devices) => {
      const bh = devices.find(d => d.isBlackHole);
      const initialDev = bh ? bh.deviceId : (devices[0]?.deviceId || '');
      setSelectedDeviceId(initialDev);
      // Auto-start listening if permission already granted
      void startLiveAudio(initialDev);
    });

    // Resize Handler
    const handleResize = () => {
      if (viewport3DRef.current && avatar3DRef.current) {
        avatar3DRef.current.resize(window.innerWidth, window.innerHeight);
      }
    };
    window.addEventListener('resize', handleResize);

    // 6. MAIN REAL-TIME SIMULATION & CONTROL TICK
    let animationFrameId: number;
    let lastTime = performance.now();
    let telemetryThrottle = 0;

    const renderLoop = (time: number) => {
      const elapsed = (time - lastTime) / 1000.0;
      const dt = Math.min(0.05, elapsed);
      lastTime = time;

      // (a) Read acoustic feedback from Johnston's Organ FFT
      const features = extractor.update();
      const currentRMS = (features.subBass + features.lowMids) * 0.5;
      const deltaRMS = features.spectralFlux;

      // (b) Step connectome: PNs -> KCs (APL sparse) -> Descending Neurons -> Dopamine Reward
      const sensoryInputs = [features.subBass, features.lowMids, features.highMids, features.highs];
      const isStandby = !liveStreamActiveRef.current;
      const curTelemetry = circuit.step(
        sensoryInputs,
        features.onset,
        features.isBeat,
        currentRMS,
        deltaRMS,
        dt,
        isStandby,
        undefined,
        undefined
      );

      // (c) DISPATCH NEURAL MOTOR OUTPUTS TO DJAY PRO BRIDGE
      djayBridgeRef.current.sendControl({
        crossfader: curTelemetry.controls.crossfader,
        filterCutoff: curTelemetry.controls.filterCutoff,
        stutter: curTelemetry.controls.stutterTrigger,
      });

      // (d) Animate 3D Rig & Canvas HUD
      if (avatar3DRef.current) {
        // Pass the live bridge display state so the 3D booth reflects actual djay Pro
        // values: crossfader position, filter knob angles, volume faders, and platter spin.
        avatar3DRef.current.update(
          features,
          curTelemetry,
          dt,
          djayBridgeRef.current.getDisplayState(),
        );
      }
      if (hudVisualizerRef.current) {
        hudVisualizerRef.current.render(features, circuit, curTelemetry);
      }

      // Throttle React state updates to 20fps for peak performance
      telemetryThrottle += dt;
      if (telemetryThrottle > 0.05) {
        telemetryThrottle = 0;
        setTelemetry({ ...curTelemetry });
      }

      animationFrameId = requestAnimationFrame(renderLoop);
    };

    animationFrameId = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
      unsubscribeBridge();
      unsubscribeAction();
      liveInputManagerRef.current.stopStream();
      djayBridgeRef.current.disconnect();
      if (ctx.state !== 'closed') ctx.close();
    };
  }, [refreshAudioDevices, startLiveAudio]);

  // Keyboard Shortcuts: Space = Play/Pause, R = Reward, X = Punish
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        handleToggleListening();
      } else if (e.code === 'KeyR' && !e.repeat) {
        handleManualReward();
      } else if ((e.code === 'Backspace' || e.code === 'KeyX') && !e.repeat) {
        e.preventDefault();
        handleManualPenalty();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleManualReward, handleManualPenalty, handleToggleListening]);

  return (
    <div className="neuro-dj-container">
      {/* 3D Club WebGL Viewport */}
      <canvas ref={viewport3DRef} className="viewport-canvas" />

      {/* TOP HEADER BAR */}
      <header className="top-header glass-panel">
        <div className="brand-zone">
          <div className="logo-icon-pulse">
            <Zap size={22} className="text-cyan" />
          </div>
          <div>
            <h1 className="brand-title">NEURO-DJ</h1>
            <p className="brand-sub">Connectome Fruit Fly · Live djay Pro</p>
          </div>
        </div>

        {/* Live Audio Source & Bridge Control Bar */}
        <div className="live-djay-bar">
          <div className="live-badge-chip">
            <Radio size={14} className={liveStreamActive ? "animate-pulse text-green" : "text-dim"} />
            <span>{liveStreamActive ? "LISTENING" : "IDLE"}</span>
          </div>

          {/* Audio Input Device Selector */}
          <div className="device-select-chip" title="Audio Input Device (Set djay Pro output to this device)">
            <Mic size={14} className="text-cyan" />
            <select
              value={selectedDeviceId}
              onChange={(e) => handleSelectAudioDevice(e.target.value)}
              className="device-dropdown"
            >
              {audioDevices.length === 0 && <option value="">Default Input / BlackHole</option>}
              {audioDevices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.isBlackHole ? `★ ${d.label} (Recommended)` : d.label}
                </option>
              ))}
            </select>
            <button className="refresh-devices-btn" onClick={refreshAudioDevices} title="Refresh Audio Devices">
              <RotateCcw size={12} />
            </button>
          </div>

          {/* Active Crossfader Position Meter */}
          <div className="crossfader-meter-bar" title="Live Crossfader (Deck 1 ◄──► Deck 2)">
            <span className="cf-label">DECK 1</span>
            <div className="cf-track">
              <div 
                className="cf-thumb" 
                style={{ left: `${telemetry.controls.crossfader * 100}%` }} 
              />
            </div>
            <span className="cf-label">DECK 2</span>
          </div>

          {/* Bridge Status Indicator */}
          <div className={`bridge-status-chip ${bridgeConnected ? 'connected' : 'disconnected'}`}>
            {bridgeConnected ? (
              <>
                <Wifi size={13} className="text-green" />
                <span>Bridge Active</span>
              </>
            ) : (
              <>
                <WifiOff size={13} className="text-pink" />
                <span title="Run 'npm run bridge' in terminal to control djay Pro">Bridge Offline</span>
              </>
            )}
          </div>
        </div>

        {/* Camera Views & HUD Toggle */}
        <div className="header-actions">
          <div className="camera-select-chip">
            <Camera size={14} className="text-cyan mr-1" />
            <button 
              className={`cam-btn ${cameraPreset === 'side' ? 'active' : ''}`}
              onClick={() => handleCameraChange('side')}
              title="Cinematic Orbit Angle"
            >
              Orbit
            </button>
            <button 
              className={`cam-btn ${cameraPreset === 'front' ? 'active' : ''}`}
              onClick={() => handleCameraChange('front')}
              title="Crowd Front View"
            >
              Front
            </button>
            <button 
              className={`cam-btn ${cameraPreset === 'dj' ? 'active' : ''}`}
              onClick={() => handleCameraChange('dj')}
              title="Over-the-Shoulder DJ View"
            >
              DJ
            </button>
          </div>

          <button 
            className="guide-btn"
            onClick={() => setShowHUD(!showHUD)}
            title="Toggle Neural Circuit HUD"
          >
            {showHUD ? <EyeOff size={15} /> : <Eye size={15} />} {showHUD ? 'Hide HUD' : 'Show HUD'}
          </button>
        </div>
      </header>

      {/* FLOATING NEURAL CIRCUIT HUD (CANVAS OVERLAY) */}
      <canvas 
        ref={hudCanvasRef} 
        className={`circuit-hud-canvas ${!showHUD ? 'hidden' : ''}`} 
      />

      {/* BOTTOM TRANSPORT BAR */}
      <footer className="bottom-bar glass-panel">
        <div className="transport-controls">
          <button 
            className={`play-master-btn ${liveStreamActive ? 'playing' : ''}`}
            onClick={handleToggleListening}
            title={liveStreamActive ? "Pause Audio Listening" : "Start Audio Listening (Space)"}
          >
            {liveStreamActive ? <Pause size={22} /> : <Play size={22} className="ml-1" />}
          </button>
          <div className="transport-track-summary">
            <span className="text-white font-bold text-sm">
              {liveStreamActive ? 'SPOTIFY AUDIO STREAM ACTIVE' : 'AUDIO LISTENING PAUSED'}
            </span>
            <span className="text-dim text-xs">
              {bridgeConnected 
                ? 'Fly brain moving controls in djay Pro in real-time' 
                : 'Run "npm run bridge" in terminal to enable live djay Pro key control'}
            </span>
          </div>
        </div>

        {/* Real-time Reinforcement Learning Hotkey Buttons */}
        <div className="rl-feedback-actions">
          <button 
            className="feedback-btn reward"
            onClick={handleManualReward}
            title="Reward good transition / move (R key)"
          >
            <ThumbsUp size={16} />
            <span>REWARD [R]</span>
          </button>
          <button 
            className="feedback-btn penalty"
            onClick={handleManualPenalty}
            title="Penalize bad blend / trainwreck (X key)"
          >
            <ThumbsDown size={16} />
            <span>PENALTY [X]</span>
          </button>
        </div>

        {/* Live Neural Stats */}
        <div className="transport-right-stats">
          <div className="stat-pill" title="Kenyon Cells firing sparsity">
            <span className="text-dim text-xs">KC SPARSITY</span>
            <span className="font-mono text-cyan font-bold">{telemetry.sparsityPercent.toFixed(1)}%</span>
          </div>
          <div className="stat-pill" title="Current Dopamine level">
            <span className="text-dim text-xs">DOPAMINE</span>
            <span className={`font-mono font-bold ${telemetry.dopamine > 0 ? 'text-green' : telemetry.dopamine < 0 ? 'text-pink' : 'text-dim'}`}>
              {telemetry.dopamine > 0 ? `+${telemetry.dopamine.toFixed(2)}` : telemetry.dopamine.toFixed(2)}
            </span>
          </div>
          <div className="stat-pill" title="Number of synaptic weight adaptations">
            <span className="text-dim text-xs">PLASTICITY</span>
            <span className="font-mono text-gold font-bold">{telemetry.totalPlasticityEvents}</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
