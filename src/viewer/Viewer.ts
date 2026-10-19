import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, MeshBVH, type SerializedBVH } from 'three-mesh-bvh';
import type { DimTarget, DimensionAnnotation, EvalResult, PaintSource, PartMesh, Vec3 } from '../../shared/types';
import { buildGrid, buildPlate, updatePlate } from './stage';
import { clearGroup, declutter, dimLine, fmt, label } from './overlay';
import { boxDimensions } from '../lib/dimensions';
import { linearColors, paintedGeometry, usableColors } from '../geometry/vertexColors';
import { vertexColors, type LayerColor } from '../../shared/layertone';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export type ViewName = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export interface ViewerOptions {
  showBBox: boolean;
  showAnnotations: boolean;
  showEdges: boolean;
  ortho: boolean;
  section: { enabled: boolean; axis: 'x' | 'y' | 'z'; position: number; flip: boolean };
  hiddenParts: string[];
  measure: boolean;
  /** Click on the model to place text. */
  pickText?: boolean;
  /** false = show every part in one neutral colour. */
  colors?: boolean;
  /** The design prints in one colour ("Print in one colour"): every part in this filament colour, without per-part or per-triangle colours. */
  oneColour?: string | null;
  /** The part selected in the Object tab: highlighted. */
  selectedPart?: string | null;
}

/** Repainting a coloured mesh by hand (the Object tab's Repaint): what a click or a drag on the model does. */
export interface RepaintView {
  /** The coloured mesh (PaintSource.meshes). */
  mesh: string;
  /** patch: a click picks the patch under it; brush: a left drag on the model paints. */
  mode: 'patch' | 'brush';
  /** Brush radius, mm. */
  radius: number;
  /** The brush's filament colour (#rrggbb), shown while it paints. */
  color: string;
  /** The stored mesh's triangles picked (1 each), highlighted. */
  selected: Uint8Array | null;
}

const SELECTED_GLOW = new THREE.Color('#e0a43c').multiplyScalar(0.35);

const NEUTRAL = new THREE.Color('#b9bcc2');

export interface Measurement { a: Vec3; b: Vec3 }

/** How a product-photo render is framed: the viewer's camera, a 3/4 product angle, or a flat print face-on (from above). */
export type PhotoView = 'current' | 'angle' | 'face';

/** Assembly animation step with per-part start offsets resolved. */
export interface PlaybackStep {
  label: string;
  parts: { name: string; from: Vec3; rotate?: { axis: Vec3; degrees: number; center?: Vec3 } }[];
}

const VIEW_DIRS: Record<ViewName, [number, number, number]> = {
  iso: [1, -1.15, 0.85],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, -1e-4, 1],
  bottom: [0, -1e-4, -1],
};

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private labelRenderer: CSS2DRenderer;
  private scene = new THREE.Scene();
  private persp: THREE.PerspectiveCamera;
  private orthoCam: THREE.OrthographicCamera;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private controls: OrbitControls;
  private modelGroup = new THREE.Group();
  private dimsGroup = new THREE.Group();
  private annGroup = new THREE.Group();
  private measureGroup = new THREE.Group();
  private gridGroup = new THREE.Group();
  private plateGroup = new THREE.Group();
  private issueGroup = new THREE.Group();
  private headlight = new THREE.DirectionalLight(0xffffff, 1.6);
  private lights: THREE.Light[] = [];
  private clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private meshes: THREE.Mesh[] = [];
  private result: EvalResult | null = null;
  private opts: ViewerOptions;
  private raf = 0;
  private ro: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private snapMarker: CSS2DObject;
  private pendingPoint: Vec3 | null = null;
  private pendingLine: THREE.Line | null = null;
  private measurements: Measurement[] = [];
  private downAt: { x: number; y: number } | null = null;
  private lastSize = 0;
  private clean = false;
  private playback: PlaybackStep[] | null = null;
  onHover: (p: Vec3 | null, snapped: boolean) => void = () => {};
  onMeasurementsChange: (m: Measurement[]) => void = () => {};
  /** Double-click on an editable dimension label. */
  onDimEdit: (target: DimTarget, rect: DOMRect, current: number) => void = () => {};
  onPickSurface: (hit: { part: string; point: Vec3; normal: Vec3 }) => void = () => {};
  /** Repaint, patch mode: a click on the mesh's triangle `face` (of the stored mesh). */
  onRepaintPick: (face: number) => void = () => {};
  /** Repaint, brush mode: the stored triangles one drag painted. */
  onRepaintStroke: (faces: number[]) => void = () => {};
  private repaint: RepaintView | null = null;
  private repaintGroup = new THREE.Group();
  private brushRing: THREE.Mesh;
  private stroke: { faces: Set<number>; color: THREE.Color; pending: PointerEvent | null } | null = null;
  /** Each painted part's triangle centres and normals, for the brush (by part, while its result is shown). */
  private triCache = new WeakMap<PartMesh, { centres: Float32Array; normals: Float32Array }>();

  constructor(private container: HTMLElement, opts: ViewerOptions) {
    this.opts = opts;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);

    this.persp = new THREE.PerspectiveCamera(35, 1, 0.1, 20000);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);
    this.camera = this.persp;
    this.persp.position.set(150, -170, 130);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.zoomToCursor = true;

    const hemi = new THREE.HemisphereLight(0xdfe6f0, 0x3a3530, 1.1);
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(-1, -0.6, 2);
    this.lights = [hemi, key, this.headlight];
    this.scene.add(hemi, key);
    this.scene.add(this.headlight);
    this.scene.add(this.headlight.target);
    this.scene.add(this.gridGroup, this.plateGroup, this.issueGroup, this.modelGroup, this.dimsGroup, this.annGroup, this.measureGroup, this.repaintGroup);
    // The brush's outline on the surface under the pointer: a unit ring, scaled to the radius.
    this.brushRing = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }));
    this.brushRing.renderOrder = 10;
    this.brushRing.visible = false;
    this.brushRing.raycast = () => {};
    this.scene.add(this.brushRing);

    const marker = document.createElement('div');
    marker.className = 'snap-marker';
    this.snapMarker = new CSS2DObject(marker);
    this.snapMarker.visible = false;
    this.scene.add(this.snapMarker);

    this.buildGrid(200);
    this.buildPlate();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerdown', this.onPointerDown);
    // Before OrbitControls' own listener: a brush stroke on the model turns the orbit off first.
    el.addEventListener('pointerdown', this.onBrushDown, { capture: true });
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', () => this.endStroke(true));
    el.addEventListener('pointerleave', () => { this.snapMarker.visible = false; this.brushRing.visible = false; this.onHover(null, false); });
    window.addEventListener('keydown', this.onKey);
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener('keydown', this.onKey);
    this.clearModel();
    this.controls.dispose();
    this.renderer.dispose();
    this.container.innerHTML = '';
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.controls.update();
    // A picked patch pulses: a steady tint would read as one more colour of the figure.
    const pulse = 0.45 + 0.25 * Math.sin(performance.now() / 220);
    for (const o of this.repaintGroup.children) ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = pulse;
    this.headlight.position.copy(this.camera.position);
    this.headlight.target.position.copy(this.controls.target);
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    declutter(this.labelRenderer.domElement);
  };

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum();
  }

  private updateOrthoFrustum() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const dist = this.persp.position.distanceTo(this.controls.target);
    const halfH = dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    const halfW = halfH * (w / Math.max(1, h));
    Object.assign(this.orthoCam, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    this.orthoCam.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- model

  private clearModel() {
    for (const obj of [...this.modelGroup.children]) {
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) { m.geometry.disposeBoundsTree?.(); m.geometry.dispose(); }
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
      });
      this.modelGroup.remove(obj);
    }
    this.meshes = [];
  }

  setModel(result: EvalResult | null, fit = false) {
    this.clearModel();
    this.result = result;
    if (result) {
      result.parts.forEach((part, index) => {
        // Live previews arrive ready to draw (src/geometry/worker.ts); anything else is prepared here.
        let geom: THREE.BufferGeometry;
        let edgeGeom: THREE.BufferGeometry;
        if (part.display) {
          geom = new THREE.BufferGeometry();
          geom.setAttribute('position', new THREE.BufferAttribute(part.display.positions, 3));
          geom.setAttribute('normal', new THREE.BufferAttribute(part.display.normals, 3));
          if (part.display.colors) geom.setAttribute('color', new THREE.BufferAttribute(part.display.colors, 3));
          geom.boundsTree = MeshBVH.deserialize(part.display.bvh as SerializedBVH, geom, { setIndex: true });
          edgeGeom = new THREE.BufferGeometry();
          edgeGeom.setAttribute('position', new THREE.BufferAttribute(part.display.edges, 3));
        } else {
          let g = paintedGeometry(part);
          if (!g) {
            g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
            const colors = usableColors(part.vertexColors, part.positions);
            if (colors) g.setAttribute('color', new THREE.BufferAttribute(linearColors(colors), 3));
            g.setIndex(new THREE.BufferAttribute(part.indices, 1));
          }
          geom = toCreasedNormals(g, THREE.MathUtils.degToRad(32));
          g.dispose();
          geom.computeBoundsTree();
          edgeGeom = new THREE.EdgesGeometry(geom, 30);
        }
        // A part coloured per vertex (LayerTone) shows those colours (times white) instead of its own,
        // and so does one coloured per triangle (a coloured mesh, `painted`: plain PLA, lit as usual).
        const perVertex = !!geom.getAttribute('color');
        const painted = perVertex && !!part.paint;
        // No feature lines on a relief: every layer step would draw one.
        if (perVertex && !painted) { edgeGeom.dispose(); edgeGeom = new THREE.BufferGeometry(); }
        const color = perVertex ? new THREE.Color(0xffffff) : new THREE.Color(part.color);
        const front = new THREE.MeshStandardMaterial({
          color, roughness: 0.55, metalness: 0.05, side: THREE.FrontSide, vertexColors: perVertex,
          polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        });
        // Per-vertex colours are what the print will look like: mostly shown as they are (emissive),
        // with a little lighting so the relief still reads. A lithophane is lit from behind, so it
        // glows almost entirely by its own colours.
        if (perVertex && !painted) {
          const glow = part.lithophane ? '0.95' : '0.7';
          color.setScalar(part.lithophane ? 0.12 : 0.35);
          // Matte: a glossy highlight would turn the black areas grey.
          front.roughness = 1;
          front.metalness = 0;
          front.envMapIntensity = 0;
          front.onBeforeCompile = (s) => {
            s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n#ifdef USE_COLOR\n\ttotalEmissiveRadiance += vColor.rgb * ${glow};\n#endif`);
          };
          // The shader differs by the glow, so each needs its own compiled program.
          front.customProgramCacheKey = () => glow;
        }
        const back = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(0.45), side: THREE.BackSide, vertexColors: perVertex });
        const group = new THREE.Group();
        group.name = part.name;
        const mesh = new THREE.Mesh(geom, front);
        mesh.userData.part = part.name;
        mesh.userData.color = color;
        mesh.userData.perVertex = perVertex;
        mesh.userData.painted = painted;
        mesh.userData.index = index;
        const backMesh = new THREE.Mesh(geom, back);
        backMesh.raycast = () => {};
        const edges = new THREE.LineSegments(
          edgeGeom,
          new THREE.LineBasicMaterial({ color: 0x15171b, transparent: true, opacity: 0.55 }),
        );
        edges.name = 'edges';
        edges.raycast = () => {};
        group.add(mesh, backMesh, edges);
        this.modelGroup.add(group);
        this.meshes.push(mesh);
      });
    }
    this.applyOptions();
    this.rebuildDims();
    this.updatePlate();
    this.drawRepaintSelection();
    const size = this.modelSize();
    if (Math.abs(size - this.lastSize) / Math.max(1, size) > 0.5) this.buildGrid(size);
    this.lastSize = size;
    if (fit) this.home();
  }

  private modelBox(): THREE.Box3 | null {
    const b = this.result?.bbox;
    if (!b) return null;
    return new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
  }

  private modelSize() {
    const b = this.modelBox();
    if (!b) return 100;
    const s = b.getSize(new THREE.Vector3());
    return Math.max(s.x, s.y, s.z, 1);
  }

  // ---------------------------------------------------------------- options

  /**
   * Shows a LayerTone part with other filaments right away (new colours and TDs on the layers it
   * was built with) while the exact rebuild runs; null puts back the colours it was built with.
   */
  recolor(partName: string | null, layers: LayerColor[] | null) {
    for (const group of this.modelGroup.children) {
      const mesh = group.children[0] as THREE.Mesh | undefined;
      const attr = mesh?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!mesh || !attr) continue;
      const built = mesh.userData.builtColors as Float32Array | undefined;
      if (layers && group.name === partName) {
        if (!built) mesh.userData.builtColors = (attr.array as Float32Array).slice();
        const pos = mesh.geometry.getAttribute('position').array as Float32Array;
        attr.copyArray(linearColors(vertexColors(pos, layers)));
      } else if (built) {
        attr.copyArray(built);
        delete mesh.userData.builtColors;
      } else continue;
      attr.needsUpdate = true;
    }
  }

  setOptions(opts: ViewerOptions) {
    const orthoChanged = opts.ortho !== this.opts.ortho;
    const measureChanged = opts.measure !== this.opts.measure;
    this.opts = opts;
    if (orthoChanged) this.switchCamera(opts.ortho);
    if (measureChanged && !opts.measure) this.cancelPending();
    this.applyOptions();
    this.rebuildDims();
  }

  private applyOptions() {
    const { section, hiddenParts, showEdges } = this.opts;
    const axis = { x: 0, y: 1, z: 2 }[section.axis];
    const n = new THREE.Vector3(0, 0, 0);
    n.setComponent(axis, section.flip ? 1 : -1);
    this.clipPlane.normal.copy(n);
    this.clipPlane.constant = section.flip ? -section.position : section.position;
    const planes = section.enabled ? [this.clipPlane] : [];
    const colors = this.opts.colors !== false;
    const single = this.opts.oneColour ? new THREE.Color(this.opts.oneColour) : null;
    for (const group of this.modelGroup.children) {
      group.visible = !hiddenParts.includes(group.name);
      // Part colours (or the one filament of a print in one colour), or one neutral colour to judge the bare shape.
      const [front, back] = group.children as THREE.Mesh[];
      const base = single ?? (front.userData.color as THREE.Color | undefined) ?? NEUTRAL;
      if (front.userData.perVertex) {
        (front.material as THREE.MeshStandardMaterial).vertexColors = colors && !single;
        (back.material as THREE.MeshBasicMaterial).vertexColors = colors && !single;
      }
      (front.material as THREE.MeshStandardMaterial).color.copy(colors ? base : NEUTRAL);
      (front.material as THREE.MeshStandardMaterial).emissive.copy(group.name === this.opts.selectedPart ? SELECTED_GLOW : new THREE.Color(0));
      (back.material as THREE.MeshBasicMaterial).color.copy(colors ? base : NEUTRAL).multiplyScalar(0.45);
      group.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (mat) { mat.clippingPlanes = planes; mat.needsUpdate = true; }
        if (o.name === 'edges') o.visible = showEdges;
      });
    }
    // Dimension overlays would be wrong while parts are moving, so hide them during playback.
    this.dimsGroup.visible = this.opts.showBBox && !this.clean && !this.playback;
    this.annGroup.visible = this.opts.showAnnotations && !this.clean && !this.playback;
    this.measureGroup.visible = !this.clean && !this.playback;
    this.issueGroup.visible = !this.playback;
    this.labelRenderer.domElement.style.display = this.clean ? 'none' : '';
    this.renderer.domElement.style.cursor = this.opts.measure || this.opts.pickText || this.repaint ? 'crosshair' : '';
  }

  private switchCamera(ortho: boolean) {
    const target = this.controls.target.clone();
    if (ortho) {
      this.orthoCam.position.copy(this.persp.position);
      this.orthoCam.up.copy(this.persp.up);
      this.orthoCam.zoom = 1;
      this.updateOrthoFrustum();
      this.camera = this.orthoCam;
    } else {
      // keep the apparent scale
      const dir = this.orthoCam.position.clone().sub(target).normalize();
      const dist = this.persp.position.distanceTo(target) / this.orthoCam.zoom;
      this.persp.position.copy(target).addScaledVector(dir, dist);
      this.persp.up.copy(this.orthoCam.up);
      this.camera = this.persp;
    }
    this.controls.object = this.camera;
    this.controls.target.copy(target);
    this.controls.update();
  }

  // ---------------------------------------------------------------- camera

  fit() {
    const sphere = this.framingSphere();
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(...VIEW_DIRS.iso).normalize();
    this.placeCamera(sphere, dir);
  }

  setView(name: ViewName) {
    this.placeCamera(this.framingSphere(), new THREE.Vector3(...VIEW_DIRS[name]).normalize());
  }

  /** Paint validation results on the model: overhang triangles red, thin-wall spots orange. */
  setValidationOverlay(overlay: { overhang: Float32Array; thin: Float32Array } | null) {
    for (const o of [...this.issueGroup.children]) {
      const m = o as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      this.issueGroup.remove(o);
    }
    if (!overlay) return;
    if (overlay.overhang.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(overlay.overhang, 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color: 0xff3b30, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }));
      mesh.raycast = () => {};
      mesh.renderOrder = 5;
      this.issueGroup.add(mesh);
    }
    if (overlay.thin.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(overlay.thin, 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffa21f, size: 7, sizeAttenuation: false, depthTest: false, transparent: true }));
      pts.raycast = () => {};
      pts.renderOrder = 6;
      this.issueGroup.add(pts);
    }
  }

  /** Start (steps) or stop (null) the assembly animation. Call after setModel with the assembled layout. */
  setAssembly(steps: PlaybackStep[] | null) {
    this.playback = steps && steps.length ? steps : null;
    if (!this.playback) {
      for (const g of this.modelGroup.children) {
        g.matrixAutoUpdate = true;
        g.position.set(0, 0, 0);
        g.quaternion.identity();
        g.updateMatrix();
        this.setPartLook(g, 1, false);
      }
    }
    this.applyOptions();
    if (this.playback) {
      this.setAssemblyTime(0);
      this.frameAssembly();
    }
  }

  /** t in [0, steps]: step i moves during [i, i + 0.8] and holds briefly. */
  setAssemblyTime(t: number) {
    const steps = this.playback;
    if (!steps) return;
    const ease = (x: number) => x * x * (3 - 2 * x);
    const m = new THREE.Matrix4(), tmp = new THREE.Matrix4();
    for (const g of this.modelGroup.children) {
      const i = steps.findIndex((s) => s.parts.some((p) => p.name === g.name));
      g.matrixAutoUpdate = false;
      if (i < 0) { g.matrix.identity(); this.setPartLook(g, 1, false); continue; } // base part
      const spec = steps[i].parts.find((p) => p.name === g.name)!;
      const p = ease(Math.min(1, Math.max(0, (t - i) / 0.8)));
      const left = 1 - p;
      m.makeTranslation(spec.from[0] * left, spec.from[1] * left, spec.from[2] * left);
      if (spec.rotate && spec.rotate.degrees) {
        const c = spec.rotate.center ? new THREE.Vector3(...spec.rotate.center) : this.partCenter(g.name);
        const axis = new THREE.Vector3(...spec.rotate.axis).normalize();
        tmp.makeTranslation(c.x, c.y, c.z)
          .multiply(new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(spec.rotate.degrees) * left))
          .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
        m.multiply(tmp);
      }
      g.matrix.copy(m);
      // Waiting parts are faded; the part that is moving right now is slightly highlighted.
      this.setPartLook(g, t < i ? 0.35 : 1, t >= i && t < i + 1);
    }
  }

  private partCenter(name: string): THREE.Vector3 {
    const part = this.result?.parts.find((p) => p.name === name);
    if (!part) return new THREE.Vector3();
    return new THREE.Vector3(...part.bbox.min).add(new THREE.Vector3(...part.bbox.max)).multiplyScalar(0.5);
  }

  private setPartLook(g: THREE.Object3D, opacity: number, active: boolean) {
    g.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (!mat) return;
      const base = o.name === 'edges' ? 0.55 : 1;
      mat.transparent = opacity < 1 || o.name === 'edges';
      mat.opacity = base * opacity;
      mat.depthWrite = opacity >= 1;
      if (mat instanceof THREE.MeshStandardMaterial) mat.emissive.setScalar(active ? 0.12 : 0);
    });
  }

  /** Frame the model including every part's start position. */
  private frameAssembly() {
    const box = this.modelBox();
    if (!box || !this.playback) return;
    const all = box.clone();
    for (const s of this.playback) for (const p of s.parts) {
      const part = this.result?.parts.find((x) => x.name === p.name);
      if (!part) continue;
      const pb = new THREE.Box3(new THREE.Vector3(...part.bbox.min), new THREE.Vector3(...part.bbox.max));
      all.union(pb.translate(new THREE.Vector3(...p.from)));
    }
    // Extra margin, and aim a little low so the player bar does not cover the model.
    const sphere = all.getBoundingSphere(new THREE.Sphere());
    sphere.radius *= 1.3;
    sphere.center.z -= sphere.radius * 0.12;
    this.placeCamera(sphere, new THREE.Vector3(...VIEW_DIRS.iso).normalize());
  }

  /** Clean view (fullscreen, controls hidden): only the model, grid and plate. */
  setClean(on: boolean) {
    this.clean = on;
    this.applyOptions();
  }

  /** Standard home view: same iso angle every time, framing the model and its dimension lines. */
  home() {
    if (this.opts.ortho) this.orthoCam.up.set(0, 0, 1);
    this.persp.up.set(0, 0, 1);
    this.setView('iso');
  }

  private framingSphere(): THREE.Sphere {
    const box = this.modelBox() ?? new THREE.Box3(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 50));
    // Grow by the dimension-line offset so the overall X/Y/Z callouts stay in view.
    if (this.opts.showBBox && this.result) box.expandByScalar(this.modelSize() * 0.14);
    return box.getBoundingSphere(new THREE.Sphere());
  }

  private placeCamera(sphere: THREE.Sphere, dir: THREE.Vector3) {
    // Flush leftover orbit/pan momentum so the new view is exact.
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
    const r = Math.max(sphere.radius, 1);
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2))) * 0.95;
    this.controls.target.copy(sphere.center);
    this.persp.position.copy(sphere.center).addScaledVector(dir, dist);
    this.persp.near = dist / 200;
    this.persp.far = dist * 50;
    this.persp.updateProjectionMatrix();
    this.orthoCam.position.copy(this.persp.position);
    this.orthoCam.zoom = 1;
    this.updateOrthoFrustum();
    this.controls.update();
  }

  // ---------------------------------------------------------------- grid

  private buildGrid(size: number) { this.gridGroup.userData.step = buildGrid(this.gridGroup, size); }
  private buildPlate() { buildPlate(this.plateGroup); }
  private updatePlate() { updatePlate(this.plateGroup, this.result?.bbox); }

  get gridStep(): number { return this.gridGroup.userData.step ?? 10; }

  // ---------------------------------------------------------------- dimensions

  private dimLine(group: THREE.Group, from: THREE.Vector3, to: THREE.Vector3, offset: THREE.Vector3, text: string, color: number, cls: string, target?: DimTarget) {
    dimLine(group, from, to, offset, text, color, cls, this.modelSize(), target && ((el, current) => this.onDimEdit(target, el.getBoundingClientRect(), current)));
  }

  private clearGroup(group: THREE.Group) { clearGroup(group); }

  private rebuildDims() {
    this.clearGroup(this.dimsGroup);
    this.clearGroup(this.annGroup);
    if (!this.result?.bbox) return;
    for (const d of boxDimensions(this.result.bbox, this.modelSize())) {
      this.dimLine(this.dimsGroup, new THREE.Vector3(...d.from), new THREE.Vector3(...d.to), new THREE.Vector3(...d.offset), d.label,
        new THREE.Color(d.color).getHex(), `dim-label dim-${'xyz'[d.axis]}`, { kind: 'bbox', axis: d.axis });
    }
    this.result.dimensions.forEach((d, i) => this.addAnnotation(d, i));
  }

  private addAnnotation(d: DimensionAnnotation, index: number) {
    const from = new THREE.Vector3(...d.from), to = new THREE.Vector3(...d.to);
    const len = from.distanceTo(to);
    const offset = d.offset ? new THREE.Vector3(...d.offset) : new THREE.Vector3();
    this.dimLine(this.annGroup, from, to, offset, `${d.label ? d.label + ': ' : ''}${fmt(len)} mm`, 0xf0b54a, 'dim-label dim-ann', { kind: 'callout', index });
  }

  // ---------------------------------------------------------------- picking & measuring

  private pick(ev: PointerEvent): { point: THREE.Vector3; snapped: boolean } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    (this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
    const visible = this.meshes.filter((m) => m.parent?.visible);
    let hits = this.raycaster.intersectObjects(visible, false);
    if (this.opts.section.enabled) hits = hits.filter((h) => this.clipPlane.distanceToPoint(h.point) >= 0);
    const hit = hits[0];
    if (!hit || !hit.face) return null;
    // Snap to the nearest triangle vertex within 12 px.
    const pos = (hit.object as THREE.Mesh).geometry.getAttribute('position');
    let best: THREE.Vector3 | null = null, bestD = 12;
    for (const idx of [hit.face.a, hit.face.b, hit.face.c]) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, idx);
      const p = v.clone().project(this.camera);
      const sx = ((p.x + 1) / 2) * rect.width, sy = ((1 - p.y) / 2) * rect.height;
      const d = Math.hypot(sx - (ev.clientX - rect.left), sy - (ev.clientY - rect.top));
      if (d < bestD) { bestD = d; best = v; }
    }
    return best ? { point: best, snapped: true } : { point: hit.point.clone(), snapped: false };
  }

  private pickFace(ev: PointerEvent): { part: string; point: Vec3; normal: Vec3 } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.meshes.filter((m) => m.parent?.visible), false)[0];
    if (!hit?.face) return null;
    const n = hit.face.normal.clone().normalize();
    return { part: String(hit.object.userData.part), point: [hit.point.x, hit.point.y, hit.point.z], normal: [n.x, n.y, n.z] };
  }

  // ---------------------------------------------------------------- repainting a coloured mesh

  /** Repaint mode on (the mesh, its tool, the picked patch) or off (null). */
  setRepaint(r: RepaintView | null) {
    const was = this.repaint;
    this.repaint = r;
    if (!r) { this.brushRing.visible = false; this.endStroke(false); }
    else (this.brushRing.material as THREE.MeshBasicMaterial).color.set(r.color);
    if (r?.mode !== 'brush') this.brushRing.visible = false;
    if (was?.selected !== r?.selected || was?.mesh !== r?.mesh) this.drawRepaintSelection();
    this.applyOptions();
  }

  /** The repainted mesh's triangles in `mask` (by stored triangle) shown in `color` at once, until the rebuild with them arrives. */
  paintStored(mesh: string, mask: Uint8Array, color: string) {
    const c = new THREE.Color(color);
    this.eachRepaintable(mesh, (m, src, idx) => {
      const attr = m.geometry.getAttribute('color') as THREE.BufferAttribute;
      for (let t = 0; t < src.mesh.length; t++) if (src.mesh[t] === idx && mask[src.face[t]]) for (let k = 0; k < 3; k++) attr.setXYZ(3 * t + k, c.r, c.g, c.b);
      attr.needsUpdate = true;
    });
  }

  /**
   * Each shown part with triangles of the coloured mesh `name` (drawn per triangle, so triangle t is
   * vertices 3t..3t+2 of its geometry), with its source map and the mesh's index in it.
   */
  private eachRepaintable(name: string, fn: (m: THREE.Mesh, src: PaintSource, idx: number, part: PartMesh) => void) {
    for (const m of this.meshes) {
      const part = this.result?.parts[m.userData.index as number];
      const src = part?.paint?.source;
      const idx = src ? src.meshes.indexOf(name) : -1;
      if (part && src && idx >= 0 && m.userData.painted && m.parent?.visible) fn(m, src, idx, part);
    }
  }

  /** The picked patch: its triangles tinted. */
  private drawRepaintSelection() {
    for (const o of [...this.repaintGroup.children]) {
      const m = o as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      this.repaintGroup.remove(o);
    }
    const sel = this.repaint?.selected;
    if (!sel) return;
    this.eachRepaintable(this.repaint!.mesh, (_m, src, idx, part) => {
      const out: number[] = [];
      const P = part.positions, I = part.indices;
      for (let t = 0; t < src.mesh.length; t++) {
        if (src.mesh[t] !== idx || !sel[src.face[t]]) continue;
        for (let k = 0; k < 3; k++) { const v = I[3 * t + k] * 3; out.push(P[v], P[v + 1], P[v + 2]); }
      }
      if (!out.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color: 0xffd36b, transparent: true, opacity: 0.6, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, clippingPlanes: this.opts.section.enabled ? [this.clipPlane] : [],
      }));
      mesh.raycast = () => {};
      mesh.renderOrder = 5;
      this.repaintGroup.add(mesh);
    });
  }

  /** Under the pointer in repaint mode: the point, its normal and the repainted mesh's stored triangle there (−1 for other geometry). */
  private repaintHit(ev: PointerEvent): { point: THREE.Vector3; normal: THREE.Vector3; face: number } | null {
    if (!this.repaint || !this.result) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    (this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
    let hits = this.raycaster.intersectObjects(this.meshes.filter((m) => m.parent?.visible), false);
    if (this.opts.section.enabled) hits = hits.filter((h) => this.clipPlane.distanceToPoint(h.point) >= 0);
    const hit = hits[0];
    if (!hit?.face) return null;
    const src = this.result.parts[hit.object.userData.index as number]?.paint?.source;
    const idx = src && hit.object.userData.painted ? src.meshes.indexOf(this.repaint.mesh) : -1;
    // Unshared triangles: the hit triangle is its first corner's vertex / 3.
    const t = Math.floor(hit.face.a / 3);
    return { point: hit.point.clone(), normal: hit.face.normal.clone(), face: idx >= 0 && src!.mesh[t] === idx ? src!.face[t] : -1 };
  }

  private trisOf(part: PartMesh) {
    let c = this.triCache.get(part);
    if (c) return c;
    const P = part.positions, I = part.indices, n = I.length / 3;
    c = { centres: new Float32Array(n * 3), normals: new Float32Array(n * 3) };
    const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
    for (let t = 0; t < n; t++) {
      a.fromArray(P, I[3 * t] * 3); b.fromArray(P, I[3 * t + 1] * 3); d.fromArray(P, I[3 * t + 2] * 3);
      c.centres.set([(a.x + b.x + d.x) / 3, (a.y + b.y + d.y) / 3, (a.z + b.z + d.z) / 3], 3 * t);
      b.sub(a); d.sub(a);
      c.normals.set(b.cross(d).toArray(), 3 * t);
    }
    this.triCache.set(part, c);
    return c;
  }

  /** The brush at `point`: the repainted mesh's triangles whose centre is within its radius (facing its side) take its colour. */
  private brushAt(point: THREE.Vector3, normal: THREE.Vector3) {
    const s = this.stroke, r = this.repaint;
    if (!s || !r) return;
    const r2 = r.radius * r.radius;
    this.eachRepaintable(r.mesh, (m, src, idx, part) => {
      const b = part.bbox;
      if ([0, 1, 2].some((k) => point.getComponent(k) < b.min[k] - r.radius || point.getComponent(k) > b.max[k] + r.radius)) return;
      const { centres, normals } = this.trisOf(part);
      const attr = m.geometry.getAttribute('color') as THREE.BufferAttribute;
      let changed = false;
      for (let t = 0; t < src.mesh.length; t++) {
        if (src.mesh[t] !== idx) continue;
        const dx = centres[3 * t] - point.x, dy = centres[3 * t + 1] - point.y, dz = centres[3 * t + 2] - point.z;
        // Not through to the far side of a thin arm.
        if (dx * dx + dy * dy + dz * dz > r2 || normals[3 * t] * normal.x + normals[3 * t + 1] * normal.y + normals[3 * t + 2] * normal.z < 0) continue;
        s.faces.add(src.face[t]);
        for (let k = 0; k < 3; k++) attr.setXYZ(3 * t + k, s.color.r, s.color.g, s.color.b);
        changed = true;
      }
      if (changed) attr.needsUpdate = true;
    });
  }

  private showRing(hit: { point: THREE.Vector3; normal: THREE.Vector3 } | null) {
    const ring = this.brushRing;
    ring.visible = !!hit && this.repaint?.mode === 'brush';
    if (!hit || !ring.visible) return;
    const n = hit.normal.clone().normalize();
    ring.position.copy(hit.point).addScaledVector(n, 0.02);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    ring.scale.setScalar(this.repaint!.radius);
  }

  /** A left drag on the model in brush mode paints instead of turning the view (a drag beside it still does). */
  private onBrushDown = (ev: PointerEvent) => {
    if (this.repaint?.mode !== 'brush' || ev.button !== 0 || this.stroke) return;
    const hit = this.repaintHit(ev);
    if (!hit) return;
    this.controls.enabled = false;
    this.renderer.domElement.setPointerCapture(ev.pointerId);
    this.stroke = { faces: new Set(), color: new THREE.Color(this.repaint.color), pending: null };
    this.brushAt(hit.point, hit.normal);
  };

  private endStroke(emit: boolean) {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    this.controls.enabled = true;
    if (emit && s.faces.size) this.onRepaintStroke([...s.faces]);
  }

  private hoverPending = false;
  private onPointerMove = (ev: PointerEvent) => {
    const s = this.stroke;
    if (s) {
      // One brush step a frame, at the latest pointer position.
      const queued = !!s.pending;
      s.pending = ev;
      if (!queued) requestAnimationFrame(() => {
        const e = s.pending;
        s.pending = null;
        const hit = e && this.stroke === s ? this.repaintHit(e) : null;
        if (hit) { this.brushAt(hit.point, hit.normal); this.showRing(hit); }
      });
      return;
    }
    if (this.hoverPending || ev.buttons) return;
    this.hoverPending = true;
    requestAnimationFrame(() => {
      this.hoverPending = false;
      if (this.repaint) {
        // The brush's outline instead of the snap marker and coordinates.
        this.snapMarker.visible = false;
        this.onHover(null, false);
        this.showRing(this.repaint.mode === 'brush' ? this.repaintHit(ev) : null);
        return;
      }
      const res = this.pick(ev);
      const markerEl = this.snapMarker.element;
      if (res) {
        this.snapMarker.visible = true;
        this.snapMarker.position.copy(res.point);
        markerEl.classList.toggle('snapped', res.snapped);
        markerEl.classList.toggle('measuring', this.opts.measure);
        this.onHover([res.point.x, res.point.y, res.point.z], res.snapped);
        if (this.pendingPoint && this.opts.measure) this.updatePendingLine(res.point);
      } else {
        this.snapMarker.visible = false;
        this.onHover(null, false);
      }
    });
  };

  private onPointerDown = (ev: PointerEvent) => { this.downAt = { x: ev.clientX, y: ev.clientY }; };

  private onPointerUp = (ev: PointerEvent) => {
    if (this.stroke && ev.button === 0) { this.downAt = null; this.endStroke(true); return; }
    if (!this.downAt || ev.button !== 0) return;
    const moved = Math.hypot(ev.clientX - this.downAt.x, ev.clientY - this.downAt.y);
    this.downAt = null;
    if (moved > 4) return;
    if (this.repaint) {
      const hit = this.repaint.mode === 'patch' ? this.repaintHit(ev) : null;
      if (hit && hit.face >= 0) this.onRepaintPick(hit.face);
      return;
    }
    if (this.opts.pickText) {
      const hit = this.pickFace(ev);
      if (hit) this.onPickSurface(hit);
      return;
    }
    if (!this.opts.measure) return;
    const res = this.pick(ev);
    if (!res) return;
    const p: Vec3 = [res.point.x, res.point.y, res.point.z];
    if (!this.pendingPoint) {
      this.pendingPoint = p;
    } else {
      this.measurements = [...this.measurements, { a: this.pendingPoint, b: p }];
      this.cancelPending();
      this.drawMeasurements();
      this.onMeasurementsChange(this.measurements);
    }
  };

  private onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') this.cancelPending();
  };

  private updatePendingLine(to: THREE.Vector3) {
    if (!this.pendingPoint) return;
    const from = new THREE.Vector3(...this.pendingPoint);
    if (!this.pendingLine) {
      this.pendingLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffd36b, dashSize: 1, gapSize: 0.6, depthTest: false }));
      this.pendingLine.renderOrder = 1000;
      this.scene.add(this.pendingLine);
    }
    this.pendingLine.geometry.setFromPoints([from, to]);
    this.pendingLine.computeLineDistances();
    const s = this.modelSize() / 80;
    const m = this.pendingLine.material as THREE.LineDashedMaterial;
    m.dashSize = s; m.gapSize = s * 0.6;
  }

  private cancelPending() {
    this.pendingPoint = null;
    if (this.pendingLine) { this.scene.remove(this.pendingLine); this.pendingLine.geometry.dispose(); this.pendingLine = null; }
  }

  clearMeasurements() {
    this.measurements = [];
    this.cancelPending();
    this.drawMeasurements();
    this.onMeasurementsChange(this.measurements);
  }

  private drawMeasurements() {
    this.clearGroup(this.measureGroup);
    for (const m of this.measurements) {
      const a = new THREE.Vector3(...m.a), b = new THREE.Vector3(...m.b);
      const d = b.clone().sub(a);
      this.dimLine(this.measureGroup, a, b, new THREE.Vector3(), `${fmt(d.length())} mm`, 0xffd36b, 'dim-label dim-measure');
      for (const p of [a, b]) {
        const dot = label('', 'measure-dot');
        dot.position.copy(p);
        this.measureGroup.add(dot);
      }
    }
  }

  /**
   * JPEG of exactly what the user sees: the 3D view plus the dimension labels
   * (drawn onto the image, since they are HTML overlays). Long side capped at `maxSize`.
   */
  snapshot(maxSize = 1280): string {
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const k = Math.min(1, maxSize / Math.max(w, h));
    const out = document.createElement('canvas');
    out.width = Math.round(w * k);
    out.height = Math.round(h * k);
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0, out.width, out.height);
    if (!this.clean) {
      const base = this.container.getBoundingClientRect();
      ctx.font = `600 ${Math.max(9, Math.round(11.5 * k))}px ui-monospace, monospace`;
      ctx.textBaseline = 'middle';
      for (const el of this.labelRenderer.domElement.querySelectorAll<HTMLElement>('.dim-label')) {
        if (el.offsetParent === null) continue;
        const r = el.getBoundingClientRect();
        const x = (r.left - base.left) * k, y = (r.top - base.top) * k, rw = r.width * k, rh = r.height * k;
        if (x + rw < 0 || y + rh < 0 || x > out.width || y > out.height) continue;
        const style = getComputedStyle(el);
        ctx.fillStyle = '#0f1012e6';
        ctx.fillRect(x, y, rw, rh);
        ctx.strokeStyle = style.borderColor;
        ctx.strokeRect(x + 0.5, y + 0.5, rw - 1, rh - 1);
        ctx.fillStyle = style.color;
        ctx.fillText(el.textContent ?? '', x + 4 * k, y + rh / 2);
      }
    }
    return out.toDataURL('image/jpeg', 0.85);
  }

  // ---------------------------------------------------------------- product photos

  private photoRig: { lights: THREE.Group; env: THREE.Texture } | null = null;

  /**
   * PNG of only the model for a product photo: no grid, plate, labels, edges, section, validation
   * marks or highlight; the real part colours under soft studio light, on a plain grey that
   * contrasts with them. `aspect` = width / height; the long side is `size` px.
   */
  photo(view: PhotoView, aspect: number, size = 1536): string | null {
    const box = this.visibleBox();
    if (!box) return null;
    const W = Math.round(aspect >= 1 ? size : size * aspect), H = Math.round(aspect >= 1 ? size / aspect : size);
    // A long lens, like a product photographer's: little perspective distortion.
    const cam = new THREE.PerspectiveCamera(22, W / H, 0.1, 1e6);
    const center = box.getCenter(new THREE.Vector3());
    const dir = new THREE.Vector3();
    if (view === 'current') {
      dir.copy(this.camera.position).sub(this.controls.target).normalize();
      cam.up.copy(this.camera.up);
    } else if (view === 'face') {
      // A little off-axis, so the raised details and the thickness show.
      dir.set(0.1, -0.16, 1).normalize();
      cam.up.set(0, 1, 0);
    } else {
      // Flat things from higher up, so their top shows; the rest from a little above.
      const s = box.getSize(new THREE.Vector3());
      dir.set(0.55, -1, s.z < 0.3 * Math.min(s.x, s.y) ? 1.05 : 0.5).normalize();
    }
    if (!Number.isFinite(dir.x)) dir.set(...VIEW_DIRS.iso).normalize();
    cam.position.copy(center).addScaledVector(dir, framingDistance(box, center, dir, cam, 0.8));
    cam.lookAt(center);
    cam.near = cam.position.distanceTo(center) / 100;
    cam.far = cam.position.distanceTo(center) * 10;
    cam.updateProjectionMatrix();

    // Clean scene: overlays off, true colours, no section or highlight.
    const shown = [this.gridGroup, this.plateGroup, this.dimsGroup, this.annGroup, this.measureGroup, this.issueGroup, this.snapMarker, this.repaintGroup, this.brushRing].map((g) => [g, g.visible] as const);
    for (const [g] of shown) g.visible = false;
    if (this.pendingLine) this.pendingLine.visible = false;
    const looks: [THREE.MeshStandardMaterial, number, number][] = [];
    for (const group of this.modelGroup.children) {
      const [front, back] = group.children as THREE.Mesh[];
      const fm = front.material as THREE.MeshStandardMaterial, bm = back.material as THREE.MeshBasicMaterial;
      // A print in one colour is photographed in its one filament.
      const single = this.opts.oneColour ? new THREE.Color(this.opts.oneColour) : null;
      const perVertex = !!front.userData.perVertex && !single;
      fm.color.copy(single ?? front.userData.color as THREE.Color);
      bm.color.copy(single ?? front.userData.color as THREE.Color).multiplyScalar(0.45);
      fm.vertexColors = bm.vertexColors = perVertex;
      fm.emissive.setScalar(0);
      // Matte PLA (per-vertex reliefs are matte already).
      if (!perVertex || front.userData.painted) { looks.push([fm, fm.roughness, fm.metalness]); fm.roughness = 0.7; fm.metalness = 0; }
      group.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (mat) { mat.clippingPlanes = []; mat.needsUpdate = true; }
        if (o.name === 'edges') o.visible = false;
      });
    }
    const rig = this.photoLights();
    for (const l of this.lights) l.visible = false;
    rig.lights.visible = true;
    // Key light from the upper left of the camera, a softer fill from the right, a rim from behind.
    const right = new THREE.Vector3().crossVectors(dir, cam.up).normalize().negate();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    const [key, fill, rim] = rig.lights.children as THREE.DirectionalLight[];
    key.position.copy(dir).addScaledVector(right, -1.1).addScaledVector(up, 1.3);
    fill.position.copy(dir).addScaledVector(right, 1.2).addScaledVector(up, 0.2);
    rim.position.copy(dir).multiplyScalar(-1).addScaledVector(up, 1.2);
    const envBefore = this.scene.environment, envIntensity = this.scene.environmentIntensity;
    this.scene.environment = rig.env;
    this.scene.environmentIntensity = 0.1;

    const pr = this.renderer.getPixelRatio();
    const clear = this.renderer.getClearColor(new THREE.Color()), alpha = this.renderer.getClearAlpha();
    try {
      // Rendered at twice the size and scaled down: smoother edges than MSAA alone.
      const k = Math.min(2, this.renderer.capabilities.maxTextureSize / Math.max(W, H));
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(Math.round(W * k), Math.round(H * k), false);
      this.renderer.setClearColor(photoBackground(this.result?.parts.filter((p) => !this.opts.hiddenParts.includes(p.name)) ?? []), 1);
      this.renderer.render(this.scene, cam);
      const out = document.createElement('canvas');
      out.width = W;
      out.height = H;
      const ctx = out.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.renderer.domElement, 0, 0, W, H);
      return out.toDataURL('image/png');
    } finally {
      this.renderer.setClearColor(clear, alpha);
      this.renderer.setPixelRatio(pr);
      this.resize();
      this.scene.environment = envBefore;
      this.scene.environmentIntensity = envIntensity;
      rig.lights.visible = false;
      for (const l of this.lights) l.visible = true;
      for (const [m, r, mt] of looks) { m.roughness = r; m.metalness = mt; }
      for (const [g, v] of shown) g.visible = v;
      if (this.pendingLine) this.pendingLine.visible = true;
      this.applyOptions();
    }
  }

  /** The box around the parts that are shown. */
  private visibleBox(): THREE.Box3 | null {
    const parts = this.result?.parts.filter((p) => !this.opts.hiddenParts.includes(p.name)) ?? [];
    if (!parts.length) return null;
    const box = new THREE.Box3();
    for (const p of parts) box.union(new THREE.Box3(new THREE.Vector3(...p.bbox.min), new THREE.Vector3(...p.bbox.max)));
    return box.isEmpty() ? null : box;
  }

  private photoLights() {
    if (this.photoRig) return this.photoRig;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    const lights = new THREE.Group();
    // Gentle: the image model takes the colours from the render, so lit faces keep the filament's own.
    lights.add(new THREE.DirectionalLight(0xfffaf2, 2.3), new THREE.DirectionalLight(0xf2f5ff, 0.6), new THREE.DirectionalLight(0xffffff, 0.5), new THREE.HemisphereLight(0xf2f4f8, 0x4a4540, 0.9));
    lights.visible = false;
    this.scene.add(lights);
    this.photoRig = { lights, env };
    return this.photoRig;
  }
}

/** Camera distance along `dir` at which every corner of `box` is inside `fill` of the frame. */
function framingDistance(box: THREE.Box3, center: THREE.Vector3, dir: THREE.Vector3, cam: THREE.PerspectiveCamera, fill: number): number {
  const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * fill, tanH = tanV * cam.aspect;
  const right = new THREE.Vector3().crossVectors(cam.up, dir).normalize();
  if (right.lengthSq() < 0.5) right.set(1, 0, 0);
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  let d = 1;
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
    // Depth of the corner from a camera at distance D is D - p·dir.
    d = Math.max(d, p.dot(dir) + Math.abs(p.dot(right)) / tanH, p.dot(dir) + Math.abs(p.dot(up)) / tanV);
  }
  return d;
}

/** A plain grey that the parts stand out from: mid grey behind light models, light grey otherwise. */
function photoBackground(parts: EvalResult['parts']): THREE.Color {
  let sum = 0, weight = 0;
  for (const p of parts) {
    const c = new THREE.Color(p.vertexColors || p.paint ? '#808080' : p.color);
    sum += (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * p.surfaceArea;
    weight += p.surfaceArea;
  }
  const light = weight > 0 && sum / weight > 0.45;
  return new THREE.Color(light ? '#8a8d93' : '#dcdde0');
}
