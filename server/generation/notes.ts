// Notes in the request on how Claude works with the user (Ask first) and on a line-art design's
// drawings and the user's Print tab settings.
import type { GenerateRequest, ImageData } from '../../shared/api';
import { artworkAvailable } from '../artwork';
import { drawingFingerprint, LINE_ART_STYLE_INFO, LINEART_EDITS_KEY, LINEART_ENDS_KEY, LINEART_SIZE_KEY, LINEART_SPLIT_KEY, parseLineArtEdits, parseLineArtEnds, parseLineArtSize, parseLineArtSplit, type LineArtStyle } from '../../shared/lineart';
import type { SvgDrawing } from '../../shared/svgFeatures';
import type { ParamValues } from '../../shared/types';

/** What Claude is told about Ask first (on unless the request turns it off). */
export function askFirstNote(askFirst: GenerateRequest['askFirst']): string {
  return askFirst === false
    ? 'Ask first is off: don\'t ask any questions, before or while building. Choose sensible defaults for anything left open (for something that holds a phone or another fragile device, the safe side: it takes a case and fits loose) and say in your final message which ones you chose.'
    : 'Ask first is on: before you build, check whether the request leaves open a choice that would change the result a lot and that you can\'t tell from the message, the attached pictures or the design so far (for example which way a phone is held, with or without a case, what it hangs on or stands on, the size or the wall it is for, the words on it, who it is for, the style). If so, build nothing yet: call ask_questions with those questions (as few as needed and at most 5, each short, with its 2 to 5 likely options and the one you would pick), then end your reply with one short line and wait. Don\'t write the questions as text: the user clicks their answers on the card. Ask nothing when the request is clear enough, for a small change to a design you already made, or when the user has just answered your questions (then build with their answers, filling any gap with sensible defaults). Never ask what you can look up (the real dimensions of products) or decide yourself (clearances, wall thickness, parameters, print settings). Something that holds or touches a phone, tablet, camera or another fragile, valuable thing counts as a choice that changes a lot: unless the message settles it, ask whether it is used with a case (and how thick) and how snug it should be. While you build, ask again only if you reach a decision that changes the result drastically and that you can\'t settle yourself (for example the object can\'t fit the bed as asked: split it or make it smaller?): one or two questions at most, and at most twice in a whole design; submit what you have so far if it helps, then call ask_questions and end your reply. If the user doesn\'t answer within a minute your picks are sent, so always pick the safe option. Otherwise don\'t stop to ask: the user wants to give the prompt and get the finished design.';
}

/** Line art mode: the style, the attached images, the drawings and what the user set in the Print tab. */
export function lineArtNote(lineArtStyle: LineArtStyle, drawings: Record<string, SvgDrawing>, refs: ImageData[], pictureValues: ParamValues): string {
  const info = LINE_ART_STYLE_INFO[lineArtStyle];
  const names = Object.keys(drawings);
  const attached = refs.length ? `The user attached ${refs.length > 1 ? `${refs.length} images (numbered 1–${refs.length} in the order above)` : 'an image (image 1)'}: trace_line_art({ name, image }) traces one that already is line art as it is; a photo of a real subject is redrawn with generate_line_art({ …, use_attached_photos: true })${artworkAvailable() ? '' : ' (not available: Jig has no image model without OPENROUTER_API_KEY)'}.` : '';
  const none = artworkAvailable()
    ? 'There is no drawing yet: make one with generate_line_art (or trace an attached line-art picture with trace_line_art).'
    : 'There is no drawing yet, and Jig has no image model without OPENROUTER_API_KEY: trace an attached line-art picture with trace_line_art, or ask the user to attach an SVG or a picture of line art (dark lines on white).';
  // The user's brush edits, per drawing (only those made on the drawing as it is now apply).
  const edits = parseLineArtEdits(pictureValues[LINEART_EDITS_KEY]);
  const handEdited = (n: string) => { const e = edits[n]; return e && e.fp === drawingFingerprint(drawings[n]) ? `, ${e.strokes.length} hand edit${e.strokes.length > 1 ? 's' : ''} by the user` : ''; };
  const available = names.length ? `Drawings available to H.lineart: ${names.map((n) => `"${n}" (${drawings[n].aspect.toFixed(2)} times as wide as high${handEdited(n)})`).join(', ')}.` : none;
  // The user's split choice in the Print tab wins over the script's split option.
  const split = parseLineArtSplit(pictureValues[LINEART_SPLIT_KEY]);
  const splitNote = split === undefined ? '' : split === 'off'
    ? 'The user turned Split into pieces off in the Print tab: it stays one piece whatever the script\'s split option says (they turn it on there; say so if it is bigger than the bed).'
    : `The user split it into pieces in the Print tab (${split === 'auto' ? 'Auto: the fewest that fit the bed' : Array.isArray(split) ? `a grid of ${split[0]} × ${split[1]}` : `${split} pieces`}), which wins over the script's split option; the renders and reports already use it.`;
  // The whole piece's size the user typed in the Print tab wins over the script's width and height.
  const size = parseLineArtSize(pictureValues[LINEART_SIZE_KEY]);
  const sizeNote = size ? `The user set the whole piece's size in the Print tab (${size.width ? `${size.width} mm wide` : ''}${size.width && size.height ? ', ' : ''}${size.height ? `${size.height} mm high` : ''}${size.width && !size.height ? ', the height following the drawing' : ''}), which wins over the script's width and height: the renders and reports already use it. Keep it; to change the size, ask them to change it there (or set the width and height parameters if they ask you to and they clear it).` : '';
  // How far loose ends reach to join a line, as the user set it in the Print tab, wins over the script's joinEnds.
  const ends = parseLineArtEnds(pictureValues[LINEART_ENDS_KEY]);
  const endsNote = ends === undefined ? '' : ends === 0
    ? "The user turned Join loose ends off in the Print tab: Jig leaves loose lines as drawn whatever the script's joinEnds says (they glue them down, or turn it on there)."
    : `The user set Join loose ends to ${ends} mm in the Print tab, which wins over the script's joinEnds; the renders and reports already use it.`;
  return [`Line art mode is on (style: ${info.label} – ${info.desc}; if the user's message asks for another style, follow the message): make this a line-art cut-out with H.lineart (see the system prompt).`, attached, available, splitNote, sizeNote, endsNote].filter(Boolean).join(' ');
}
