import type { AudioFeatures } from '../audio/AudioFeatureExtractor';
import { FlyWireCircuit, type CircuitTelemetry } from '../neural/FlyWireCircuit';

export class CircuitHUD {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // Layout node positions
  private pnPositions: { x: number; y: number; label: string; sub: string }[] = [];
  private kcPositions: { x: number; y: number }[] = [];
  private dnPositions: { x: number; y: number; label: string; action: string }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.initLayout();
  }

  private initLayout(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;

    // 1. Sensory PNs (Johnston's Organ inputs on the left)
    const pnLabels = [
      { label: 'JON-B', sub: 'Sub-Bass (Kick)' },
      { label: 'JON-AB', sub: 'Low-Mids (Bass)' },
      { label: 'JON-A1', sub: 'High-Mids (Melody)' },
      { label: 'JON-A2', sub: 'Highs (Transients)' }
    ];

    const pnX = w * 0.12;
    const pStartY = h * 0.22;
    const pSpacing = h * 0.10;

    this.pnPositions = pnLabels.map((item, idx) => ({
      x: pnX,
      y: pStartY + idx * pSpacing,
      label: item.label,
      sub: item.sub
    }));

    // 2. Kenyon Cells (Mushroom Body Calyx cluster in center)
    this.kcPositions = [];
    const kcX = w * 0.48;
    const kcY = h * 0.38;
    const numKC = 64;

    for (let i = 0; i < numKC; i++) {
      const ring = Math.floor(i / 16);
      const ringIdx = i % 16;
      const radiusX = 35 + ring * 20;
      const radiusY = 48 + ring * 28;
      const angle = (ringIdx / 16) * Math.PI * 2 + (ring * 0.2);

      this.kcPositions.push({
        x: kcX + Math.cos(angle) * radiusX,
        y: kcY + Math.sin(angle) * radiusY
      });
    }

    // 3. Descending Output Neurons (DNs controlling real audio)
    const dnLabels = [
      { label: 'DN-Cross', action: 'Crossfader (A/B)' },
      { label: 'DN-Filter', action: 'DJ Filter (LP/HP)' },
      { label: 'DN-Stutter', action: 'Loop Roll FX' }
    ];
    const dnX = w * 0.85;
    const dStartY = h * 0.24;
    const dSpacing = h * 0.14;

    this.dnPositions = dnLabels.map((item, idx) => ({
      x: dnX,
      y: dStartY + idx * dSpacing,
      label: item.label,
      action: item.action
    }));
  }

  public render(
    audio: AudioFeatures,
    circuit: FlyWireCircuit,
    telemetry: CircuitTelemetry
  ): void {
    const { width, height } = this.canvas;
    const ctx = this.ctx;

    // Semi-transparent phosphor trail
    ctx.fillStyle = 'rgba(6, 10, 20, 0.50)';
    ctx.fillRect(0, 0, width, height);

    // Title / Header Banner
    ctx.fillStyle = '#00f0ff';
    ctx.font = 'bold 11px monospace';
    ctx.fillText('CLOSED-LOOP CONNECTOME: JO -> KC -> DN', 16, 20);

    const stageColor = telemetry.stage === 'master' ? '#00ff88' : telemetry.stage === 'training' ? '#ffb703' : '#94a3b8';
    ctx.fillStyle = stageColor;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(`PASS ${telemetry.currentPass} | STAGE: ${telemetry.stage.toUpperCase()} | REWARD: ${telemetry.cumulativeRewardCurrentPass >= 0 ? '+' : ''}${telemetry.cumulativeRewardCurrentPass}`, 16, 34);

    // -------------------------------------------------------------
    // Draw Synaptic Connections (KC -> Descending Neurons) with 3-Factor Plasticity
    // -------------------------------------------------------------
    const dopamine = telemetry.dopamine;
    for (let k = 0; k < circuit.numKC; k++) {
      const kcVal = circuit.r_kc[k];
      const kp = this.kcPositions[k];

      for (let d = 0; d < circuit.numDN; d++) {
        const dp = this.dnPositions[d];
        const w = circuit.W_kc_dn[k * circuit.numDN + d];

        if (kcVal > 0.05 || w > 0.40) {
          ctx.beginPath();
          ctx.moveTo(kp.x, kp.y);
          const cpX = (kp.x + dp.x) * 0.5;
          ctx.bezierCurveTo(cpX, kp.y, cpX, dp.y, dp.x, dp.y);

          if (dopamine > 0.25 && kcVal > 0.05) {
            ctx.strokeStyle = `rgba(0, 255, 136, ${Math.min(1.0, w * 1.3)})`;
            ctx.lineWidth = Math.max(1.2, w * 3.0);
          } else if (dopamine < -0.25 && kcVal > 0.05) {
            ctx.strokeStyle = `rgba(255, 0, 85, ${Math.min(1.0, w * 1.3)})`;
            ctx.lineWidth = Math.max(1.0, w * 2.6);
          } else {
            const alpha = kcVal > 0.05 ? 0.8 : Math.min(0.3, w * 0.35);
            ctx.strokeStyle = `rgba(0, 229, 255, ${alpha})`;
            ctx.lineWidth = Math.max(0.6, w * 2.0);
          }
          ctx.stroke();
        }
      }
    }

    // -------------------------------------------------------------
    // Draw Sensory Projection Neurons (Johnston's Organ)
    // -------------------------------------------------------------
    const sensoryValues = [audio.subBass, audio.lowMids, audio.highMids, audio.highs];
    for (let i = 0; i < this.pnPositions.length; i++) {
      const pn = this.pnPositions[i];
      const val = sensoryValues[i];

      ctx.beginPath();
      ctx.arc(pn.x, pn.y, 9 + val * 6, 0, Math.PI * 2);
      ctx.fillStyle = val > 0.35 ? 'rgba(0, 240, 255, 0.25)' : 'rgba(30, 41, 59, 0.2)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(pn.x, pn.y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = val > 0.35 ? '#00f0ff' : '#334155';
      ctx.shadowBlur = val > 0.35 ? 10 : 0;
      ctx.shadowColor = '#00f0ff';
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = val > 0.35 ? '#ffffff' : '#94a3b8';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(pn.label, pn.x - 45, pn.y - 3);
      ctx.fillStyle = '#64748b';
      ctx.font = '8px monospace';
      ctx.fillText(pn.sub, pn.x - 45, pn.y + 7);
    }

    // -------------------------------------------------------------
    // Draw Kenyon Cells (Mushroom Body Calyx)
    // -------------------------------------------------------------
    for (let k = 0; k < circuit.numKC; k++) {
      const pos = this.kcPositions[k];
      const val = circuit.r_kc[k];
      const isActive = val > 0.05;

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, isActive ? 4.5 : 1.8, 0, Math.PI * 2);
      if (isActive) {
        ctx.fillStyle = '#00ffcc';
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#00ffcc';
      } else {
        ctx.fillStyle = '#1e293b';
        ctx.shadowBlur = 0;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // -------------------------------------------------------------
    // Draw Descending Output Neurons & Consequential Values
    // -------------------------------------------------------------
    const c = telemetry.controls;
    const dnValues = [
      c.crossfader, // 0 to 1
      c.filterCutoff, // 0 to 1
      c.stutterTrigger ? 1.0 : 0.0
    ];

    const dnReadouts = [
      `${(c.crossfader * 100).toFixed(0)}% Deck B`,
      c.filterCutoff < 0.48 ? 'LPF (Dark)' : c.filterCutoff > 0.52 ? 'HPF (Bass Cut)' : 'Flat EQ',
      c.stutterTrigger ? 'STUTTER ROLL' : 'CLEAN'
    ];

    for (let d = 0; d < this.dnPositions.length; d++) {
      const dn = this.dnPositions[d];
      const val = dnValues[d];
      const isFired = d === 2 ? c.stutterTrigger : Math.abs(val - 0.5) > 0.15;

      ctx.beginPath();
      ctx.arc(dn.x, dn.y, 10 + val * 6, 0, Math.PI * 2);
      ctx.fillStyle = isFired ? 'rgba(255, 183, 3, 0.25)' : 'rgba(30, 41, 59, 0.2)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(dn.x, dn.y, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = isFired ? '#ffb703' : '#475569';
      ctx.shadowBlur = isFired ? 12 : 0;
      ctx.shadowColor = '#ffb703';
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = isFired ? '#ffb703' : '#cbd5e1';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(dn.label, dn.x + 16, dn.y - 3);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '8px monospace';
      ctx.fillText(dnReadouts[d], dn.x + 16, dn.y + 8);
    }

    // -------------------------------------------------------------
    // Crossfader Real-time Trajectory Waveform
    // -------------------------------------------------------------
    const plotY = height * 0.68;
    const plotH = 50;
    const plotW = width - 32;
    const plotX = 16;

    ctx.fillStyle = 'rgba(10, 15, 28, 0.6)';
    ctx.fillRect(plotX, plotY, plotW, plotH);
    ctx.strokeStyle = '#1e293b';
    ctx.strokeRect(plotX, plotY, plotW, plotH);

    // Midline (50/50 blend)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(plotX, plotY + plotH / 2);
    ctx.lineTo(plotX + plotW, plotY + plotH / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#64748b';
    ctx.font = '7.5px monospace';
    ctx.fillText('DECK B (1.0)', plotX + 4, plotY + 10);
    ctx.fillText('CROSSFADER TRAJECTORY OVER TIME', plotX + plotW / 2 - 65, plotY + 10);
    ctx.fillText('DECK A (0.0)', plotX + 4, plotY + plotH - 4);

    // Draw Crossfader curve
    const traj = telemetry.crossfaderTrajectory;
    if (traj.length > 1) {
      ctx.beginPath();
      for (let i = 0; i < traj.length; i++) {
        const px = plotX + (i / (traj.length - 1)) * plotW;
        // 0.0 is bottom, 1.0 is top
        const py = plotY + plotH - traj[i] * plotH;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = '#00f0ff';
      ctx.lineWidth = 1.8;
      ctx.shadowBlur = 6;
      ctx.shadowColor = '#00f0ff';
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // -------------------------------------------------------------
    // Bottom: Dopamine Reward & 4-Factor Breakdown
    // -------------------------------------------------------------
    const barY = height - 32;
    const barW = width - 32;
    const barX = 16;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(barX, barY, barW, 12);

    const midX = barX + barW / 2;
    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(midX, barY);
    ctx.lineTo(midX, barY + 12);
    ctx.stroke();

    const fillWidth = (dopamine / 2.0) * (barW / 2);
    if (dopamine > 0) {
      ctx.fillStyle = '#00ff88';
      ctx.shadowBlur = 8;
      ctx.shadowColor = '#00ff88';
      ctx.fillRect(midX, barY, Math.min(barW / 2, fillWidth), 12);
    } else {
      ctx.fillStyle = '#ff0055';
      ctx.shadowBlur = 8;
      ctx.shadowColor = '#ff0055';
      ctx.fillRect(midX + Math.max(-barW / 2, fillWidth), barY, -Math.max(-barW / 2, fillWidth), 12);
    }
    ctx.shadowBlur = 0;

    // Breakdown labels
    const b = telemetry.rewardBreakdown;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '8px monospace';
    ctx.fillText(`BEAT: +${b.beatTransitionBonus.toFixed(1)} | RMS: +${b.rmsStabilityBonus.toFixed(1)} | JUMP: -${b.trainwreckPenalty.toFixed(1)} | CUT: -${b.discontinuityPenalty.toFixed(1)}`, barX, barY - 4);
  }
}
