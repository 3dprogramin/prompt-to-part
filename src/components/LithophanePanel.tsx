import { useMemo } from 'react';
import type { EvalResult, ParamValues, PartMesh } from '../../shared/types';
import { HF_IMAGES_KEY, parseHfImages, type HfImage } from '../../shared/hueforge';
import { lithoPrint, simulateLithophane, type LithophaneSource } from '../../shared/lithophane';
import { rgbaToDataUrl } from '../lib/hfImage';
import { PicturePair } from './HueforgePanel';

/** A lithophane part: (from the runtime) the picture and options it was built with. */
type LithoPart = PartMesh & { lithophane: LithophaneSource };

/** The first part of the model that is a lithophane (H.lithophane), if any. */
export function lithophanePart(result: EvalResult | null): LithoPart | undefined {
  return result?.parts.find((p): p is LithoPart => !!p.lithophane);
}

interface Props {
  part: LithoPart;
  /** The design's values: HF_IMAGES_KEY (the pictures). */
  values: ParamValues;
  /** Replace a stored picture. */
  onImage: (name: string, image: HfImage) => void;
}

/**
 * Print tab, Lithophane section: the picture next to the panel lit from behind, and how to print
 * it. Sizes and thicknesses are the script's sliders (Parameters).
 */
export function LithophanePanel({ part, values, onImage }: Props) {
  const images = useMemo(() => parseHfImages(values[HF_IMAGES_KEY]), [values[HF_IMAGES_KEY]]);
  const src = part.lithophane;
  const name = images[src.image] ? src.image : Object.keys(images)[0];
  const image = name ? images[name] : undefined;
  const o = src.options;
  const optionsKey = JSON.stringify(o);
  const lit = useMemo(() => {
    if (!image) return null;
    try {
      const s = simulateLithophane(image, o);
      return rgbaToDataUrl(s.width, s.height, s.rgba);
    } catch {
      return null;
    }
  }, [image, optionsKey]);
  const { print } = lithoPrint(o);
  const b = part.bbox;
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].map((v) => v.toFixed(0)).join(' × ');
  const form = o.shape === 'cylinder' ? `cylinder, Ø ${(o.width / Math.PI).toFixed(0)} mm` : o.shape === 'curved' ? `curved, ${o.angle.toFixed(0)}°` : o.upright ? 'flat, standing' : 'flat, lying';
  return (
    <div className="hf-panel">
      <PicturePair name={name} image={image} preview={lit} previewLabel="Lit from behind" previewAlt="How the lithophane looks lit from behind" onImage={onImage}
        empty="No picture is stored with this design: attach a photo in the chat with Lithophane chosen in the palette menu." />
      <div className="hf-stats small" role="status">
        <span className="mono">{size} mm</span> · <span className="mono">{o.minThickness.toFixed(1)}–{o.maxThickness.toFixed(1)} mm</span> thick · {form}
      </div>
      <ul className="litho-advice small">
        <li><b>White PLA</b>: a coloured one tints the light and hides the tones.</li>
        {o.upright
          ? <li><b>Upright, as shown</b> (picture vertical): the walls then follow the thickness smoothly. {o.stand > 0 ? 'The foot keeps it steady.' : <>Use a <b>brim</b> so the thin panel stays put.</>}</li>
          : <li><b>Lying flat</b>, relief up: standing up gives finer tones.</li>}
        <li><span className="mono">{print.layerHeight}</span> mm layers, <span className="mono">100 %</span> infill, <span className="mono">{print.walls}</span> walls: already in the print settings.</li>
        <li>Light it with an LED: PLA softens at about 60 °C.</li>
      </ul>
      <div className="dim small">Size and thickness: the sliders under Parameters (Object tab).</div>
    </div>
  );
}
