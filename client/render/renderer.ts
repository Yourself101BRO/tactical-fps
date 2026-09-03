// Owns the WebGLRenderer, the main scene/camera and a separate viewmodel
// scene/camera composited on top of it. Desktop routes the main scene
// through an EffectComposer (AO, bloom, grade, AA); mobile renders both
// scenes directly with no composer, at a reduced internal resolution.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GradePass } from './grade-pass.ts';
import { FOV_DEFAULT, VIEWMODEL_FOV } from '../../shared/constants.ts';

export type Quality = 'desktop' | 'mobile';

/** Per-frame screen-space grade uniforms; write these each frame, Renderer reads them in render(). */
export interface GradeState {
  damage: number;
  flash: number;
}

const MAX_DPR = 2;
const MOBILE_DEFAULT_RESOLUTION_SCALE = 0.8;
const BLOOM_THRESHOLD = 1.0;
const BLOOM_STRENGTH = 0.25;
const BLOOM_RADIUS = 0.4;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly quality: Quality;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly vmScene: THREE.Scene;
  readonly vmCamera: THREE.PerspectiveCamera;
  readonly three: THREE.WebGLRenderer;
  /** Fed into the grade pass each frame (desktop) or ignored (mobile has no grade pass). */
  readonly grade: GradeState = { damage: 0, flash: 0 };
  /** Wall-clock milliseconds the last render() call took, for the auto-quality system. */
  lastFrameMs = 0;

  private composer: EffectComposer | null = null;
  private gradePass: GradePass | null = null;
  private resolutionScale: number;

  constructor(canvas: HTMLCanvasElement, quality: Quality) {
    this.canvas = canvas;
    this.quality = quality;
    this.resolutionScale = quality === 'mobile' ? MOBILE_DEFAULT_RESOLUTION_SCALE : 1;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV_DEFAULT, 1, 0.05, 400);

    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(VIEWMODEL_FOV, 1, 0.01, 5);

    this.three = new THREE.WebGLRenderer({
      canvas,
      // SMAA handles anti-aliasing on desktop; native MSAA would be redundant cost.
      antialias: quality === 'mobile',
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.three.outputColorSpace = THREE.SRGBColorSpace;
    this.three.toneMapping = THREE.ACESFilmicToneMapping;
    this.three.toneMappingExposure = 1.0;
    this.three.shadowMap.enabled = true;
    this.three.shadowMap.type = THREE.PCFSoftShadowMap;
    // We composite two scenes (main + viewmodel) per frame ourselves.
    this.three.autoClear = false;

    if (quality === 'desktop') {
      this.buildComposer();
    }

    this.resize();
  }

  private buildComposer(): void {
    const size = this.three.getSize(new THREE.Vector2());
    const width = Math.max(1, size.x);
    const height = Math.max(1, size.y);

    const composer = new EffectComposer(this.three);

    const renderPass = new RenderPass(this.scene, this.camera);
    composer.addPass(renderPass);

    const gtaoPass = new GTAOPass(this.scene, this.camera, width, height);
    gtaoPass.output = GTAOPass.OUTPUT.Default;
    composer.addPass(gtaoPass);

    const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    composer.addPass(bloomPass);

    const gradePass = new GradePass();
    composer.addPass(gradePass);

    const smaaPass = new SMAAPass();
    composer.addPass(smaaPass);

    this.composer = composer;
    this.gradePass = gradePass;
  }

  /** Scales the internal render-target resolution (CSS/display size is unaffected). */
  setResolutionScale(s: number): void {
    this.resolutionScale = Math.min(1, Math.max(0.5, s));
    this.resize();
  }

  /** Reads the canvas's CSS box + device pixel ratio and resizes every buffer to match. */
  resize(): void {
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const cssWidth = Math.max(1, canvas.clientWidth || canvas.width || 1);
    const cssHeight = Math.max(1, canvas.clientHeight || canvas.height || 1);
    const w = Math.max(1, Math.round(cssWidth * this.resolutionScale));
    const h = Math.max(1, Math.round(cssHeight * this.resolutionScale));

    this.three.setPixelRatio(dpr);
    // updateStyle=false: we manage the CSS box ourselves so the canvas stays
    // full-size on screen even while the internal drawing buffer is scaled down.
    this.three.setSize(w, h, false);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const aspect = cssWidth / cssHeight;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = aspect;
    this.vmCamera.updateProjectionMatrix();

    if (this.composer) {
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(w, h);
    }
  }

  /** Renders the main scene (composited on desktop) then the viewmodel scene on top. */
  render(): void {
    const start = performance.now();
    const timeSeconds = start / 1000;
    if (this.gradePass) this.gradePass.setUniforms(this.grade.damage, this.grade.flash, timeSeconds);

    if (this.composer) {
      this.composer.render();
    } else {
      this.three.setRenderTarget(null);
      this.three.clear(true, true, true);
      this.three.render(this.scene, this.camera);
    }

    // Viewmodel pass: same drawing buffer, cleared depth only so it always draws on top.
    this.three.setRenderTarget(null);
    this.three.clearDepth();
    this.three.render(this.vmScene, this.vmCamera);

    this.lastFrameMs = performance.now() - start;
  }

  dispose(): void {
    this.composer = null;
    this.gradePass = null;
    this.three.dispose();
  }
}
