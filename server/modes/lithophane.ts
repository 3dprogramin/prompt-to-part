// Lithophane mode (H.lithophane): its system prompt section and its note on the pictures.
import { printer } from '../../shared/printer';
import type { PromptMode } from './types';

function lithophanePrompt(pictures: boolean) {
  return `Lithophane mode is ON: the user wants a lithophane – a photo printed in white PLA as a panel that is thick where the picture is dark and thin where it is bright, so it shows the picture when lit from behind.
- Build it with H.lithophane(picture, { width, minThickness, maxThickness, border, shape, angle, stand, standHeight, gamma, invert, upright }) → { shape, print, lithophane, note }. Return it as one part so its print settings (0.12 mm layers, 100 % infill, enough walls to fill the panel solid, a brim unless it has a foot) are used:
    const params = { width: { label: 'Width', value: 100, min: 50, max: 200, step: 1, unit: 'mm', group: 'Lithophane' }, minThickness: { label: 'Thinnest (bright)', value: 0.8, min: 0.6, max: 1.2, step: 0.1, unit: 'mm', group: 'Lithophane' }, maxThickness: { label: 'Thickest (dark)', value: 3, min: 2, max: 4, step: 0.1, unit: 'mm', group: 'Lithophane' }, border: { label: 'Frame', value: 3, min: 0, max: 8, step: 0.5, unit: 'mm', group: 'Lithophane' }, stand: { label: 'Foot depth (0 = none)', value: 20, min: 0, max: 40, step: 1, unit: 'mm', group: 'Lithophane' } };
    function build(p) { return { name: 'Lithophane', ...H.lithophane('photo-1', { width: p.width, minThickness: p.minThickness, maxThickness: p.maxThickness, border: p.border, stand: p.stand }) }; }
- The picture names are in the user's message: attached photos are stored as "photo-1", "photo-2"…${pictures ? '; without one, make a picture with generate_picture first (aspect to suit the shape, e.g. 21:9 or 16:9 for a cylinder, 4:3 or 3:4 for a panel).' : '; without one, ask the user to attach a photo.'}
- Options (mm): width = the picture's width (curved: along the arc; cylinder: the circumference, Ø = width / π); its height follows the picture. minThickness (bright, default 0.8; not below 0.6) and maxThickness (dark, default 3); border = a solid frame at maxThickness (default 3; a cylinder gets it top and bottom); shape 'flat' (default), 'curved' (angle in degrees, default 120) or 'cylinder'; stand = depth of a foot along the bottom so it stands on a shelf (0 = none; 15–25 for a panel); gamma (< 1 lifts the shadows), invert.
- Thickness follows the light through PLA (Beer–Lambert), not a straight line: Jig maps it so the lit panel shows the photo's tones evenly. Don't build the relief yourself.
- Sensible defaults by use:
  - Night light / shelf picture: flat, 80–120 mm wide, 0.8–3 mm, frame 3 mm, stand 20 (LED tea light or strip behind it).
  - Photo frame or window panel: flat, 100–180 mm wide, 0.8–3 mm, frame 4–5 mm, no stand (it goes in a frame or hangs in the window; a hanging hole through the frame is fine).
  - Lamp shade: cylinder, width 220–300 mm (Ø 70–95 mm) for an LED bulb or puck inside, 0.8–3 mm, frame 3 mm; stand 8–10 gives it a foot ring. A wide picture (21:9) wraps best.
  - Lamp panel: curved, angle 90–150°, width 100–150 mm, stand 20.
- It stands upright (picture vertical, facing −Y; FRONT view reads it) because that prints the finest tones: the walls trace the thickness in X/Y instead of in whole layers. Keep it upright and on the bed; don't scale it. upright: false (lying flat, relief up) only when the user asks.
- It must fit the ${printer().name} (${printer().bed[0]} × ${printer().bed[1]} × ${printer().height} mm): the height is the width × the picture's height / width, plus the frame and foot.
- Don't use H.layertone in this design: a design is a lithophane or a LayerTone print, not both.
- Check it with render_model: it shows the panel lit from behind (thin = warm white, thick = dark), and the report gives its size and thicknesses. In your final message give the size (width × height × depth), the thinnest/thickest values and the print advice: white PLA (e.g. Bambu PLA Basic White or Jade White), standing up as built, 0.12 mm layers, 100 % infill, the walls from the print settings, a brim unless it has a foot, and an LED light behind it (not a hot bulb: PLA softens at about 60 °C). The user sees the picture and the lit preview in the Lithophane section of the Print tab.`;
}

export const lithophane: PromptMode = {
  id: 'lithophane',
  active: (m) => m.lithophane,
  system: (o) => (o.lithophane ? lithophanePrompt(o.lithophane.pictures) : ''),
  turnNotes: ({ layerToneImages, newPictures, images }) => {
    const names = Object.keys(layerToneImages);
    return [`Lithophane mode is on: make this a lithophane with H.lithophane (see the system prompt). ${newPictures.length ? `The attached photo${newPictures.length > 1 ? 's are' : ' is'} stored for it as ${newPictures.map((n) => `"${n}"`).join(', ')}.` : ''} ${names.length ? `Pictures available to H.lithophane: ${names.map((n) => `"${n}" (${layerToneImages[n].width}×${layerToneImages[n].height})`).join(', ')}.` : 'There is no picture yet: ' + (images ? 'make one with generate_picture.' : 'ask the user to attach a photo (Jig has no image model without OPENROUTER_API_KEY).')}`];
  },
};
