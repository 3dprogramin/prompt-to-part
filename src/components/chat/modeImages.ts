// The pictures for each mode's example, joined to its text. Only components import this file:
// the .webp imports need Vite, so the text and its test live in modeExamples.ts.
import type { ImageMode } from './PictureModeMenus';
import { MODE_TEXT } from './modeExamples';
import offThumb from '../../assets/modes/off.webp';
import offImage from '../../assets/modes/off-big.webp';
import artworkThumb from '../../assets/modes/artwork.webp';
import artworkImage from '../../assets/modes/artwork-big.webp';
import artworkPicture from '../../assets/modes/artwork-picture.webp';
import layertoneThumb from '../../assets/modes/layertone.webp';
import layertoneImage from '../../assets/modes/layertone-big.webp';
import lithophaneThumb from '../../assets/modes/lithophane.webp';
import lithophaneImage from '../../assets/modes/lithophane-big.webp';
import lithophanePhoto from '../../assets/modes/lithophane-photo.webp';
import lineartThumb from '../../assets/modes/lineart.webp';
import lineartImage from '../../assets/modes/lineart-big.webp';
import figureThumb from '../../assets/modes/figure.webp';
import figureImage from '../../assets/modes/figure-big.webp';
import figureMesh from '../../assets/modes/figure-mesh.webp';

export interface ModeExample {
  thumb?: string;
  image?: string;
  source?: { src: string; caption: string };
  request: string;
  facts: string[];
}

const PICTURES: Record<ImageMode, { thumb: string; image: string; source?: string }> = {
  off: { thumb: offThumb, image: offImage },
  artwork: { thumb: artworkThumb, image: artworkImage, source: artworkPicture },
  layertone: { thumb: layertoneThumb, image: layertoneImage },
  lithophane: { thumb: lithophaneThumb, image: lithophaneImage, source: lithophanePhoto },
  lineart: { thumb: lineartThumb, image: lineartImage },
  figure: { thumb: figureThumb, image: figureImage, source: figureMesh },
};

export const MODE_EXAMPLES = Object.fromEntries(
  (Object.keys(MODE_TEXT) as ImageMode[]).map((mode) => {
    const { request, facts, sourceCaption } = MODE_TEXT[mode];
    const { thumb, image, source } = PICTURES[mode];
    const ex: ModeExample = { thumb, image, request, facts, ...(source && sourceCaption ? { source: { src: source, caption: sourceCaption } } : {}) };
    return [mode, ex];
  }),
) as Record<ImageMode, ModeExample>;
