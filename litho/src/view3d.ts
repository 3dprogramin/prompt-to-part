// The 3D preview: prompt-to-part's lithophane mesh in three.js, turned with a finger or the mouse. With the
// light on it glows by per-vertex colours (prompt-to-part's backlit model, as its own viewer shows it); with
// the light off it is plain white PLA whose relief shows in the room's light.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { lithoVertexColors, type LithoResolved } from '../../shared/lithophane';
import { toLinear } from '../../shared/layertone';

export class LithoView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 1, 5000);
  private controls: OrbitControls;
  private mesh: THREE.Mesh | null = null;
  private lit: THREE.MeshStandardMaterial;
  private unlit: THREE.MeshStandardMaterial;
  private lightsOn = true;
  private radius = 0;
  private frame = 0;
  private observer: ResizeObserver;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    // prompt-to-part's lithophane stands on z = 0 with Z up, the picture facing −Y.
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.addEventListener('change', () => this.render());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8178, 1.4));
    // Room light from the upper left in front: it rakes across the relief.
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-0.8, -1, 0.9);
    this.scene.add(key);

    // Light on: the colours glow (emissive) with a little shading so the relief still reads; matte,
    // as a glossy highlight would turn the dark areas grey. As prompt-to-part's viewer does for lithophanes.
    this.lit = new THREE.MeshStandardMaterial({ color: new THREE.Color().setScalar(0.12), roughness: 1, metalness: 0, vertexColors: true });
    this.lit.onBeforeCompile = (s) => {
      s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n\ttotalEmissiveRadiance += vColor.rgb * 0.95;\n#endif');
    };
    this.unlit = new THREE.MeshStandardMaterial({ color: 0xf1ede5, roughness: 0.8, metalness: 0 });

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
  }

  /** Shows a lithophane mesh (prompt-to-part's lithophaneMesh: x, y, z, thickness per vertex). */
  setMesh(mesh: { vertProperties: Float32Array; triVerts: Uint32Array }, r: LithoResolved) {
    const V = mesh.vertProperties, n = V.length / 4;
    const pos = new Float32Array(n * 3), thick = new Float32Array(n);
    for (let i = 0; i < n; i++) { pos[i * 3] = V[i * 4]; pos[i * 3 + 1] = V[i * 4 + 1]; pos[i * 3 + 2] = V[i * 4 + 2]; thick[i] = V[i * 4 + 3]; }
    // prompt-to-part's colours are sRGB; three.js reads a colour attribute as linear.
    const colors = lithoVertexColors(thick, r).map(toLinear);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.triVerts, 1));
    // Smooth over the relief, sharp at the frame's edges.
    const geom = toCreasedNormals(g, THREE.MathUtils.degToRad(40));
    g.dispose();
    geom.computeBoundingSphere();
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.geometry = geom; }
    else { this.mesh = new THREE.Mesh(geom, this.lightsOn ? this.lit : this.unlit); this.scene.add(this.mesh); }
    const s = geom.boundingSphere!;
    // A new size or shape: back to the front view; the same one keeps the customer's angle.
    if (Math.abs(s.radius - this.radius) > this.radius * 0.02) this.fit(s);
    this.radius = s.radius;
    this.render();
  }

  setLights(on: boolean) {
    this.lightsOn = on;
    if (this.mesh) this.mesh.material = on ? this.lit : this.unlit;
    this.render();
  }

  /** Front view from a little to the right and above, the whole piece in view. */
  private fit(s: THREE.Sphere) {
    const dist = (s.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.08;
    const dir = new THREE.Vector3(0.45, -1, 0.32).normalize();
    this.controls.target.copy(s.center);
    this.camera.position.copy(s.center).addScaledVector(dir, dist);
    this.camera.near = dist / 50;
    this.camera.far = dist * 10;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = s.radius * 1.2;
    this.controls.maxDistance = dist * 3;
    this.controls.update();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Narrow (phone) stages: widen the view so the piece still fits across.
    this.camera.fov = w < h ? 30 * Math.min(1.6, h / w) : 30;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  /** Draws on the next frame (once, however often it is asked). */
  render() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.renderer.render(this.scene, this.camera); });
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.controls.dispose();
    this.mesh?.geometry.dispose();
    this.lit.dispose();
    this.unlit.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
