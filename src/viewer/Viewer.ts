import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, MeshBVH, type SerializedBVH } from 'three-mesh-bvh';
import type { DimTarget, DimensionAnnotation, EvalResult, Vec3 } from '../../shared/types';
import { PRINTER, fitProblem } from '../../shared/printer';

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
}

const NEUTRAL = new THREE.Color('#b9bcc2');

export interface Measurement { a: Vec3; b: Vec3 }

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

const fmt = (n: number) => (Math.abs(n) < 0.005 ? '0' : n.toFixed(2));

function niceStep(span: number) {
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  return steps.find((s) => span / s <= 30) ?? 1000;
}

function label(text: string, cls: string) {
  const wrap = document.createElement('div');
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  wrap.appendChild(el);
  return new CSS2DObject(wrap);
}

/** Push overlapping dimension labels apart vertically (screen space). */
function declutter(root: HTMLElement) {
  const items = [...root.querySelectorAll<HTMLElement>('.dim-label')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({ el, r: el.parentElement!.getBoundingClientRect() }))
    .sort((a, b) => a.r.top - b.r.top);
  const placed: { l: number; r: number; t: number; b: number }[] = [];
  for (const { el, r } of items) {
    let dy = 0;
    for (let iter = 0; iter < 12; iter++) {
      const hit = placed.find((p) => r.left < p.r && r.right > p.l && r.top + dy < p.b && r.bottom + dy > p.t);
      if (!hit) break;
      dy = hit.b - r.top + 2;
    }
    el.style.transform = dy ? `translateY(${dy}px)` : '';
    placed.push({ l: r.left, r: r.right, t: r.top + dy, b: r.bottom + dy });
  }
}

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

    this.scene.add(new THREE.HemisphereLight(0xdfe6f0, 0x3a3530, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(-1, -0.6, 2);
    this.scene.add(key);
    this.scene.add(this.headlight);
    this.scene.add(this.headlight.target);
    this.scene.add(this.gridGroup, this.plateGroup, this.issueGroup, this.modelGroup, this.dimsGroup, this.annGroup, this.measureGroup);

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
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointerleave', () => { this.snapMarker.visible = false; this.onHover(null, false); });
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
      for (const part of result.parts) {
        // Live previews arrive ready to draw (src/geometry/worker.ts); anything else is prepared here.
        let geom: THREE.BufferGeometry;
        let edgeGeom: THREE.BufferGeometry;
        if (part.display) {
          geom = new THREE.BufferGeometry();
          geom.setAttribute('position', new THREE.BufferAttribute(part.display.positions, 3));
          geom.setAttribute('normal', new THREE.BufferAttribute(part.display.normals, 3));
          geom.boundsTree = MeshBVH.deserialize(part.display.bvh as SerializedBVH, geom, { setIndex: true });
          edgeGeom = new THREE.BufferGeometry();
          edgeGeom.setAttribute('position', new THREE.BufferAttribute(part.display.edges, 3));
        } else {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
          g.setIndex(new THREE.BufferAttribute(part.indices, 1));
          geom = toCreasedNormals(g, THREE.MathUtils.degToRad(32));
          g.dispose();
          geom.computeBoundsTree();
          edgeGeom = new THREE.EdgesGeometry(geom, 30);
        }
        const color = new THREE.Color(part.color);
        const front = new THREE.MeshStandardMaterial({
          color, roughness: 0.55, metalness: 0.05, side: THREE.FrontSide,
          polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        });
        const back = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(0.45), side: THREE.BackSide });
        const group = new THREE.Group();
        group.name = part.name;
        const mesh = new THREE.Mesh(geom, front);
        mesh.userData.part = part.name;
        mesh.userData.color = color;
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
      }
    }
    this.applyOptions();
    this.rebuildDims();
    this.updatePlate();
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
    for (const group of this.modelGroup.children) {
      group.visible = !hiddenParts.includes(group.name);
      // Part colours, or one neutral colour to judge the bare shape.
      const [front, back] = group.children as THREE.Mesh[];
      const base = (front.userData.color as THREE.Color | undefined) ?? NEUTRAL;
      (front.material as THREE.MeshStandardMaterial).color.copy(colors ? base : NEUTRAL);
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
    this.renderer.domElement.style.cursor = this.opts.measure || this.opts.pickText ? 'crosshair' : '';
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

  private buildGrid(size: number) {
    this.gridGroup.clear();
    const step = niceStep(size * 1.5);
    const extent = Math.max(step * 20, Math.ceil((size * 2.5) / (step * 10)) * step * 10);
    const half = extent / 2;
    const minor: number[] = [], major: number[] = [];
    for (let v = -half; v <= half + 1e-6; v += step) {
      const isMajor = Math.abs(Math.round(v / (step * 5)) * step * 5 - v) < 1e-6;
      const arr = isMajor ? major : minor;
      arr.push(v, -half, 0, v, half, 0, -half, v, 0, half, v, 0);
    }
    const mk = (pts: number[], color: number, opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    };
    this.gridGroup.add(mk(minor, 0x8890a0, 0.13), mk(major, 0x8890a0, 0.3));
    const axes = (to: [number, number, number], color: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(...to)]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
    };
    this.gridGroup.add(axes([half, 0, 0], 0xe05a5a), axes([0, half, 0], 0x5ac05a), axes([0, 0, Math.min(half, size * 0.6)], 0x5a8ae0));
    this.gridGroup.userData.step = step;
  }

  private buildPlate() {
    const [w, d] = PRINTER.bed, h = PRINTER.height;
    const rect = (z: number) => [[-w / 2, -d / 2, z], [w / 2, -d / 2, z], [w / 2, d / 2, z], [-w / 2, d / 2, z]].map((p) => new THREE.Vector3(...(p as [number, number, number])));
    const loop = (pts: THREE.Vector3[]) => [...pts, pts[0]];
    const plate = new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop(rect(0))), new THREE.LineBasicMaterial({ color: 0xe0a43c, transparent: true, opacity: 0.55 }));
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: 0xe0a43c, transparent: true, opacity: 0.035, depthWrite: false, side: THREE.DoubleSide }));
    fill.raycast = () => {};
    // Build-volume outline (shown only when the model gets close to the limits)
    const top = rect(h), bottom = rect(0);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i++) pts.push(bottom[i], top[i], top[i], top[(i + 1) % 4]);
    const volume = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xe0a43c, dashSize: 4, gapSize: 4, transparent: true, opacity: 0.35 }));
    volume.computeLineDistances();
    volume.name = 'volume';
    const tag = label(`${PRINTER.name} · ${w} × ${d} mm plate`, 'plate-label');
    tag.position.set(-w / 2, -d / 2, 0);
    this.plateGroup.add(plate, fill, volume, tag);
  }

  private updatePlate() {
    const b = this.result?.bbox;
    const vol = this.plateGroup.getObjectByName('volume');
    if (!vol) return;
    const big = !!b && (b.max[0] - b.min[0] > PRINTER.bed[0] * 0.6 || b.max[1] - b.min[1] > PRINTER.bed[1] * 0.6 || b.max[2] - b.min[2] > PRINTER.height * 0.6);
    vol.visible = big || !!fitProblem(b ?? null);
    const color = fitProblem(b ?? null) ? 0xe5675f : 0xe0a43c;
    for (const o of this.plateGroup.children) {
      const mat = (o as THREE.Line).material as THREE.LineBasicMaterial | undefined;
      if (mat && 'color' in mat && o.type !== 'Mesh') mat.color.set(color);
    }
  }

  get gridStep(): number { return this.gridGroup.userData.step ?? 10; }

  // ---------------------------------------------------------------- dimensions

  private dimLine(group: THREE.Group, from: THREE.Vector3, to: THREE.Vector3, offset: THREE.Vector3, text: string, color: number, cls: string, target?: DimTarget) {
    const a = from.clone().add(offset), b = to.clone().add(offset);
    const len = a.distanceTo(b);
    if (len < 1e-6) return;
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    const pts: THREE.Vector3[] = [a, b];
    if (offset.lengthSq() > 1e-9) {
      const ext = offset.clone().normalize().multiplyScalar(this.modelSize() * 0.02);
      pts.push(from, a.clone().add(ext), to, b.clone().add(ext));
    }
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat);
    lines.renderOrder = 999;
    group.add(lines);
    const dir = b.clone().sub(a).normalize();
    const arrowLen = Math.min(len * 0.25, this.modelSize() * 0.035);
    const coneGeom = new THREE.ConeGeometry(arrowLen * 0.32, arrowLen, 12);
    coneGeom.translate(0, -arrowLen / 2, 0);
    const coneMat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
    for (const [p, d] of [[a, dir.clone().negate()], [b, dir]] as const) {
      const cone = new THREE.Mesh(coneGeom, coneMat);
      cone.position.copy(p);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
      cone.renderOrder = 999;
      cone.raycast = () => {};
      group.add(cone);
    }
    const lbl = label(text, cls);
    lbl.position.copy(a.clone().add(b).multiplyScalar(0.5));
    if (target) {
      const el = lbl.element.firstElementChild as HTMLElement;
      el.classList.add('editable');
      el.title = 'Double-click to edit';
      el.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        this.onDimEdit(target, el.getBoundingClientRect(), from.distanceTo(to));
      });
    }
    group.add(lbl);
  }

  private clearGroup(group: THREE.Group) {
    group.traverse((o) => {
      if (o instanceof CSS2DObject) o.element.remove();
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
    });
    group.clear();
  }

  private rebuildDims() {
    this.clearGroup(this.dimsGroup);
    this.clearGroup(this.annGroup);
    const box = this.modelBox();
    if (!box || !this.result) return;
    const s = box.getSize(new THREE.Vector3());
    const off = this.modelSize() * 0.12;
    const { min, max } = box;
    this.dimLine(this.dimsGroup, new THREE.Vector3(min.x, min.y, min.z), new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(0, -off, 0), `X ${fmt(s.x)} mm`, 0xe46a6a, 'dim-label dim-x', { kind: 'bbox', axis: 0 });
    this.dimLine(this.dimsGroup, new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(max.x, max.y, min.z), new THREE.Vector3(off, 0, 0), `Y ${fmt(s.y)} mm`, 0x6ac46a, 'dim-label dim-y', { kind: 'bbox', axis: 1 });
    this.dimLine(this.dimsGroup, new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(max.x, min.y, max.z), new THREE.Vector3(off * 0.7, -off * 0.7, 0), `Z ${fmt(s.z)} mm`, 0x6a9ae4, 'dim-label dim-z', { kind: 'bbox', axis: 2 });
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

  private hoverPending = false;
  private onPointerMove = (ev: PointerEvent) => {
    if (this.hoverPending || ev.buttons) return;
    this.hoverPending = true;
    requestAnimationFrame(() => {
      this.hoverPending = false;
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
    if (!this.downAt || ev.button !== 0) return;
    const moved = Math.hypot(ev.clientX - this.downAt.x, ev.clientY - this.downAt.y);
    this.downAt = null;
    if (moved > 4) return;
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

  /** PNG snapshot of the current view (for thumbnails / sharing). */
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
}
