// The app's mark: the prompt sign `>` and, after it, a cursor that is already a printed part
// (three layers, the top one still being laid down, light). One drawing for every size, from the
// 16 px tab icon up. Source: docs/brand/prompt-to-part-mark.svg.
const LAYERS = [36, 43];

export function AppMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="app-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path className="app-mark-chevron" d="M12 17L28 32L12 47" fill="none" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <rect className="app-mark-top" x="34" y="29" width="20" height="5" rx="1.5" />
      {LAYERS.map((y) => <rect key={y} className="app-mark-layer" x="34" y={y} width="20" height="5" rx="1.5" />)}
    </svg>
  );
}
