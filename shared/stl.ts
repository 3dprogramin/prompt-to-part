// Binary STL in plain JavaScript (no DOM): Jig's STL export and the lithophane widget's production
// files are written the same way.

/** A triangle mesh: xyz per vertex, three vertex indices per triangle. */
export interface StlMesh {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

/** Binary STL of one or more meshes (merged into one file); `header` is cut to 79 ASCII characters. */
export function binaryStl(meshes: StlMesh[], header: string): ArrayBuffer {
  const triCount = meshes.reduce((s, p) => s + p.indices.length / 3, 0);
  const buf = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buf);
  const head = header.slice(0, 79);
  for (let i = 0; i < head.length; i++) view.setUint8(i, head.charCodeAt(i) & 0x7f);
  view.setUint32(80, triCount, true);
  let o = 84;
  for (const p of meshes) {
    const P = p.positions, I = p.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
      o += 12;
      for (const idx of [a, b, c]) {
        view.setFloat32(o, P[idx], true); view.setFloat32(o + 4, P[idx + 1], true); view.setFloat32(o + 8, P[idx + 2], true);
        o += 12;
      }
      view.setUint16(o, 0, true);
      o += 2;
    }
  }
  return buf;
}
