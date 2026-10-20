import { useMemo } from 'react';
import type { EvalResult, ParamValues, PartMesh } from '../../shared/types';
import { LINE_ART_STYLE_INFO, type LineArtInfo } from '../../shared/lineart';
import { DRAWINGS_KEY, parseDrawings, type SvgDrawing } from '../../shared/svgFeatures';
import { PRINTER } from '../../shared/printer';
import { Icon } from './Icon';

/** A line-art part (H.lineart): its style, drawings and what Jig fixed. */
type LineArtPart = PartMesh & { lineArt: LineArtInfo };

/** The first part of the model that is line art, if any. */
export function lineArtPart(result: EvalResult | null): LineArtPart | undefined {
  return result?.parts.find((p): p is LineArtPart => !!p.lineArt);
}

/** More bridges than this, or a longer one (mm), and the drawing is worth asking again for. */
const MANY_BRIDGES = 10;
const LONG_BRIDGE = 15;

/** A drawing as it was attached or drawn, on paper: its shapes in their own colours. */
function DrawingPreview({ drawing }: { drawing: SvgDrawing }) {
  const shapes = useMemo(() => drawing.shapes.map((s) => ({
    d: s.contours.map((c) => `M${c.map(([x, y]) => `${x.toFixed(4)} ${(-y).toFixed(4)}`).join('L')}Z`).join(''),
    rule: s.rule === 'EvenOdd' ? 'evenodd' as const : 'nonzero' as const,
    color: s.color || '#1a1a1a',
  })), [drawing]);
  const pad = 0.04;
  return (
    <svg className="lineart-drawing" viewBox={`${-drawing.aspect / 2 - pad} ${-0.5 - pad} ${drawing.aspect + 2 * pad} ${1 + 2 * pad}`} role="img" aria-label={`The drawing ${drawing.name}`}>
      {shapes.map((s, i) => <path key={i} d={s.d} fill={s.color} fillRule={s.rule} />)}
    </svg>
  );
}

interface Props {
  part: LineArtPart;
  /** The design's values: DRAWINGS_KEY (the attached and drawn drawings). */
  values: ParamValues;
}

/**
 * Print tab, Line art section: the drawing(s) the piece was made from, what Jig fixed (bridges,
 * dropped specks) and how to print and hang it. Sizes are the script's sliders (Parameters).
 */
export function LineArtPanel({ part, values }: Props) {
  const drawings = useMemo(() => parseDrawings(values[DRAWINGS_KEY]), [values[DRAWINGS_KEY]]);
  const la = part.lineArt;
  const [w, h] = la.size;
  const bed = PRINTER.name.replace(/^Bambu Lab /, '');
  const tooBig = w > PRINTER.bed[0] || h > PRINTER.bed[1];
  const loose = la.bridges > MANY_BRIDGES || la.longestBridge > LONG_BRIDGE;
  const mm = (v: number) => `${v.toFixed(1)} mm`;
  return (
    <div className="lineart-panel">
      {la.sources.length > 0 && (
        <div className="lineart-sources">
          {la.sources.map((name) => (
            <figure key={name} className="lineart-fig">
              {drawings[name] ? <DrawingPreview drawing={drawings[name]} /> : <div className="lineart-nodrawing small">Not stored with this design</div>}
              <figcaption className="lineart-cap" title={name}>{name}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <dl className="lineart-facts small">
        <dt>Style</dt><dd>{LINE_ART_STYLE_INFO[la.style].label}</dd>
        <dt>Size</dt>
        <dd className={tooBig ? 'warn' : ''}>
          <span className="mono">{w.toFixed(0)} × {h.toFixed(0)} mm</span>
          {tooBig && <span className="lineart-why"><Icon name="alert" size={12} /> bigger than the {bed}'s bed ({PRINTER.bed[0]} mm)</span>}
        </dd>
        <dt>Thickness</dt><dd className="mono">{mm(la.thickness)}</dd>
        <dt>Lines</dt><dd><span className="mono">{mm(la.lineWidth)}</span>, {la.lines === 'even' ? 'even' : 'kept (thin ones thickened)'}</dd>
        <dt>Bridges</dt>
        <dd className={loose ? 'warn' : ''}>
          {la.bridges ? <><span className="mono">{la.bridges}</span> added, longest <span className="mono">{mm(la.longestBridge)}</span></> : 'none needed'}
          {loose && <span className="lineart-why"><Icon name="alert" size={12} /> ask Jig for a more connected drawing</span>}
        </dd>
        <dt>Specks</dt><dd>{la.dropped ? <><span className="mono">{la.dropped}</span> dropped (too small to print)</> : 'none dropped'}</dd>
        {la.hooks > 0 && <><dt>Pegs</dt><dd className="mono">{la.hooks}</dd></>}
      </dl>
      <ul className="litho-advice small">
        <li><b>Print flat</b>, back down, in one colour (black PLA); no brim.</li>
        <li>{la.style === 'stand' ? "Push the piece into the base's slot." : 'Hang with double-sided tape or Command strips.'}</li>
      </ul>
    </div>
  );
}
