import React from 'react';
import type { CircuitTelemetry } from '../neural/FlyWireCircuit';
import { TrendingUp, Zap, CheckCircle } from 'lucide-react';

interface LearningPlotsProps {
  telemetry: CircuitTelemetry;
  onRunAcceleratedPasses: (numPasses: number) => void;
  onResetWeights: () => void;
  onSaveBrain?: () => void;
  onLoadBrain?: () => void;
}

export const LearningPlotsPanel: React.FC<LearningPlotsProps> = ({
  telemetry,
  onRunAcceleratedPasses,
  onResetWeights,
  onSaveBrain,
  onLoadBrain
}) => {
  const { passHistory, rewardHistory, crossfaderTrajectory } = telemetry;

  // Compute upward trend confirmation
  const isUpwardTrend = passHistory.length >= 2 &&
    passHistory[passHistory.length - 1].cumulativeReward > passHistory[0].cumulativeReward;

  const currentCumulative = telemetry.cumulativeRewardCurrentPass;

  return (
    <div className="learning-plots-card glass-panel">
      <div className="plots-header">
        <div className="plots-title-group">
          <TrendingUp size={18} className="text-cyan" />
          <span className="plots-title">LIVE LEARNING · 16-SECOND PASSES</span>
        </div>
        <div className="trend-badge-group">
          {isUpwardTrend ? (
            <span className="badge badge-pam">
              <CheckCircle size={11} className="inline mr-1" /> REWARD TRENDING UP (+{(passHistory[passHistory.length - 1].cumulativeReward - passHistory[0].cumulativeReward).toFixed(1)})
            </span>
          ) : (
            <span className="badge badge-neutral">
              ACCUMULATING PASS DATA (PASS {telemetry.currentPass})
            </span>
          )}
        </div>
      </div>

      <div className="plots-grid">
        {/* PLOT A: Cumulative Reward per Pass */}
        <div className="plot-box">
          <div className="plot-label-row">
            <span>(A) CUMULATIVE REWARD PER PASS</span>
            <span className="text-gold font-mono">
              {passHistory.length > 0 ? `Latest: ${passHistory[passHistory.length - 1].cumulativeReward}` : `Current: ${currentCumulative}`}
            </span>
          </div>

          <div className="svg-plot-container">
            <svg viewBox="0 0 300 90" className="plot-svg">
              <line x1="20" y1="45" x2="290" y2="45" stroke="rgba(255,255,255,0.1)" strokeDasharray="3,3" />
              <text x="22" y="42" fill="#64748b" fontSize="8" fontFamily="monospace">0.0 BASELINE</text>

              {passHistory.length > 1 ? (
                <>
                  {/* Render pass bars & line */}
                  {passHistory.map((p, idx) => {
                    const x = 35 + (idx / Math.max(1, passHistory.length - 1)) * 240;
                    // Scale reward: -30 to +80
                    const y = Math.max(10, Math.min(80, 45 - (p.cumulativeReward / 60) * 35));
                    return (
                      <g key={idx}>
                        <circle cx={x} cy={y} r="3.5" fill={p.cumulativeReward >= 0 ? '#00ff88' : '#ff0055'} />
                        <text x={x - 6} y="86" fill="#94a3b8" fontSize="7.5" fontFamily="monospace">P{p.passNumber}</text>
                      </g>
                    );
                  })}
                  {/* Connect with polyline */}
                  <polyline
                    fill="none"
                    stroke="#00ff88"
                    strokeWidth="2"
                    points={passHistory.map((p, idx) => {
                      const x = 35 + (idx / Math.max(1, passHistory.length - 1)) * 240;
                      const y = Math.max(10, Math.min(80, 45 - (p.cumulativeReward / 60) * 35));
                      return `${x},${y}`;
                    }).join(' ')}
                  />
                </>
              ) : (
                <text x="75" y="52" fill="#94a3b8" fontSize="9" fontFamily="monospace">
                  Pass 1 in progress... ({Math.round(telemetry.passProgress * 100)}% complete)
                </text>
              )}
            </svg>
          </div>
          <p className="plot-caption">Reward is a heuristic. Compare frozen playback to judge improvement.</p>
        </div>

        {/* PLOT B: Real-time Reward per Tick (Dopamine R(t)) */}
        <div className="plot-box">
          <div className="plot-label-row">
            <span>(B) REWARD PER TICK (DOPAMINE R(t))</span>
            <span className={`font-mono ${telemetry.dopamine >= 0 ? 'text-green' : 'text-pink'}`}>
              {telemetry.dopamine >= 0 ? `+${telemetry.dopamine.toFixed(2)}` : telemetry.dopamine.toFixed(2)}
            </span>
          </div>

          <div className="svg-plot-container">
            <svg viewBox="0 0 300 90" className="plot-svg">
              <line x1="20" y1="45" x2="290" y2="45" stroke="rgba(255,255,255,0.15)" />
              {rewardHistory.length > 1 && (
                <polyline
                  fill="none"
                  stroke={telemetry.dopamine >= 0 ? '#00e5ff' : '#ff0055'}
                  strokeWidth="1.6"
                  points={rewardHistory.map((r, idx) => {
                    const x = 20 + (idx / (rewardHistory.length - 1)) * 270;
                    const y = Math.max(8, Math.min(82, 45 - (r / 2.0) * 35));
                    return `${x},${y}`;
                  }).join(' ')}
                />
              )}
            </svg>
          </div>
          <p className="plot-caption">Positive peaks = smooth transitions on-beat</p>
        </div>

        {/* PLOT C: Crossfader Trajectory vs Deck Alignment */}
        <div className="plot-box">
          <div className="plot-label-row">
            <span>(C) CROSSFADER TRAJECTORY OVER TIME</span>
            <span className="text-cyan font-mono">
              {(telemetry.controls.crossfader * 100).toFixed(0)}% Deck B
            </span>
          </div>

          <div className="svg-plot-container">
            <svg viewBox="0 0 300 90" className="plot-svg">
              <rect x="20" y="10" width="270" height="70" fill="rgba(0,0,0,0.2)" stroke="rgba(255,255,255,0.08)" />
              <line x1="20" y1="45" x2="290" y2="45" stroke="rgba(255,255,255,0.1)" strokeDasharray="2,2" />

              {crossfaderTrajectory.length > 1 && (
                <polyline
                  fill="none"
                  stroke="#ffb703"
                  strokeWidth="2"
                  points={crossfaderTrajectory.map((val, idx) => {
                    const x = 20 + (idx / (crossfaderTrajectory.length - 1)) * 270;
                    const y = 80 - val * 70;
                    return `${x},${y}`;
                  }).join(' ')}
                />
              )}
            </svg>
          </div>
          <p className="plot-caption">Smooth S-curves indicate non-trainwrecking transitions</p>
        </div>

        {/* PLOT D: Plastic Synaptic Weight Evolution (W_KC_DN) */}
        <div className="plot-box">
          <div className="plot-label-row">
            <span>(D) W_KC_DN AVERAGE WEIGHT OVER PASSES</span>
            <span className="text-gold font-mono">
              w_avg = {telemetry.avgSynapticWeight.toFixed(3)}
            </span>
          </div>

          <div className="svg-plot-container">
            <svg viewBox="0 0 300 90" className="plot-svg">
              <line x1="20" y1="70" x2="290" y2="70" stroke="rgba(255,255,255,0.1)" strokeDasharray="2,2" />
              <text x="22" y="68" fill="#64748b" fontSize="8" fontFamily="monospace">0.20 BASELINE</text>

              {passHistory.length > 1 ? (
                <polyline
                  fill="none"
                  stroke="#9d4edd"
                  strokeWidth="2"
                  points={passHistory.map((p, idx) => {
                    const x = 35 + (idx / Math.max(1, passHistory.length - 1)) * 240;
                    const y = Math.max(10, Math.min(80, 80 - ((p.avgWeight - 0.15) / 0.35) * 60));
                    return `${x},${y}`;
                  }).join(' ')}
                />
              ) : (
                <text x="60" y="48" fill="#94a3b8" fontSize="8.5" fontFamily="monospace">
                  Plasticity events: {telemetry.totalPlasticityEvents} updates
                </text>
              )}
            </svg>
          </div>
          <p className="plot-caption">Synaptic weights preserve learning across passes</p>
        </div>
      </div>

      {/* Proof Actions Toolbar */}
      <div className="plots-actions-bar">
        <span className="actions-hint text-dim text-xs">
          <strong>Coach Keys:</strong> [SPACE] = Play/Pause | [R] = +PAM Reward | [X / BACKSPACE] = -PPL1 Penalty
        </span>
        <div className="actions-btn-group">
          <button
            className="proof-action-btn train-btn"
            onClick={() => onRunAcceleratedPasses(5)}
            title="Listen and train for 5 live passes, then freeze learning"
          >
            <Zap size={13} className="mr-1 inline" /> Practice 5
          </button>
          <button
            className="proof-action-btn train-btn"
            style={{ borderColor: 'rgba(0, 240, 255, 0.4)', color: '#00f0ff' }}
            onClick={() => onRunAcceleratedPasses(20)}
            title="Listen and train for 20 live passes, then freeze learning"
          >
            <Zap size={13} className="mr-1 inline" /> Practice 20
          </button>
          {onSaveBrain && (
            <button
              className="proof-action-btn reset-btn-small"
              style={{ color: '#00ff88', borderColor: 'rgba(0, 255, 136, 0.3)' }}
              onClick={onSaveBrain}
              title="Save trained synaptic weights to local storage"
            >
              💾 Save Brain
            </button>
          )}
          {onLoadBrain && (
            <button
              className="proof-action-btn reset-btn-small"
              style={{ color: '#ffb703', borderColor: 'rgba(255, 183, 3, 0.3)' }}
              onClick={onLoadBrain}
              title="Load saved trained synaptic weights"
            >
              📂 Load Brain
            </button>
          )}
          <button
            className="proof-action-btn reset-btn-small"
            onClick={onResetWeights}
            title="Reset to naive state to observe reward drop back to initial baseline"
          >
            Reset Naive
          </button>
        </div>
      </div>
    </div>
  );
};
