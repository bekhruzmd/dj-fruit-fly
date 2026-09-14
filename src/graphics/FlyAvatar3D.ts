import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { AudioFeatures } from '../audio/AudioFeatureExtractor';
import type { CircuitTelemetry } from '../neural/FlyWireCircuit';

// Model: "Wild Type Male Drosophila melanogaster" by mlykouretzos, CC-BY-4.0

export class FlyAvatar3D {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;

  // Fly avatar
  public flyRoot: THREE.Group;
  private wingPivots: THREE.Group[] = [];   // each wraps a detected wing mesh at its bbox center
  private dopamineLight: THREE.PointLight;
  private flyModelLoaded = false;

  // DJ Equipment
  private turntableDesk: THREE.Group;
  private leftVinyl: THREE.Mesh;
  private rightVinyl: THREE.Mesh;
  private mixerLeds: THREE.Mesh[] = [];
  private eqBars: THREE.Mesh[] = [];
  private crossfaderKnob: THREE.Mesh;
  private filterKnob: THREE.Mesh;

  // Stage & Lighting
  private stageLights: THREE.PointLight[] = [];
  private dopamineStrobe: THREE.PointLight;
  private particleSystem: THREE.Points;

  // Animation state
  private currentBob: number = 0;
  private currentPump: number = 0;
  private vinylRotL: number = 0;
  private vinylRotR: number = 0;

  // Camera orbit state
  private isMouseDown: boolean = false;
  private mousePrevX: number = 0;
  private mousePrevY: number = 0;
  private cameraAngleX: number = 0.35;
  private cameraAngleY: number = 0.5;
  private cameraDistance: number = 3.6;

  constructor(canvas: HTMLCanvasElement) {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x060811, 0.12);

    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    this.updateCameraPosition();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;

    this.flyRoot         = new THREE.Group();
    this.turntableDesk   = new THREE.Group();
    this.leftVinyl       = new THREE.Mesh();
    this.rightVinyl      = new THREE.Mesh();
    this.crossfaderKnob  = new THREE.Mesh();
    this.filterKnob      = new THREE.Mesh();
    this.dopamineStrobe  = new THREE.PointLight(0x00f0ff, 0, 8);
    this.dopamineLight   = new THREE.PointLight(0x00ff88, 0, 5);
    this.particleSystem  = new THREE.Points();

    this.setupLighting();
    this.buildDJStage();
    this.loadFlyModel();
    this.buildParticles();
    this.setupInteractivity(canvas);
  }

  // ─── Lighting ───────────────────────────────────────────────────────────────

  private setupLighting(): void {
    this.scene.add(new THREE.AmbientLight(0x141a2e, 2.0));

    const key = new THREE.DirectionalLight(0x00e5ff, 2.5);
    key.position.set(3, 5, 4);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xff0077, 2.0);
    fill.position.set(-3, 3, -2);
    this.scene.add(fill);

    const colors = [0x00f0ff, 0xff0077, 0x9d4edd];
    for (let i = 0; i < 3; i++) {
      const pl = new THREE.PointLight(colors[i], 2.5, 7);
      pl.position.set((i - 1) * 2.2, 2.8, -1.0);
      this.stageLights.push(pl);
      this.scene.add(pl);
    }

    this.dopamineStrobe.position.set(0, 3.2, 0.5);
    this.scene.add(this.dopamineStrobe);
  }

  // ─── DJ Stage ───────────────────────────────────────────────────────────────

  private buildDJStage(): void {
    // Floor
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 16, 24, 24),
      new THREE.MeshStandardMaterial({ color: 0x070a14, roughness: 0.15, metalness: 0.85 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.7;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(16, 32, 0x00f0ff, 0x1e293b);
    grid.position.y = -0.69;
    this.scene.add(grid);

    // DJ Booth desk
    this.turntableDesk = new THREE.Group();
    this.turntableDesk.position.set(0, -0.35, 0.85);

    const desk = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 0.65, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.3, metalness: 0.9 })
    );
    this.turntableDesk.add(desk);

    // Neon top edge
    const topEdge = new THREE.Mesh(
      new THREE.BoxGeometry(2.42, 0.025, 0.92),
      new THREE.MeshBasicMaterial({ color: 0x00f0ff })
    );
    topEdge.position.y = 0.32;
    this.turntableDesk.add(topEdge);

    // Neon front edge
    const frontEdge = new THREE.Mesh(
      new THREE.BoxGeometry(2.42, 0.66, 0.02),
      new THREE.MeshBasicMaterial({ color: 0x00f0ff })
    );
    frontEdge.position.set(0, 0, 0.46);
    this.turntableDesk.add(frontEdge);

    // ── Turntables ──
    const ttGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.04, 32);
    const ttMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.9, roughness: 0.2 });
    const vinylGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.02, 32);
    const vinylMat = new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.1, metalness: 0.95 });
    const labelGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.022, 16);

    const deckL = new THREE.Mesh(ttGeo, ttMat);
    deckL.position.set(-0.65, 0.35, 0);
    this.leftVinyl = new THREE.Mesh(vinylGeo, vinylMat);
    this.leftVinyl.position.y = 0.03;
    this.leftVinyl.add(new THREE.Mesh(labelGeo, new THREE.MeshBasicMaterial({ color: 0xff0077 })));
    deckL.add(this.leftVinyl);
    this.turntableDesk.add(deckL);

    const deckR = new THREE.Mesh(ttGeo, ttMat);
    deckR.position.set(0.65, 0.35, 0);
    this.rightVinyl = new THREE.Mesh(vinylGeo, vinylMat);
    this.rightVinyl.position.y = 0.03;
    this.rightVinyl.add(new THREE.Mesh(labelGeo, new THREE.MeshBasicMaterial({ color: 0x00f0ff })));
    deckR.add(this.rightVinyl);
    this.turntableDesk.add(deckR);

    // ── Mixer unit ──
    const mixer = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.06, 0.70),
      new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.5, metalness: 0.7 })
    );
    mixer.position.set(0, 0.35, 0);
    this.turntableDesk.add(mixer);

    // VU LED bars (6 stacked)
    const ledGeo = new THREE.BoxGeometry(0.025, 0.015, 0.04);
    for (let i = 0; i < 6; i++) {
      const led = new THREE.Mesh(ledGeo,
        new THREE.MeshBasicMaterial({ color: i < 4 ? 0x00ff88 : 0xff0055 })
      );
      led.position.set(-0.06 + (i % 2) * 0.12, 0.39, -0.15 + Math.floor(i / 2) * 0.09);
      this.mixerLeds.push(led);
      this.turntableDesk.add(led);
    }

    // ── EQ spectrum display: 8 vertical bars on mixer surface ──
    const nBars = 8;
    const barColors = [0x00ff88, 0x00ff88, 0x00ff88, 0x44cc44, 0xffcc00, 0xff8800, 0xff3300, 0xff0044];
    for (let i = 0; i < nBars; i++) {
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(0.030, 0.003, 0.022),
        new THREE.MeshBasicMaterial({ color: barColors[i] })
      );
      // Position: row across the mixer, back section
      bar.position.set(-0.175 + i * 0.05, 0.384, -0.22);
      this.eqBars.push(bar);
      this.turntableDesk.add(bar);
    }

    // EQ display screen frame
    const screenFrame = new THREE.Mesh(
      new THREE.BoxGeometry(0.47, 0.03, 0.005),
      new THREE.MeshBasicMaterial({ color: 0x00f0ff })
    );
    screenFrame.position.set(0, 0.378, -0.215);
    this.turntableDesk.add(screenFrame);

    // Crossfader slot + knob
    const slotMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.008, 0.02),
      new THREE.MeshBasicMaterial({ color: 0x05070d })
    );
    slotMesh.position.set(0, 0.378, 0.20);
    this.turntableDesk.add(slotMesh);

    this.crossfaderKnob = new THREE.Mesh(
      new THREE.BoxGeometry(0.038, 0.028, 0.022),
      new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.85, roughness: 0.2, emissive: 0x0284c7, emissiveIntensity: 0.5 })
    );
    this.crossfaderKnob.position.set(0, 0.388, 0.20);
    this.turntableDesk.add(this.crossfaderKnob);

    // Filter knob
    this.filterKnob = new THREE.Mesh(
      new THREE.CylinderGeometry(0.032, 0.035, 0.028, 16),
      new THREE.MeshStandardMaterial({ color: 0xa855f7, metalness: 0.85, roughness: 0.25, emissive: 0x7e22ce, emissiveIntensity: 0.4 })
    );
    this.filterKnob.position.set(0, 0.385, 0.04);
    this.turntableDesk.add(this.filterKnob);

    this.scene.add(this.turntableDesk);
  }

  // ─── glTF Fly Model ─────────────────────────────────────────────────────────

  private loadFlyModel(): void {
    const loader = new GLTFLoader();
    loader.load(
      '/models/fly/scene.gltf',
      (gltf) => {
        const model = gltf.scene;

        // Compute pre-transform bounding box (model is at origin with identity transforms)
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());

        // Scale to 0.85 world units tall
        const targetHeight = 0.85;
        const scale = targetHeight / size.y;
        model.scale.setScalar(scale);

        // Center on X/Z; bottom of model at y = 0 in flyRoot-local space
        model.position.set(
          -center.x * scale,
          -box.min.y * scale,
          -center.z * scale
        );

        // Setup materials (vertex colours are baked in)
        model.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const mat of mats) {
            if (mat instanceof THREE.MeshStandardMaterial) {
              if (child.geometry.attributes.color) mat.vertexColors = true;
              mat.roughness = Math.max(0.3, mat.roughness);
            }
          }
        });

        // Add to scene first so world matrices can be computed
        this.flyRoot.add(model);
        this.flyRoot.position.set(0, 0.02, 0.08);
        this.scene.add(this.flyRoot);
        this.flyRoot.updateWorldMatrix(true, true);

        // Detect wing meshes: thin flat sheets (one dim << other two, and large lateral span)
        // Then wrap each in a pivot Group centred at the mesh's bbox centre for proper flapping.
        const detected: THREE.Mesh[] = [];
        model.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          child.geometry.computeBoundingBox();
          const gb = child.geometry.boundingBox!;
          const gs = gb.getSize(new THREE.Vector3());
          const minDim = Math.min(gs.x, gs.y, gs.z);
          const maxDim = Math.max(gs.x, gs.y, gs.z);
          const midDim = gs.x + gs.y + gs.z - minDim - maxDim;
          // Thin (minDim < 25 % of maxDim) and laterally large (midDim > 1 model unit)
          if (minDim < maxDim * 0.25 && midDim > 1.0) detected.push(child);
        });

        for (const wingMesh of detected) {
          // World-space bounding box centre of this wing
          const wbox  = new THREE.Box3().setFromObject(wingMesh);
          const wc    = wbox.getCenter(new THREE.Vector3());
          // Express that centre in flyRoot-local space (pivot parent)
          const lc    = this.flyRoot.worldToLocal(wc.clone());

          const pivot = new THREE.Group();
          pivot.position.copy(lc);
          this.flyRoot.add(pivot);
          pivot.attach(wingMesh);   // reparents while preserving world transform
          this.wingPivots.push(pivot);
        }

        // Dopamine glow light near the head (upper portion of the fly)
        this.dopamineLight.position.set(0, targetHeight * 0.88, 0.14);
        this.flyRoot.add(this.dopamineLight);

        this.flyModelLoaded = true;
      },
      undefined,
      (err) => console.error('[FlyAvatar3D] load error:', err)
    );
  }

  // ─── Particles ──────────────────────────────────────────────────────────────

  private buildParticles(): void {
    const n = 200;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3]     = (Math.random() - 0.5) * 10;
      pos[i * 3 + 1] = Math.random() * 5 - 0.5;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 10;
      const cyan = Math.random() > 0.4;
      col[i * 3] = cyan ? 0 : 1; col[i * 3 + 1] = cyan ? 0.9 : 0; col[i * 3 + 2] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
    this.particleSystem = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.04, vertexColors: true, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending
    }));
    this.scene.add(this.particleSystem);
  }

  // ─── Interactivity ──────────────────────────────────────────────────────────

  private setupInteractivity(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('mousedown', (e) => {
      this.isMouseDown = true; this.mousePrevX = e.clientX; this.mousePrevY = e.clientY;
    });
    window.addEventListener('mouseup', () => { this.isMouseDown = false; });
    window.addEventListener('mousemove', (e) => {
      if (!this.isMouseDown) return;
      const dx = e.clientX - this.mousePrevX, dy = e.clientY - this.mousePrevY;
      this.mousePrevX = e.clientX; this.mousePrevY = e.clientY;
      this.cameraAngleX += dx * 0.006;
      this.cameraAngleY = Math.max(0.05, Math.min(1.2, this.cameraAngleY - dy * 0.006));
      this.updateCameraPosition();
    });
    canvas.addEventListener('wheel', (e) => {
      this.cameraDistance = Math.max(2.0, Math.min(6.5, this.cameraDistance + e.deltaY * 0.004));
      this.updateCameraPosition();
    });
  }

  private updateCameraPosition(): void {
    const y  = Math.sin(this.cameraAngleY) * this.cameraDistance;
    const hr = Math.cos(this.cameraAngleY) * this.cameraDistance;
    this.camera.position.set(Math.sin(this.cameraAngleX) * hr, y + 0.4, Math.cos(this.cameraAngleX) * hr + 0.5);
    this.camera.lookAt(0, 0.42, 0.35);
  }

  public resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  // ─── Main Update ────────────────────────────────────────────────────────────

  public update(audio: AudioFeatures, telemetry: CircuitTelemetry, dt: number): void {
    const c      = telemetry.controls;
    const isPAM  = telemetry.dopamine >  0.25;
    const isPPL1 = telemetry.dopamine < -0.25;
    const stutter = c.stutterTrigger;
    const time   = performance.now() * 0.001;

    // Smooth interpolation targets
    const bobTarget  = stutter ? 0.9 : Math.min(1.0, 0.15 + audio.subBass * 0.75 + (isPAM ? 0.3 : 0));
    const pumpTarget = c.crossfader;
    this.currentBob  = THREE.MathUtils.lerp(this.currentBob,  bobTarget,  dt * 18.0);
    this.currentPump = THREE.MathUtils.lerp(this.currentPump, pumpTarget, dt * 12.0);

    // ── Fly body animation (brain → body mapping) ──────────────────────────
    if (this.flyModelLoaded) {
      // Stutter = erratic micro-shake
      const shake = stutter ? (Math.random() - 0.5) * 0.06 : 0;

      // 1. Vertical hop in sync with beat (subBass → height)
      this.flyRoot.position.y = 0.02
        + this.currentBob * 0.09
        + Math.sin(time * 2.1) * 0.012
        + shake;

      // 2. Forward lean (pitch) on heavy bass / beat drop — head nods
      this.flyRoot.rotation.x = -this.currentBob * 0.28
        + (isPPL1 ? 0.12 : 0)           // droop when punished
        + (stutter ? (Math.random() - 0.5) * 0.10 : 0);

      // 3. Yaw toward active deck (crossfader → which turntable is "hot")
      this.flyRoot.rotation.y = (this.currentPump - 0.5) * 0.40;

      // 4. Roll tilt driven by filter cutoff + slow sway
      this.flyRoot.rotation.z = (c.filterCutoff - 0.5) * 0.18
        + Math.sin(time * 1.35) * 0.025
        + (stutter ? shake * 1.5 : 0);

      // 5. Wing flutter — each wing pivot rotates around its own bbox centre
      //    Left-side pivots (x < 0) rotate opposite to right-side pivots (x > 0)
      //    so both wings beat upward simultaneously.
      const wAmp = 0.06 + audio.highs * 0.20 + (stutter ? 0.25 : 0);
      const wFreq = stutter ? 55.0 : 28.0;
      const wFlap = Math.sin(time * wFreq) * wAmp;
      for (const pivot of this.wingPivots) {
        const sign = pivot.position.x < -0.02 ? 1 : -1;
        pivot.rotation.z = sign * wFlap;
      }

      // 6. Dopamine glow — PAM (reward) = green burst, PPL1 (punish) = red pulse
      if (isPAM) {
        this.dopamineLight.color.setHex(0x00ff88);
        this.dopamineLight.intensity = 4.5 + audio.subBass * 2.5;
      } else if (isPPL1) {
        this.dopamineLight.color.setHex(0xff0033);
        this.dopamineLight.intensity = 3.0;
      } else {
        this.dopamineLight.intensity = THREE.MathUtils.lerp(
          this.dopamineLight.intensity, 0.5 + audio.subBass * 1.2, dt * 9.0
        );
        this.dopamineLight.color.setHex(0x9966ff);
      }
    }

    // ── Crossfader slider & filter knob ────────────────────────────────────
    this.crossfaderKnob.position.x = -0.09 + c.crossfader * 0.18;
    this.filterKnob.rotation.y = (c.filterCutoff - 0.5) * Math.PI * 1.6;

    // ── Vinyl spin (with stutter scratching) ───────────────────────────────
    const scratchSpeed = stutter
      ? Math.sin(time * 30.0) * 12.0
      : (this.currentPump > 0.4 ? Math.sin(time * 20.0) * 8.0 : 2.5);
    this.vinylRotL += scratchSpeed * dt;
    this.vinylRotR += (stutter ? -scratchSpeed * 0.5 : 2.5) * dt;
    this.leftVinyl.rotation.y  = this.vinylRotL;
    this.rightVinyl.rotation.y = this.vinylRotR;

    // ── VU meter LEDs ──────────────────────────────────────────────────────
    for (let i = 0; i < this.mixerLeds.length; i++) {
      const t = (i + 1) / 7.0;
      (this.mixerLeds[i].material as THREE.MeshBasicMaterial).color
        .setHex(audio.subBass > t ? 0x00ff88 : 0x1e293b);
    }

    // ── EQ spectrum bars ───────────────────────────────────────────────────
    const freqBands = [
      audio.subBass,
      audio.subBass * 0.6 + audio.lowMids * 0.4,
      audio.lowMids,
      audio.lowMids * 0.5 + audio.highMids * 0.5,
      audio.highMids,
      audio.highMids * 0.55 + audio.highs * 0.45,
      audio.highs,
      audio.highs * 0.7 + audio.onset * 0.3,
    ];
    const barBase = 0.384;
    const barMaxH = 0.15;
    for (let i = 0; i < this.eqBars.length; i++) {
      const h = 0.003 + freqBands[i] * barMaxH;
      this.eqBars[i].scale.y = h / 0.003;
      this.eqBars[i].position.y = barBase + h / 2;
    }

    // ── Dopamine strobe ────────────────────────────────────────────────────
    if (isPAM) {
      this.dopamineStrobe.intensity = 4.0; this.dopamineStrobe.color.setHex(0x00ff88);
    } else if (isPPL1) {
      this.dopamineStrobe.intensity = 2.5; this.dopamineStrobe.color.setHex(0xff0044);
    } else {
      this.dopamineStrobe.intensity = THREE.MathUtils.lerp(this.dopamineStrobe.intensity, 0.0, dt * 12.0);
    }

    // ── Stage spotlights ───────────────────────────────────────────────────
    for (let i = 0; i < this.stageLights.length; i++) {
      this.stageLights[i].intensity = 1.5 + audio.subBass * 3.0;
      this.stageLights[i].position.x = (i - 1) * 2.2 + Math.sin(time + i) * 0.4;
    }

    // ── Cyber dust particles ───────────────────────────────────────────────
    const ppos = this.particleSystem.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < ppos.length; i += 3) {
      ppos[i + 1] -= dt * 0.2;
      if (ppos[i + 1] < -0.5) ppos[i + 1] = 4.5;
    }
    this.particleSystem.geometry.attributes.position.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }
}
