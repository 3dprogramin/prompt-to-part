// Jig's mark: the letter J built from printed layers, the top one still being laid down (light).
// One drawing for every size, from the 16 px tab icon up. Source: docs/brand/jig-mark.svg.
const LAYERS: [number, number, number][] = [
  [36, 14, 16], [36, 24, 16], [8, 34, 12], [36, 34, 16], [8, 44, 44], [14, 54, 32],
];

export function JigMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="jig-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect className="jig-mark-top" x="22" y="4" width="30" height="8" rx="3" />
      {LAYERS.map(([x, y, w]) => <rect key={`${x}-${y}`} className="jig-mark-layer" x={x} y={y} width={w} height="8" rx="3" />)}
    </svg>
  );
}
