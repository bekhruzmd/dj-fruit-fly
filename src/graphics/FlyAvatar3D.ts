import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import type { AudioFeatures } from '../audio/AudioFeatureExtractor';
import type { CircuitTelemetry } from '../neural/FlyWireCircuit';
import { idleDisplay, type BridgeDisplayState, type BridgeAction } from '../bridge/protocol';
import { BoothActionAnimator, solveElbow, type Point } from './BoothActionAnimator';

// Model: "flybody" — anatomically-detailed Drosophila melanogaster body model
// by Google DeepMind & HHMI Janelia Research Campus (TuragaLab/flybody, Apache-2.0)

export class FlyAvatar3D {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;

  // Fly avatar
  public flyRoot: THREE.Group;
  private wingPivots: THREE.Group[] = [];
  private dopamineLight: THREE.PointLight;
  private flyModelLoaded = false;
  private flyHeadphones: THREE.Group;
  private leftLimb: THREE.Group;
  private rightLimb: THREE.Group;

  // DJ Equipment
  private turntableDesk: THREE.Group;
  private leftVinyl: THREE.Mesh;
  private rightVinyl: THREE.Mesh;
  private leftNeedleMarker: THREE.Mesh;
  private rightNeedleMarker: THREE.Mesh;
  private mixerLeds: THREE.Mesh[] = [];
  private crossfaderKnob: THREE.Mesh;
  private filterKnob: THREE.Mesh;
  private filterKnob2 = new THREE.Mesh();
  private cutButton = new THREE.Mesh();
  private animator = new BoothActionAnimator();
  private reducedMotion = false;
  private motionQuery: MediaQueryList;
  private disposed = false;
  private events = new AbortController();
  private motionChanged = (event: MediaQueryListEvent): void => { this.reducedMotion = event.matches; };
  private ch1Fader: THREE.Mesh;
  private ch2Fader: THREE.Mesh;
  private boothDisplayBars: THREE.Mesh[] = [];

  // Club Audio Stage: Subwoofers & Lighting
  private speakerCones: THREE.Mesh[] = [];
  private laserBeams: THREE.Mesh[] = [];
  private stageLights: THREE.PointLight[] = [];
  private dopamineStrobe: THREE.PointLight;
  private particleSystem: THREE.Points;
  private rewardRing: THREE.Mesh;

  // Animation state
  private currentBob: number = 0;
  private currentPump: number = 0;
  private vinylRotL: number = 0;
  private vinylRotR: number = 0;
  private rewardPulse: number = 0;

  // Spring physics for organic body inertia
  private bodySpring = {
    bobY:  { x: 0, v: 0 },
    pitch: { x: 0, v: 0 },
    yaw:   { x: 0, v: 0 },
    roll:  { x: 0, v: 0 },
  };

  // Camera state & smooth transitions
  private isMouseDown: boolean = false;
  private mousePrevX: number = 0;
  private mousePrevY: number = 0;
  private cameraAngleX: number = 0.35;
  private cameraAngleY: number = 0.45;
  private cameraDistance: number = 3.6;
  private targetAngleX: number = 0.35;
  private targetAngleY: number = 0.45;
  private targetDistance: number = 3.6;

  constructor(canvas: HTMLCanvasElement) {
    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = this.motionQuery.matches;
    this.motionQuery.addEventListener('change', this.motionChanged);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x060811, 0.10);

    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    this.updateCameraPosition();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;

    this.flyRoot         = new THREE.Group();
    this.turntableDesk   = new THREE.Group();
    this.leftVinyl       = new THREE.Mesh();
    this.rightVinyl      = new THREE.Mesh();
    this.leftNeedleMarker = new THREE.Mesh();
    this.rightNeedleMarker = new THREE.Mesh();
    this.crossfaderKnob  = new THREE.Mesh();
    this.filterKnob      = new THREE.Mesh();
    this.ch1Fader        = new THREE.Mesh();
    this.ch2Fader        = new THREE.Mesh();
    this.flyHeadphones   = new THREE.Group();
    this.leftLimb        = new THREE.Group();
    this.rightLimb       = new THREE.Group();
    this.rewardRing      = new THREE.Mesh();
    this.dopamineStrobe  = new THREE.PointLight(0x00f0ff, 0, 10);
    this.dopamineLight   = new THREE.PointLight(0x00ff88, 0, 6);
    this.particleSystem  = new THREE.Points();

    this.scene.add(this.flyRoot);
    this.setupLighting();
    this.buildDJStage();
    this.buildSoundSystem();
    this.buildOverheadTruss();
    this.buildFlyHeadphones();
    this.buildFlyLimbs();
    this.loadFlyModel();
    this.buildParticles();
    this.buildRewardAura();
    this.setupInteractivity(canvas);
  }

  // ─── Lighting ───────────────────────────────────────────────────────────────

  private setupLighting(): void {
    this.scene.add(new THREE.AmbientLight(0x0a1024, 2.2));

    const key = new THREE.DirectionalLight(0x00e5ff, 2.8);
    key.position.set(3.5, 6, 4.5);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xff0077, 2.2);
    fill.position.set(-3.5, 3.5, -2.5);
    this.scene.add(fill);

    const backRim = new THREE.DirectionalLight(0x9d4edd, 2.5);
    backRim.position.set(0, 4, -4);
    this.scene.add(backRim);

    // Dynamic colored spotlights
    const spotColors = [0x00f0ff, 0xff0077, 0x00ff88, 0xffb703];
    for (let i = 0; i < 4; i++) {
      const pl = new THREE.PointLight(spotColors[i], 2.0, 7.5);
      pl.position.set((i - 1.5) * 2.2, 3.2, 0.5);
      this.stageLights.push(pl);
      this.scene.add(pl);
    }

    this.dopamineStrobe.position.set(0, 2.5, 1.2);
    this.scene.add(this.dopamineStrobe);
  }

  // ─── DJ Stage & Equipment ───────────────────────────────────────────────────

  private buildDJStage(): void {
    // Reflective club floor
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24, 32, 32),
      new THREE.MeshStandardMaterial({ color: 0x050811, roughness: 0.1, metalness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.7;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(24, 48, 0x00f0ff, 0x111c33);
    grid.position.y = -0.69;
    this.scene.add(grid);

    // DJ Booth Desk
    this.turntableDesk = new THREE.Group();
    this.turntableDesk.position.set(0, -0.35, 0.85);

    const desk = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.68, 1.0),
      new THREE.MeshStandardMaterial({ color: 0x0d1322, roughness: 0.2, metalness: 0.95 })
    );
    this.turntableDesk.add(desk);

    // Neon trim lines
    const topEdge = new THREE.Mesh(
      new THREE.BoxGeometry(2.64, 0.03, 1.04),
      new THREE.MeshBasicMaterial({ color: 0x00f0ff })
    );
    topEdge.position.y = 0.34;
    this.turntableDesk.add(topEdge);

    // Front illuminated LED matrix facade
    const frontFacade = new THREE.Mesh(
      new THREE.BoxGeometry(2.62, 0.67, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x090d1a, metalness: 0.8, roughness: 0.3 })
    );
    frontFacade.position.set(0, 0, 0.51);
    this.turntableDesk.add(frontFacade);

    // Front facade spectrum bars
    const nDisplayBars = 16;
    for (let i = 0; i < nDisplayBars; i++) {
      const barMesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.11, 0.02, 0.015),
        new THREE.MeshBasicMaterial({ color: i < 8 ? 0x00f0ff : 0xff0077 })
      );
      barMesh.position.set(-1.0 + i * 0.133, -0.05, 0.53);
      this.boothDisplayBars.push(barMesh);
      this.turntableDesk.add(barMesh);
    }

    // ── Decks (Pioneer CDJ style with illuminated jog rings) ──
    const deckBodyGeo = new THREE.BoxGeometry(0.72, 0.08, 0.78);
    const deckBodyMat = new THREE.MeshStandardMaterial({ color: 0x161e2e, roughness: 0.3, metalness: 0.85 });

    // Deck 1 (Left)
    const deck1 = new THREE.Mesh(deckBodyGeo, deckBodyMat);
    deck1.position.set(-0.78, 0.38, 0);
    const platterRingGeo = new THREE.RingGeometry(0.28, 0.30, 32);
    const platterRingMat1 = new THREE.MeshBasicMaterial({ color: 0x00f0ff, side: THREE.DoubleSide });

    const ringMesh1 = new THREE.Mesh(platterRingGeo, platterRingMat1);
    ringMesh1.rotation.x = -Math.PI / 2;
    ringMesh1.position.y = 0.055;
    deck1.add(ringMesh1);

    this.leftVinyl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.26, 0.03, 32),
      new THREE.MeshStandardMaterial({ color: 0x05070d, metalness: 0.95, roughness: 0.15 })
    );
    this.leftVinyl.position.y = 0.05;

    // Glowing position needle marker
    this.leftNeedleMarker = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.01, 0.08),
      new THREE.MeshBasicMaterial({ color: 0x00f0ff })
    );
    this.leftNeedleMarker.position.set(0, 0.02, 0.18);
    this.leftVinyl.add(this.leftNeedleMarker);

    deck1.add(this.leftVinyl);
    this.turntableDesk.add(deck1);

    // Deck 2 (Right)
    const deck2 = new THREE.Mesh(deckBodyGeo, deckBodyMat);
    deck2.position.set(0.78, 0.38, 0);
    const platterRingMat2 = new THREE.MeshBasicMaterial({ color: 0xff0077, side: THREE.DoubleSide });

    const ringMesh2 = new THREE.Mesh(platterRingGeo, platterRingMat2);
    ringMesh2.rotation.x = -Math.PI / 2;
    ringMesh2.position.y = 0.055;
    deck2.add(ringMesh2);

    this.rightVinyl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.26, 0.03, 32),
      new THREE.MeshStandardMaterial({ color: 0x05070d, metalness: 0.95, roughness: 0.15 })
    );
    this.rightVinyl.position.y = 0.05;

    this.rightNeedleMarker = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.01, 0.08),
      new THREE.MeshBasicMaterial({ color: 0xff0077 })
    );
    this.rightNeedleMarker.position.set(0, 0.02, 0.18);
    this.rightVinyl.add(this.rightNeedleMarker);

    deck2.add(this.rightVinyl);
    this.turntableDesk.add(deck2);

    // ── Mixer Unit ──
    const mixer = new THREE.Mesh(
      new THREE.BoxGeometry(0.58, 0.09, 0.82),
      new THREE.MeshStandardMaterial({ color: 0x111624, roughness: 0.3, metalness: 0.9 })
    );
    mixer.position.set(0, 0.38, 0);
    this.turntableDesk.add(mixer);

    // Crossfader
    const cfSlot = new THREE.Mesh(
      new THREE.BoxGeometry(0.24, 0.008, 0.025),
      new THREE.MeshBasicMaterial({ color: 0x05070d })
    );
    cfSlot.position.set(0, 0.43, 0.24);
    this.turntableDesk.add(cfSlot);

    this.crossfaderKnob = new THREE.Mesh(
      new THREE.BoxGeometry(0.042, 0.032, 0.025),
      new THREE.MeshStandardMaterial({ color: 0x00f0ff, metalness: 0.9, roughness: 0.1, emissive: 0x00a8ff, emissiveIntensity: 0.6 })
    );
    this.crossfaderKnob.position.set(0, 0.44, 0.24);
    this.turntableDesk.add(this.crossfaderKnob);

    // Channel 1 and 2 Volume Faders
    const faderGeo = new THREE.BoxGeometry(0.025, 0.025, 0.035);
    const faderMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.8, roughness: 0.2 });

    this.ch1Fader = new THREE.Mesh(faderGeo, faderMat);
    this.ch1Fader.position.set(-0.10, 0.435, 0.08);
    this.turntableDesk.add(this.ch1Fader);

    this.ch2Fader = new THREE.Mesh(faderGeo, faderMat);
    this.ch2Fader.position.set(0.10, 0.435, 0.08);
    this.turntableDesk.add(this.ch2Fader);

    // Filter Knob
    this.filterKnob = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.038, 0.032, 16),
      new THREE.MeshStandardMaterial({ color: 0xa855f7, metalness: 0.85, roughness: 0.2, emissive: 0x7e22ce, emissiveIntensity: 0.5 })
    );
    this.filterKnob.position.set(-.10, 0.435, -0.06);
    this.turntableDesk.add(this.filterKnob);
    this.filterKnob2 = this.filterKnob.clone();
    this.filterKnob2.material = (this.filterKnob.material as THREE.Material).clone();
    this.filterKnob2.position.x = .10;
    this.turntableDesk.add(this.filterKnob2);
    // Visible index marks make an AX-confirmed knob turn legible from either camera.
    for (const knob of [this.filterKnob, this.filterKnob2]) {
      const mark = new THREE.Mesh(new THREE.BoxGeometry(.007, .003, .024), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      mark.position.set(0, .018, -.012); knob.add(mark);
    }
    this.cutButton = new THREE.Mesh(new THREE.BoxGeometry(.07, .02, .05),
      new THREE.MeshStandardMaterial({ color: 0xffb703, emissive: 0xffb703, emissiveIntensity: .15 }));
    this.cutButton.position.set(.19, .44, .20);
    this.turntableDesk.add(this.cutButton);

    // Dual VU LED Meters
    const vuGeo = new THREE.BoxGeometry(0.016, 0.015, 0.028);
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < 8; i++) {
        const col = i < 5 ? 0x00ff88 : i < 7 ? 0xffb703 : 0xff0055;
        const led = new THREE.Mesh(vuGeo, new THREE.MeshBasicMaterial({ color: col }));
        led.position.set(-0.035 + ch * 0.07, 0.435, -0.16 - i * 0.035);
        this.mixerLeds.push(led);
        this.turntableDesk.add(led);
      }
    }

    this.scene.add(this.turntableDesk);
  }

  // ─── Sound System Subwoofers ────────────────────────────────────────────────

  private buildSoundSystem(): void {
    const subGeo = new THREE.BoxGeometry(1.1, 1.8, 0.9);
    const subMat = new THREE.MeshStandardMaterial({ color: 0x0b101d, roughness: 0.4, metalness: 0.8 });

    const coneGeo = new THREE.CylinderGeometry(0.38, 0.15, 0.14, 24);
    const coneMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.2, metalness: 0.95 });

    const positions = [-2.8, 2.8];
    for (const x of positions) {
      const subStack = new THREE.Mesh(subGeo, subMat);
      subStack.position.set(x, 0.2, -0.6);

      // 2 Large Speaker Cones per stack
      for (let k = 0; k < 2; k++) {
        const cone = new THREE.Mesh(coneGeo, coneMat);
        cone.rotation.x = Math.PI / 2;
        cone.position.set(0, -0.4 + k * 0.8, 0.42);
        subStack.add(cone);
        this.speakerCones.push(cone);
      }

      // Neon frame around subwoofer
      const subTrim = new THREE.Mesh(
        new THREE.BoxGeometry(1.12, 1.82, 0.02),
        new THREE.MeshBasicMaterial({ color: x < 0 ? 0x00f0ff : 0xff0077, wireframe: true })
      );
      subTrim.position.z = 0.46;
      subStack.add(subTrim);

      this.scene.add(subStack);
    }
  }

  // ─── Overhead Truss & Laser Beams ───────────────────────────────────────────

  private buildOverheadTruss(): void {
    const trussMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.9, roughness: 0.3, wireframe: true });
    
    // Crossbeam
    const beam = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.25, 0.25), trussMat);
    beam.position.set(0, 3.8, 0.2);
    this.scene.add(beam);

    // Pillars
    for (const x of [-3.7, 3.7]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.25, 4.6, 0.25), trussMat);
      pillar.position.set(x, 1.6, 0.2);
      this.scene.add(pillar);
    }

    // 4 Moving Laser Light Cones
    const laserColors = [0x00f0ff, 0xff0077, 0x00ff88, 0x9d4edd];
    const coneBeamGeo = new THREE.ConeGeometry(0.45, 4.5, 16, 1, true);

    for (let i = 0; i < 4; i++) {
      const beamMat = new THREE.MeshBasicMaterial({
        color: laserColors[i],
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const laserMesh = new THREE.Mesh(coneBeamGeo, beamMat);
      laserMesh.position.set(-2.2 + i * 1.46, 3.6, 0.2);
      laserMesh.rotation.x = Math.PI;
      this.laserBeams.push(laserMesh);
      this.scene.add(laserMesh);
    }
  }

  // ─── Fly Headphones ─────────────────────────────────────────────────────────

  private buildFlyHeadphones(): void {
    this.flyHeadphones = new THREE.Group();

    // Headband Arch
    const bandGeo = new THREE.TorusGeometry(0.18, 0.016, 12, 24, Math.PI);
    const bandMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.9, roughness: 0.2 });
    const headband = new THREE.Mesh(bandGeo, bandMat);
    headband.rotation.x = Math.PI / 2;
    headband.rotation.z = -Math.PI / 2;
    this.flyHeadphones.add(headband);

    // Ear Cups (Angled over the sides of the head)
    const cupGeo = new THREE.CylinderGeometry(0.065, 0.065, 0.035, 16);
    const cupMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.9, roughness: 0.15 });
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });

    for (const sign of [-1, 1]) {
      const cup = new THREE.Mesh(cupGeo, cupMat);
      cup.rotation.z = Math.PI / 2;
      cup.position.set(sign * 0.17, 0, 0);

      const cushion = new THREE.Mesh(
        new THREE.TorusGeometry(0.06, 0.012, 10, 20),
        ringMat
      );
      cushion.position.set(0, -sign * 0.02, 0);
      cup.add(cushion);

      this.flyHeadphones.add(cup);
    }

    this.flyHeadphones.position.set(0, 0.76, 0.11);
    this.flyHeadphones.rotation.x = -0.22;
    this.flyRoot.add(this.flyHeadphones);
  }

  // ─── Fly Limb Hands for Interacting with Gear ───────────────────────────────

  private buildFlyLimbs(): void {
    const limbMat = new THREE.MeshStandardMaterial({ color: 0x221a15, roughness: .6, metalness: .2 });
    const jointMat = new THREE.MeshStandardMaterial({ color: 0x00f0ff, emissive: 0x00f0ff, emissiveIntensity: .5 });
    for (const [index, limb] of [this.leftLimb, this.rightLimb].entries()) {
      limb.position.set(index === 0 ? -.16 : .16, .45, .18);
      limb.add(new THREE.Mesh(new THREE.CylinderGeometry(.014, .012, 1, 8), limbMat));
      limb.add(new THREE.Mesh(new THREE.CylinderGeometry(.012, .009, 1, 8), limbMat));
      limb.add(new THREE.Mesh(new THREE.SphereGeometry(.018, 10, 8), jointMat));
      limb.add(new THREE.Mesh(new THREE.SphereGeometry(.024, 10, 8), jointMat));
      this.flyRoot.add(limb);
    }
  }
  // Articulated front legs replace rigid sticks with upper/lower segments and visible joints.
  // Their root anchors remain attached to the thorax. World-space targets are solved every frame
  // after body transforms, so loaded model geometry is not required for control contact.

  private poseLimb(limb: THREE.Group, worldTip: Point, side: -1 | 1): void {
    const tip = limb.worldToLocal(new THREE.Vector3(...worldTip));
    const elbow = new THREE.Vector3(...solveElbow([0, 0, 0], tip.toArray() as Point, side));
    const jointPositions = [new THREE.Vector3(), elbow, tip];
    for (let index = 0; index < 2; index++) {
      const segment = limb.children[index];
      const delta = jointPositions[index + 1].clone().sub(jointPositions[index]);
      segment.position.copy(jointPositions[index]).addScaledVector(delta, .5);
      segment.scale.y = delta.length();
      if (delta.lengthSq() > 1e-12) segment.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    }
    limb.children[2].position.copy(elbow);
    limb.children[3].position.copy(tip);
  }
  // The target is converted through the limb's complete world matrix, including flyRoot bob,
  // yaw and scale. Two cylinders connect the solved joints and the fingertip remains on the
  // physical mesh. Degenerate segments avoid invalid quaternions.

  public onBridgeAction(action: BridgeAction): void { this.animator.action(action); }
  // Native dispatch events enter the deterministic animator here. Neural intent never calls this.
  // Duplicate and failed actions are filtered again by the animator.

  public dispose(): void {
    this.disposed = true;
    this.events.abort();
    this.motionQuery.removeEventListener('change', this.motionChanged);
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
        object.geometry.dispose();
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
      }
    });
    this.renderer.dispose();
  }
  // Teardown releases GPU resources, input handlers and the media-query subscription together.
  // A disposed flag also prevents a late model load from attaching to an abandoned scene.
  // React remounts can therefore create a fresh rig without retaining old motion listeners.

  // ─── Dopamine Reward Aura ───────────────────────────────────────────────────

  private buildRewardAura(): void {
    const ringGeo = new THREE.RingGeometry(0.2, 0.26, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.rewardRing = new THREE.Mesh(ringGeo, ringMat);
    this.rewardRing.rotation.x = -Math.PI / 2;
    this.rewardRing.position.set(0, 0.04, 0.1);
    this.scene.add(this.rewardRing);
  }

  // ─── flybody OBJ Fly Model (Google DeepMind × HHMI Janelia) ─────────────────

  private loadFlyModel(): void {
    // ── Material palette keyed to flybody part name suffixes ──────────────────
    // flybody colors: amber/brown chitin body, near-black sclerite accents,
    // iridescent red compound eyes, translucent wing membrane, cyan halteres.
    const matBody     = new THREE.MeshStandardMaterial({ color: 0x7a5c2e, roughness: 0.55, metalness: 0.15 });
    const matEyeRed   = new THREE.MeshStandardMaterial({ color: 0xcc1100, roughness: 0.3,  metalness: 0.0, emissive: 0x330000, emissiveIntensity: 0.4 });
    const matEyeBlack = new THREE.MeshStandardMaterial({ color: 0x0d0905, roughness: 0.25, metalness: 0.1  });
    const matOcelli   = new THREE.MeshStandardMaterial({ color: 0x1a0000, roughness: 0.2,  metalness: 0.0, emissive: 0x220000, emissiveIntensity: 0.6 });
    const matWingBrown = new THREE.MeshStandardMaterial({ color: 0x8b6914, roughness: 0.35, metalness: 0.05 });
    const matWingMembrane = new THREE.MeshStandardMaterial({
      color: 0xddeeff, roughness: 0.1, metalness: 0.05,
      transparent: true, opacity: 0.38, side: THREE.DoubleSide,
    });
    const matHaltere  = new THREE.MeshStandardMaterial({ color: 0xc8a84b, roughness: 0.5,  metalness: 0.1  });

    const getMaterial = (filename: string): THREE.Material => {
      if (filename.includes('wing') && filename.includes('membrane')) return matWingMembrane;
      if (filename.includes('wing'))    return matWingBrown;
      if (filename.includes('haltere')) return matHaltere;
      if (filename.includes('head_red') || filename.includes('red'))   return matEyeRed;
      if (filename.includes('head_ocelli') || filename.includes('ocelli')) return matOcelli;
      if (filename.includes('_black') || filename.includes('black'))   return matEyeBlack;
      return matBody;
    };

    // ── Ordered part list: key structural parts first ─────────────────────────
    // Wing files are detected by name for pivot-based flapping animation.
    const parts: Array<{ file: string; isWing: boolean }> = [
      // Thorax (main body center)
      { file: 'thorax_body.obj',          isWing: false },
      // Head + sensory apparatus
      { file: 'head_body.obj',            isWing: false },
      { file: 'head_black.obj',           isWing: false },
      { file: 'head_red.obj',             isWing: false },
      { file: 'head_ocelli.obj',          isWing: false },
      { file: 'haustellum_body.obj',      isWing: false },
      { file: 'haustellum_black.obj',     isWing: false },
      { file: 'rostrum_body.obj',         isWing: false },
      { file: 'antenna_left_body.obj',    isWing: false },
      { file: 'antenna_right_body.obj',   isWing: false },
      { file: 'antenna_left_black.obj',   isWing: false },
      { file: 'antenna_right_black.obj',  isWing: false },
      // Wings (animated)
      { file: 'wing_left_brown.obj',      isWing: true  },
      { file: 'wing_left_membrane.obj',   isWing: true  },
      { file: 'wing_right_brown.obj',     isWing: true  },
      { file: 'wing_right_membrane.obj',  isWing: true  },
      // Halteres (gyroscope organs)
      { file: 'haltere_left_body.obj',    isWing: false },
      { file: 'haltere_right_body.obj',   isWing: false },
      // Abdomen segments
      { file: 'abdomen_1_body.obj',       isWing: false },
      { file: 'abdomen_2_body.obj',       isWing: false },
      { file: 'abdomen_3_body.obj',       isWing: false },
      { file: 'abdomen_4_body.obj',       isWing: false },
      { file: 'abdomen_5_body.obj',       isWing: false },
      // Legs — T1 (front), T2 (mid), T3 (hind): coxa→femur→tibia
      { file: 'coxa_T1_left_body.obj',    isWing: false },
      { file: 'coxa_T1_right_body.obj',   isWing: false },
      { file: 'femur_T1_left_body.obj',   isWing: false },
      { file: 'femur_T1_right_body.obj',  isWing: false },
      { file: 'tibia_T1_left_body.obj',   isWing: false },
      { file: 'tibia_T1_right_body.obj',  isWing: false },
      { file: 'coxa_T2_left_body.obj',    isWing: false },
      { file: 'coxa_T2_right_body.obj',   isWing: false },
      { file: 'femur_T2_left_body.obj',   isWing: false },
      { file: 'femur_T2_right_body.obj',  isWing: false },
      { file: 'tibia_T2_left_body.obj',   isWing: false },
      { file: 'tibia_T2_right_body.obj',  isWing: false },
      { file: 'coxa_T3_left_body.obj',    isWing: false },
      { file: 'coxa_T3_right_body.obj',   isWing: false },
      { file: 'femur_T3_left_body.obj',   isWing: false },
      { file: 'femur_T3_right_body.obj',  isWing: false },
      { file: 'tibia_T3_left_body.obj',   isWing: false },
      { file: 'tibia_T3_right_body.obj',  isWing: false },
      // Labrum (mouthparts)
      { file: 'labrum_left_lower.obj',    isWing: false },
      { file: 'labrum_right_lower.obj',   isWing: false },
    ];

    const loader = new OBJLoader();
    const modelGroup = new THREE.Group();

    // Collect loaded meshes then finalize once all are done.
    let pending = parts.length;
    const wingMeshes: THREE.Mesh[] = [];

    const finalize = () => {
      if (this.disposed) {
        modelGroup.traverse(o => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) m.dispose();
          }
        });
        return;
      }

      // Fit model to a consistent height in the scene.
      const box = new THREE.Box3().setFromObject(modelGroup);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());

      const targetHeight = 0.85;
      const scale = size.y > 0 ? targetHeight / size.y : 1.0;
      modelGroup.scale.setScalar(scale);
      modelGroup.position.set(
        -center.x * scale,
        -box.min.y * scale,
        -center.z * scale,
      );

      this.flyRoot.add(modelGroup);
      this.flyRoot.position.set(0, 0.02, 0.08);
      this.scene.add(this.flyRoot);
      this.flyRoot.updateWorldMatrix(true, true);

      // Build pivot groups for wing flapping using named wing meshes.
      for (const wingMesh of wingMeshes) {
        const wbox = new THREE.Box3().setFromObject(wingMesh);
        const wc = wbox.getCenter(new THREE.Vector3());
        const lc = this.flyRoot.worldToLocal(wc.clone());

        const pivot = new THREE.Group();
        pivot.position.copy(lc);
        this.flyRoot.add(pivot);
        pivot.attach(wingMesh);
        this.wingPivots.push(pivot);
      }

      this.dopamineLight.position.set(0, targetHeight * 0.88, 0.14);
      this.flyRoot.add(this.dopamineLight);
      this.flyModelLoaded = true;
    };

    for (const { file, isWing } of parts) {
      const mat = getMaterial(file);
      loader.load(
        `/models/flybody/${file}`,
        (obj) => {
          obj.traverse(child => {
            if (!(child instanceof THREE.Mesh)) return;
            child.material = mat;
            child.castShadow = true;
            if (isWing) wingMeshes.push(child);
          });
          modelGroup.add(obj);
          pending--;
          if (pending === 0) finalize();
        },
        undefined,
        (err) => {
          console.warn(`flybody OBJ failed to load: ${file}`, err);
          pending--;
          if (pending === 0) finalize();
        }
      );
    }
  }


  // ─── Particles ──────────────────────────────────────────────────────────────

  private buildParticles(): void {
    const n = 280;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3]     = (Math.random() - 0.5) * 12;
      pos[i * 3 + 1] = Math.random() * 5.5 - 0.5;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 12;
      const cyan = Math.random() > 0.45;
      col[i * 3] = cyan ? 0 : 1; col[i * 3 + 1] = cyan ? 0.95 : 0; col[i * 3 + 2] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
    this.particleSystem = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.045, vertexColors: true, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending
    }));
    this.scene.add(this.particleSystem);
  }

  // ─── Interactivity & Camera Presets ─────────────────────────────────────────

  private setupInteractivity(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('mousedown', (e) => {
      this.isMouseDown = true; this.mousePrevX = e.clientX; this.mousePrevY = e.clientY;
    }, { signal: this.events.signal });
    window.addEventListener('mouseup', () => { this.isMouseDown = false; }, { signal: this.events.signal });
    window.addEventListener('mousemove', (e) => {
      if (!this.isMouseDown) return;
      const dx = e.clientX - this.mousePrevX, dy = e.clientY - this.mousePrevY;
      this.mousePrevX = e.clientX; this.mousePrevY = e.clientY;
      this.targetAngleX += dx * 0.006;
      this.targetAngleY = Math.max(0.08, Math.min(1.2, this.targetAngleY - dy * 0.006));
    }, { signal: this.events.signal });
    canvas.addEventListener('wheel', (e) => {
      this.targetDistance = Math.max(1.8, Math.min(6.5, this.targetDistance + e.deltaY * 0.004));
    }, { signal: this.events.signal });
  }

  public setCameraPreset(preset: 'front' | 'dj' | 'side'): void {
    if (preset === 'front') {
      this.targetAngleX = 0.0;
      this.targetAngleY = 0.32;
      this.targetDistance = 3.2;
    } else if (preset === 'dj') {
      this.targetAngleX = Math.PI - 0.2;
      this.targetAngleY = 0.72;
      this.targetDistance = 2.4;
    } else if (preset === 'side') {
      this.targetAngleX = 0.78;
      this.targetAngleY = 0.42;
      this.targetDistance = 3.6;
    }
  }

  private updateCameraPosition(): void {
    const y  = Math.sin(this.cameraAngleY) * this.cameraDistance;
    const hr = Math.cos(this.cameraAngleY) * this.cameraDistance;
    this.camera.position.set(Math.sin(this.cameraAngleX) * hr, y + 0.42, Math.cos(this.cameraAngleX) * hr + 0.5);
    this.camera.lookAt(0, 0.42, 0.35);
  }

  private stepSpring(state: { x: number; v: number }, target: number, stiffness: number, damping: number, dt: number): number {
    let remaining = Math.max(0, Math.min(dt, .1));
    while (remaining > 0) {
      const step = Math.min(remaining, 1 / 240);
      state.v += ((target - state.x) * stiffness - state.v * damping) * step;
      state.x += state.v * step;
      remaining -= step;
    }
    return state.x;
  }
  // Existing decorative body springs now integrate in bounded substeps to survive slow frames.
  // The state and velocity remain continuous when targets reverse. Long suspended frames are
  // capped because replaying missed body bobs would not convey useful feedback.

  public resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  // ─── Main Update Loop ───────────────────────────────────────────────────────

  public update(audio: AudioFeatures, telemetry: CircuitTelemetry, dt: number, display: BridgeDisplayState = idleDisplay()): void {
    const frameDt = Number.isFinite(dt) ? Math.max(0, Math.min(.1, dt)) : 0;
    const quiet = this.reducedMotion || !display.live;
    dt = quiet ? 0 : frameDt;
    const c = { crossfader: display.crossfader.value, filterCutoff: display.filters[0].value };
    const isPAM = telemetry.dopamine > 0.25;
    const isPPL1 = telemetry.dopamine < -0.25;
    const stutter = false; // Cut feedback belongs to the dispatched button tap, not a body shake.
    const time = quiet ? 0 : performance.now() * 0.001;

    if (quiet) {
      this.cameraAngleX = this.targetAngleX; this.cameraAngleY = this.targetAngleY; this.cameraDistance = this.targetDistance;
      this.flyRoot.position.set(0, .02, .08); this.flyRoot.rotation.set(0, 0, 0); this.flyRoot.scale.setScalar(1);
      for (const pivot of this.wingPivots) pivot.rotation.z = 0;
    }
    // Smooth camera interpolation toward target angles
    this.cameraAngleX = THREE.MathUtils.lerp(this.cameraAngleX, this.targetAngleX, dt * 8.0);
    this.cameraAngleY = THREE.MathUtils.lerp(this.cameraAngleY, this.targetAngleY, dt * 8.0);
    this.cameraDistance = THREE.MathUtils.lerp(this.cameraDistance, this.targetDistance, dt * 8.0);
    this.updateCameraPosition();

    // Smooth physics targets
    const bobTarget = stutter ? 0.95 : Math.min(1.0, 0.15 + audio.subBass * 0.85 + (isPAM ? 0.35 : 0));
    const pumpTarget = c.crossfader;
    this.currentBob = THREE.MathUtils.lerp(this.currentBob, bobTarget, dt * 18.0);
    this.currentPump = THREE.MathUtils.lerp(this.currentPump, pumpTarget, dt * 12.0);

    // ── Fly Body Animation ──────────────────────────────────────────────────
    if (this.flyModelLoaded && !quiet) {
      const shake = stutter ? (Math.random() - 0.5) * 0.07 : 0;
      const idleY = Math.sin(time * 2.2) * 0.012 + Math.sin(time * 0.85 + 1.5) * 0.006;
      const idleYaw = Math.sin(time * 0.55 + 0.4) * 0.035;
      const idleRoll = Math.sin(time * 1.3) * 0.025;

      // 1. Vertical bounce synced to kick/bass
      const bobTargetY = 0.02 + this.currentBob * 0.12 + idleY + shake;
      this.flyRoot.position.y = this.stepSpring(this.bodySpring.bobY, bobTargetY, 180, 16, dt);

      // 2. Head nod / pitch
      const pitchTarget = -this.currentBob * 0.35 + (isPPL1 ? 0.14 : 0) + (stutter ? (Math.random() - 0.5) * 0.12 : 0);
      this.flyRoot.rotation.x = this.stepSpring(this.bodySpring.pitch, pitchTarget, 110, 13, dt);

      // 3. Yaw toward active deck
      const yawTarget = (this.currentPump - 0.5) * 0.45 + idleYaw;
      this.flyRoot.rotation.y = this.stepSpring(this.bodySpring.yaw, yawTarget, 65, 11, dt);

      // 4. Roll tilt on filter
      const rollTarget = (c.filterCutoff - 0.5) * 0.22 + idleRoll + (stutter ? shake * 1.6 : 0);
      this.flyRoot.rotation.z = this.stepSpring(this.bodySpring.roll, rollTarget, 95, 12, dt);

      // Thorax breathing pulse
      const breathe = 1 + Math.sin(time * 2.0) * 0.008 + this.currentBob * 0.025;
      this.flyRoot.scale.set(breathe, 1 + (breathe - 1) * 0.6, breathe);

      // 5. Wings flutter on high frequencies & stutter
      const wAmp = 0.08 + audio.highs * 0.24 + (stutter ? 0.28 : 0);
      const wFreq = stutter ? 58.0 : 28.0;
      for (let i = 0; i < this.wingPivots.length; i++) {
        const pivot = this.wingPivots[i];
        const phase = time * wFreq + i * 0.15;
        const shaped = Math.sign(Math.sin(phase)) * Math.pow(Math.abs(Math.sin(phase)), 0.55);
        const sign = pivot.position.x < -0.02 ? 1 : -1;
        pivot.rotation.z = sign * shaped * wAmp;
      }

      // Dopamine light near head
      if (isPAM) {
        this.dopamineLight.color.setHex(0x00ff88);
        this.dopamineLight.intensity = 5.0 + audio.subBass * 3.0;
      } else if (isPPL1) {
        this.dopamineLight.color.setHex(0xff0033);
        this.dopamineLight.intensity = 3.5;
      } else {
        this.dopamineLight.intensity = THREE.MathUtils.lerp(this.dopamineLight.intensity, 0.6 + audio.subBass * 1.5, dt * 9.0);
        this.dopamineLight.color.setHex(0x00f0ff);
      }
    }

    // Both HUD and booth consume the same projection, with neutral unknown placeholders.
    this.crossfaderKnob.position.x = -.095 + display.crossfader.value * .19;
    (this.crossfaderKnob.material as THREE.MeshStandardMaterial).color.setHex(
      display.crossfader.provenance === 'ax' ? 0x00f0ff : display.crossfader.provenance === 'dispatch-estimate' ? 0xffb703 : 0x475569);
    for (const [index, knob] of [this.filterKnob, this.filterKnob2].entries()) {
      knob.rotation.y = (display.filters[index].value - .5) * Math.PI * 1.6;
      (knob.material as THREE.MeshStandardMaterial).emissiveIntensity = display.filters[index].provenance === 'ax' ? .5 : 0;
    }
    this.ch1Fader.position.z = .11 - display.volumes[0].value * .06;
    this.ch2Fader.position.z = .11 - display.volumes[1].value * .06;
    // The matrices must include this frame's body bob before converting contact into local space.
    this.scene.updateMatrixWorld(true);
    const contact = (mesh: THREE.Mesh, height: number): Point => mesh.localToWorld(new THREE.Vector3(0, height, 0)).toArray() as Point;
    const rest = (side: number): Point => this.flyRoot.localToWorld(new THREE.Vector3(side * .23, .18, .38)).toArray() as Point;
    // Reset the button before deriving its contact point, avoiding cumulative press displacement.
    this.cutButton.position.y = .44; this.cutButton.updateWorldMatrix(true, false);
    const pose = this.animator.update(frameDt, display, {
      crossfader: contact(this.crossfaderKnob, .035), filter1: contact(this.filterKnob, .035),
      filter2: contact(this.filterKnob2, .035), cut: contact(this.cutButton, .026),
      leftRest: rest(-1), rightRest: rest(1),
    }, this.reducedMotion);
    this.cutButton.position.y -= pose.cut * .008;
    pose.right[1] -= pose.cut * .008;
    (this.cutButton.material as THREE.MeshStandardMaterial).emissiveIntensity = .15 + pose.cut;
    this.poseLimb(this.leftLimb, pose.left, -1);
    this.poseLimb(this.rightLimb, pose.right, 1);

    // Platters indicate confirmed transport only; no scratching or inferred playback.
    if (display.playing[0] === true) this.vinylRotL += 2.5 * dt;
    if (display.playing[1] === true) this.vinylRotR += 2.5 * dt;
    this.leftVinyl.rotation.y = this.vinylRotL;
    this.rightVinyl.rotation.y = this.vinylRotR;
    for (const [index, marker] of [this.leftNeedleMarker, this.rightNeedleMarker].entries()) {
      (marker.material as THREE.MeshBasicMaterial).color.setHex(display.playing[index] === true ? 0x00ff88 : display.playing[index] === false ? 0xffb703 : 0x475569);
    }

    // ── Subwoofer Bass Cones Pump Outward! ──────────────────────────────────
    const punch = 1 + (quiet ? 0 : audio.subBass) * 0.35 + (stutter ? 0.2 : 0);
    for (const cone of this.speakerCones) {
      cone.scale.set(punch, punch, 1 + (quiet ? 0 : audio.subBass) * 0.55);
    }

    // ── Moving Laser Light Cones ────────────────────────────────────────────
    for (let i = 0; i < this.laserBeams.length; i++) {
      const beam = this.laserBeams[i];
      beam.rotation.z = Math.sin(time * 1.8 + i * 1.2) * 0.35;
      beam.rotation.x = Math.PI + Math.cos(time * 1.4 + i) * 0.2;
      (beam.material as THREE.MeshBasicMaterial).opacity = 0.12 + audio.subBass * 0.25;
    }

    // ── Booth Front Spectrum Display Bars ───────────────────────────────────
    for (let i = 0; i < this.boothDisplayBars.length; i++) {
      const bar = this.boothDisplayBars[i];
      const energy = (i % 2 === 0 ? audio.subBass : audio.lowMids) * 0.8 + audio.onset * 0.2;
      const targetH = 0.03 + energy * 0.35;
      bar.scale.y = targetH / 0.02;
      bar.position.y = -0.05 + targetH * 0.5;
    }

    // ── VU Meters ───────────────────────────────────────────────────────────
    for (let i = 0; i < this.mixerLeds.length; i++) {
      const threshold = ((i % 8) + 1) / 9.0;
      const isActive = (i < 8 ? audio.subBass : audio.lowMids) > threshold;
      (this.mixerLeds[i].material as THREE.MeshBasicMaterial).color
        .setHex(isActive ? (i % 8 < 5 ? 0x00ff88 : 0xffb703) : 0x111c33);
    }

    // ── Dopamine Reward Halo Ring ───────────────────────────────────────────
    if (isPAM && !quiet) {
      this.rewardPulse = Math.min(1.0, this.rewardPulse + dt * 4.0);
      this.rewardRing.scale.setScalar(1 + this.rewardPulse * 2.5);
      (this.rewardRing.material as THREE.MeshBasicMaterial).opacity = (1 - this.rewardPulse) * 0.8;
      (this.rewardRing.material as THREE.MeshBasicMaterial).color.setHex(0x00ff88);
      this.dopamineStrobe.intensity = 5.0;
      this.dopamineStrobe.color.setHex(0x00ff88);
    } else if (isPPL1 && !quiet) {
      this.rewardPulse = Math.min(1.0, this.rewardPulse + dt * 4.0);
      this.rewardRing.scale.setScalar(1 + this.rewardPulse * 2.5);
      (this.rewardRing.material as THREE.MeshBasicMaterial).opacity = (1 - this.rewardPulse) * 0.8;
      (this.rewardRing.material as THREE.MeshBasicMaterial).color.setHex(0xff0055);
      this.dopamineStrobe.intensity = 3.5;
      this.dopamineStrobe.color.setHex(0xff0055);
    } else {
      this.rewardPulse = 0;
      (this.rewardRing.material as THREE.MeshBasicMaterial).opacity = 0;
      this.dopamineStrobe.intensity = THREE.MathUtils.lerp(this.dopamineStrobe.intensity, 0.0, dt * 10.0);
    }

    // ── Floating Cyber Dust Particles ───────────────────────────────────────
    const ppos = this.particleSystem.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < ppos.length; i += 3) {
      ppos[i + 1] -= dt * 0.25;
      if (ppos[i + 1] < -0.5) ppos[i + 1] = 5.2;
    }
    this.particleSystem.geometry.attributes.position.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }
  // Rendering separates acoustic stage decoration from evidence-backed equipment and gestures.
  // The booth and hands share actual mesh contacts after body transforms; no neural output
  // can fabricate fader, filter or platter activity. Unknown/stale evidence and reduced motion
  // leave essential static control states visible while action travel is idle.
}
// Module summary: The existing Three.js stage now consumes the bridge's evidence projection.
// Native state and fresh dispatch events drive equipment and articulated front limbs, while
// neural telemetry remains reward feedback only. Native/browser alignment still requires visual audit.

