// The notes on edit_picture in a picture mode's first message (AI artwork's drawings, LayerTone's
// photos): which pictures have a saved mark (made on the picture as it is now), and the picture
// edits the user kept in the editor since Claude's last version.
import type { GenerateRequest } from '../../shared/api';
import type { ParamValues } from '../../shared/types';
import { parsePictureMarks, PICTURE_MARKS_KEY } from '../../shared/pictureEdit/mark';

/** How a mode names its pictures in the notes: the picture, the tool that makes a new one instead, the editor the user selects in. */
export interface PictureWords { noun: string; nouns: string; instead: string; editor: string }

/** `pictures`: each picture's name and the fingerprint its mark must have been made with. */
export function pictureEditNotes(pictures: Record<string, string>, values: ParamValues, kept: GenerateRequest['pictureEdits'], w: PictureWords): string[] {
  const names = Object.keys(pictures);
  if (!names.length) return [];
  const marks = parsePictureMarks(values[PICTURE_MARKS_KEY]);
  const marked = names.filter((n) => Object.hasOwn(marks, n) && marks[n].fp === pictures[n]);
  const out = [`To change part of a ${w.noun}, use edit_picture (not ${w.instead}). ${marked.length
    ? `The user saved a mark (an area selected in the ${w.editor}) on ${marked.map((n) => `"${n}"`).join(', ')}: region "mark" uses it${marked.length < names.length ? `; ${names.filter((n) => !marked.includes(n)).map((n) => `"${n}"`).join(', ')} ${names.length - marked.length > 1 ? 'have' : 'has'} none` : ''}.`
    : `No ${w.noun} has a saved mark: pick a box with show_picture, or ask the user to select the area in the ${w.editor}.`}`];
  const edits = (Array.isArray(kept) ? kept : []).filter((e) => e && typeof e.picture === 'string' && typeof e.change === 'string' && Number.isInteger(e.version)).slice(-12);
  if (edits.length) {
    out.push(`Picture edits the user kept in the ${w.editor} since your last version (the ${w.nouns} in this design already have them): ${edits.map((e) => `v${e.version} "${e.picture.slice(0, 120)}": "${e.change.slice(0, 300)}" (${e.masked ? 'a marked area' : 'the whole picture'})`).join('; ')}.`);
  }
  return out;
}
