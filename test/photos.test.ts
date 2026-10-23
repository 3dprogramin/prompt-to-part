import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSEUP_SCENE, familiar, IDEA_WRITER_PROMPT, ideaWriterPrompt, parseWrittenScene, PHOTO_SCENES, photoEditPrompt, photoProblem, photoPrompt, scaleRefLayout, sceneWriterPrompt, SHOP_SCENE, shopPlan, sizeVariantPrompt, subScenes, suggestScene, variantName, vsSwitch, writtenPlace, type PhotoRequest } from '../shared/photos';
import type { Vec3 } from '../shared/types';
import { requestImage } from '../server/artwork';

const request = (extra: Partial<PhotoRequest> = {}): PhotoRequest => ({
  render: { mediaType: 'image/png', data: 'iVBORw0KGgo=' },
  scene: 'table',
  aspect: '1:1',
  product: { name: 'Café coaster', description: 'Round coaster with raised lettering', size: [100, 100, 5.2] },
  ...extra,
});

test('the photo prompt keeps the object, its size and colours, and sets the scene', () => {
  const p = photoPrompt(request());
  assert.match(p, /Café coaster – Round coaster with raised lettering/);
  assert.match(p, /100 × 100 mm footprint and 5\.2 mm high/);
  assert.match(p, /about the size of a drinks coaster/, "a familiar size for the scale");
  assert.match(p, /true proportion/);
  assert.match(p, /exact colours of the render/);
  assert.match(p, /do not add, remove, move/);
  assert.match(p, /letter for letter/);
  assert.match(p, /layer lines/);
  assert.match(p, /warm oak wooden table/);
  assert.match(p, /No text, captions, logos, watermarks/);
  assert.doesNotMatch(p, /Also:/);
  assert.match(photoPrompt(request({ product: { name: 'x', size: [100, 100, 5], colors: ['#1f6f78', '#f2efe6'] } })), /filament colours #1f6f78, #f2efe6/);
  assert.doesNotMatch(p, /\n\n\n/);
  // A thin flat print (a LayerTone panel) is told to be thin; a chunky object is not.
  const panel = photoPrompt(request({ product: { name: 'Castle LayerTone', size: [200, 150, 3] }, shop: 'angle' }));
  assert.match(panel, /THIN, FLAT panel: only 3 mm thick \(about 1\.5 times as thick as a coin\)/);
  assert.match(panel, /Never show it as a thick slab/);
  assert.match(panel, /showing how thin it is/);
  assert.doesNotMatch(photoPrompt(request({ product: { name: 'Planter', size: [100, 100, 90] } })), /THIN, FLAT/);
});

test('wall scenes hang a flat print face-on; custom scenes and extra wishes go in as written', () => {
  const wall = photoPrompt(request({ scene: 'wall', product: { name: 'Plaque', size: [180, 108, 6.5], faceOn: true } }));
  assert.match(wall, /180 mm wide, 108 mm tall and 6\.5 mm thick/);
  assert.match(wall, /hangs flat on the wall/);
  assert.match(wall, /render shows its front face/);
  assert.match(wall, /paperback book/);
  const custom = photoPrompt(request({ scene: 'custom', notes: 'on a bedside table at night' }));
  assert.match(custom, /SCENE: on a bedside table at night\./);
  const extra = photoPrompt(request({ scene: 'studio', notes: 'a soft blue backdrop' }));
  assert.match(extra, /white studio sweep/);
  assert.match(extra, /Also: a soft blue backdrop\./);
});

test('a wall piece hangs on a wide, continuous wall, its size cue beside it, never overlapping', () => {
  const plaque = { name: 'Say Hello To My Little Friend', size: [160, 220, 5] as [number, number, number], faceOn: true };
  for (const scene of ['wall', 'xmas-wall']) {
    const p = photoPrompt(request({ scene, product: plaque }));
    assert.match(p, /entirely on a wide, flat, continuous stretch of wall with a wide margin of free wall on every side/);
    assert.match(p, /never crosses or touches a corner, pillar, edge, door or window frame, shelf or furniture, and nothing overlaps it/);
    assert.match(p, /beside it on the same wall, with free wall between them/);
    assert.match(p, /about 1\.9 times as wide and 2\.6 times as tall as the switch/);
  }
  const fridge = photoPrompt(request({ scene: 'fridge', product: { name: 'Magnet', size: [60, 60, 4], faceOn: true } }));
  assert.match(fridge, /continuous stretch of fridge door/);
  assert.match(fridge, /never crosses or touches an edge of the door, its handle or another magnet/);
  assert.doesNotMatch(fridge, /light switch \(/, 'no light switch on a fridge door');
  const size = photoPrompt(request({ scene: 'wall', shop: 'size', product: plaque }));
  assert.match(size, /continuous stretch of wall/);
  assert.match(size, /light switch \(about 85 mm square\) beside it on the same wall.*about 1\.9 times as wide and 2\.6 times as tall as the switch/);
  assert.doesNotMatch(photoPrompt(request()), /continuous stretch/);
});

test('the familiar size is the closest match: a flat piece by its face, anything else by its longest side', () => {
  assert.equal(familiar([160, 220, 5], true), 'about the size of a sheet of A5 paper');
  assert.equal(familiar([300, 200, 3], true), 'about the size of a sheet of A4 paper');
  assert.equal(familiar([86, 54, 2], true), 'about the size of a credit card');
  assert.equal(familiar([148, 105, 2], true), 'about the size of an A6 postcard');
  assert.equal(familiar([80, 80, 3], true), 'a bit smaller than a drinks coaster');
  assert.equal(familiar([300, 30, 3], true), 'about as long as a shoebox', 'a long strip by its length');
  assert.equal(familiar([100, 80, 60], false), 'about the size of a coffee mug');
  assert.equal(familiar([400, 300, 200], false), 'a bit larger than a shoebox');
  assert.match(familiar([20, 15, 10], false), /coin, tiny next to a hand/);
  assert.equal(vsSwitch([160, 220, 5], true), 'it is about 1.9 times as wide and 2.6 times as tall as the switch');
  assert.equal(vsSwitch([160, 220, 5], false), 'its longest side is about 2.6 times the width of the switch');
});

test('the suggested scene follows what the design is', () => {
  assert.equal(suggestScene('Home sweet home wall plaque'), 'wall');
  assert.equal(suggestScene('LayerTone portrait of a dog'), 'wall');
  assert.equal(suggestScene('Café coaster. Round drinks coaster'), 'table');
  assert.equal(suggestScene('Pen holder for the desk'), 'office');
  assert.equal(suggestScene('Ribbed bud vase'), 'shelf');
  assert.equal(suggestScene('Spice jar rack'), 'kitchen');
  assert.equal(suggestScene('Bird feeder'), 'garden');
  assert.equal(suggestScene('Name keychain'), 'hand');
  assert.equal(suggestScene('Widget', [30, 20, 10]), 'hand', 'small things in a hand');
  assert.equal(suggestScene('Widget', [150, 80, 60]), 'table');
  assert.equal(suggestScene('NFC fridge magnet'), 'fridge');
  assert.equal(suggestScene('Toothbrush holder'), 'bathroom');
  assert.equal(suggestScene('Pegboard wrench holder'), 'workshop');
  assert.equal(suggestScene('Controller stand'), 'gaming');
  assert.equal(suggestScene('Car vent phone mount'), 'wall', 'a mount still goes on the wall first');
  assert.equal(suggestScene('Restaurant table number'), 'restaurant');
  assert.equal(suggestScene('Snowflake Christmas Ornament'), 'xmas-tree');
  assert.equal(suggestScene('Bauble with a name'), 'xmas-tree');
  assert.equal(suggestScene('Santa sleigh line art'), 'xmas-wall');
  assert.equal(suggestScene('Gingerbread house figurine'), 'xmas-gifts');
  assert.equal(suggestScene('Ornament stand for a shelf'), 'shelf', 'not Christmas without a Christmas word');
});

test('photo requests are checked', () => {
  assert.equal(photoProblem(request()), null);
  assert.equal(photoProblem(request({ scene: 'custom', notes: 'on a boat' })), null);
  assert.match(photoProblem(request({ scene: 'custom' }))!, /custom scene/);
  assert.match(photoProblem(request({ scene: 'moon' }))!, /scene must be one of/);
  assert.equal(photoProblem(request({ variant: 2 })), null);
  assert.equal(photoProblem(request({ variant: 'random', sceneText: 'on a slate shelf' })), null);
  assert.equal(photoProblem(request({ variant: 'random' })), null, 'no scene written: the image model invents one');
  assert.match(photoProblem(request({ variant: 4 as PhotoRequest['variant'] }))!, /variant/);
  assert.match(photoProblem(request({ scene: 'custom', notes: 'on a boat', variant: 2 }))!, /variant/);
  assert.match(photoProblem(request({ variant: 2, sceneText: 'on a slate shelf' }))!, /sceneText/);
  assert.match(photoProblem(request({ variant: 'random', sceneText: 'x'.repeat(601) }))!, /sceneText/);
  assert.match(photoProblem(request({ variant: 'random', sceneText: '  ' }))!, /sceneText/);
  assert.match(photoProblem(request({ aspect: '2:1' as PhotoRequest['aspect'] }))!, /aspect/);
  assert.match(photoProblem(request({ render: { mediaType: 'image/webp', data: 'x' } }))!, /PNG or JPEG/);
  assert.match(photoProblem(request({ product: { name: 'x', size: [1, 2, Infinity] } }))!, /size/);
  assert.match(photoProblem(request({ product: { name: 'x', size: [1, 2, 3], colors: ['red'] } }))!, /colors/);
  assert.match(photoProblem(request({ product: { name: 'x'.repeat(300), size: [1, 2, 3] } }))!, /name/);
  assert.match(photoProblem(null as unknown as PhotoRequest)!, /render/);
});

test('every scene has 3 sub-scenes: 1 is the scene as it was, 2 and 3 others of the same kind', () => {
  for (const preset of PHOTO_SCENES) {
    const subs = subScenes(preset.id);
    assert.equal(subs.length, 3, preset.id);
    assert.equal(subs[0].scene, preset.scene, `${preset.id}: sub-scene 1 is the scene as it was`);
    for (const s of subs) assert.ok(s.name.trim() && s.scene.trim().length > 40, `${preset.id}: ${s.name}`);
    assert.equal(new Set(subs.map((s) => s.scene)).size, 3, `${preset.id}: three different scenes`);
    // What a scene relies on stays: a wall to hang on, a branch, a clean studio.
    if (preset.wall) for (const s of subs) assert.match(s.scene, /wide.*(wall|door)/, `${preset.id}: ${s.name}`);
    if (preset.hang) for (const s of subs) assert.match(s.scene, /hanging from a branch/, `${preset.id}: ${s.name}`);
    if (preset.studio) for (const s of subs) assert.match(s.scene, /studio sweep/, `${preset.id}: ${s.name}`);
  }
  assert.deepEqual(subScenes('custom'), []);
  assert.equal(variantName('wall', 2), 'Scandinavian, warm white');
  assert.equal(variantName('wall', 'random'), 'Random');
});

test('the photo prompt uses the chosen sub-scene; a random one as written, or invented by the image model', () => {
  const wall = (extra: Partial<PhotoRequest> = {}) => photoPrompt(request({ scene: 'wall', product: { name: 'Plaque', size: [180, 108, 6.5], faceOn: true }, ...extra }));
  assert.equal(wall({ variant: 1 }), wall(), 'sub-scene 1 is the scene as it was');
  for (const v of [2, 3] as const) {
    const p = wall({ variant: v });
    assert.ok(p.includes(`SCENE: ${subScenes('wall')[v - 1].scene}.`));
    assert.match(p, /entirely on a wide, flat, continuous stretch of wall/, 'the wall rules stay');
  }
  const written = 'hanging on a wide, plain lime-washed wall in a Tuscan farmhouse living room, soft morning light';
  assert.ok(wall({ variant: 'random', sceneText: written }).includes(`SCENE: ${written}.`));
  const invented = wall({ variant: 'random' });
  assert.match(invented, /SCENE: invent a fresh setting of this kind: a living-room wall.*different from all of these: \(1\) Modern, light painted wall, \(2\) Scandinavian, warm white, \(3\) Classic, sage green wall\./);
  // A change of a random photo keeps its scene: the one written, or the earlier photo's.
  const from = { photo: '/api/designs/test-1234/images/0123456789abcdef0123456789abcdef.png', render: '/api/designs/test-1234/images/fedcba9876543210fedcba9876543210.png' };
  assert.ok(photoEditPrompt(request({ scene: 'wall', variant: 'random', sceneText: written, from, change: 'warmer' })).includes(`SCENE: ${written}.`));
  assert.match(photoEditPrompt(request({ scene: 'wall', variant: 'random', from, change: 'warmer' })), /SCENE: the same setting as in the earlier photo/);
  // What Claude is asked for, and its answer cleaned up.
  const ask = sceneWriterPrompt('wall', () => 0);
  assert.match(ask, /kind of place: a living-room wall/);
  for (const s of subScenes('wall')) assert.ok(ask.includes(s.scene));
  assert.match(ask, /a Japandi look, soft morning light/);
  assert.match(sceneWriterPrompt('studio', () => 0), /a warm sand tone/);
  // A small piece's random setting is written for its size, and its photo is framed in numbers.
  assert.match(sceneWriterPrompt('wall', () => 0, [250, 186.6, 2.2]), /The product is small: 250 × 187 × 2\.2 mm .*no whole room, sofa or big furniture in full view, mostly plain wall around it/);
  assert.doesNotMatch(sceneWriterPrompt('wall', () => 0), /The product is small/);
  assert.match(photoPrompt(request({ scene: 'wall', product: { name: 'Castle', size: [250, 186.6, 2.2], faceOn: true } })), /shows only about 65 cm of wall from side to side, so it fills about 38% of the width/);
  assert.equal(parseWrittenScene('  "on a slate shelf,  dim light."\n'), 'on a slate shelf, dim light');
  assert.throws(() => parseWrittenScene(' "" '), /did not write/);
});

test('your idea: Jig writes it out for the product (a wall piece on a plain wall), the photo keeps it; custom stays as written', () => {
  // What Claude is asked for: the idea, the product, the presets' style, where it goes and its size.
  const wallAsk = ideaWriterPrompt({ idea: 'cosy cabin, snowy evening', suggested: 'wall', product: 'Castle LayerTone' }, [250, 186.6, 2.2]);
  assert.match(wallAsk, /The idea: "cosy cabin, snowy evening"\.\nThe product: Castle LayerTone\./);
  assert.ok(wallAsk.includes(`1. ${subScenes('wall')[0].scene}`), 'the suggested scene as the first example');
  assert.match(wallAsk, /wall piece, shown face-on: it hangs flat against the wall .* wide, plain, flat stretch of wall.*begin with "hanging"/);
  assert.match(wallAsk, /Only if the idea clearly asks for it to be held/);
  assert.match(wallAsk, /The product is small: 250 × 187 × 2\.2 mm .*mostly plain wall around it/);
  const tableAsk = ideaWriterPrompt({ idea: 'pe o masă de bucătărie', suggested: 'kitchen' }, [600, 300, 200]);
  assert.match(tableAsk, /rests on a surface .*begin with "on"/);
  assert.match(tableAsk, /Only if the idea clearly asks for it to hang on a wall/);
  assert.match(tableAsk, /in English, whatever language/);
  assert.doesNotMatch(tableAsk, /The product is small|The product:/);
  assert.match(IDEA_WRITER_PROMPT, /no people other than a hand if the idea asks for one, and no text, signs, logos or screens/);
  assert.equal(writtenPlace('Hanging flat on a log wall'), 'wall');
  assert.equal(writtenPlace('held in a person\'s hand by a window'), 'hand');
  assert.equal(writtenPlace('on a pine table'), 'surface');
  // The photo uses the scene as written out, with the wall rules when it hangs; without one, the idea as written.
  const panel = { name: 'Castle LayerTone', size: [250, 186.6, 2.2] as [number, number, number], faceOn: true };
  const written = 'hanging on a wide, plain stretch of pale pine log wall in a cosy cabin, snow falling past a window softly blurred to the side, warm evening lamp light';
  const p = photoPrompt(request({ scene: 'idea', notes: 'cosy cabin, snowy evening', sceneText: written, product: panel }));
  assert.ok(p.includes(`SCENE: ${written}.`));
  assert.match(p, /entirely on a wide, flat, continuous stretch of wall/);
  assert.match(p, /it hangs flat on the wall with this face to the viewer/);
  assert.doesNotMatch(p, /cosy cabin, snowy evening|Also:|rests ON the surface/);
  const held = photoPrompt(request({ scene: 'idea', notes: 'in a hand', sceneText: 'held in a person\'s hand, a soft blurred garden behind' }));
  assert.match(held, /Against the hand:/);
  assert.match(photoPrompt(request({ scene: 'idea', notes: 'cosy cabin, snowy evening' })), /SCENE: cosy cabin, snowy evening\.\n.*rests ON the surface/s);
  // A change or another size keeps the scene as written (and a custom scene stays the scene).
  const from = { photo: '/api/designs/test-1234/images/0123456789abcdef0123456789abcdef.png' };
  assert.ok(photoEditPrompt(request({ scene: 'idea', notes: 'cosy cabin', sceneText: written, from, change: 'warmer', product: panel })).includes(`SCENE: ${written}.`));
  const customEdit = photoEditPrompt(request({ scene: 'custom', notes: 'on a boat', from, change: 'warmer' }));
  assert.match(customEdit, /SCENE: on a boat\./);
  assert.doesNotMatch(customEdit, /undefined|Earlier wishes/);
  assert.match(photoPrompt(request({ scene: 'custom', notes: 'on a boat', sceneText: 'ignored' })), /SCENE: on a boat\./, 'custom goes in as written');
  // Checked like a custom scene: the idea is needed, a scene written for it is kept.
  assert.equal(photoProblem(request({ scene: 'idea', notes: 'cosy cabin', sceneText: written })), null);
  assert.equal(photoProblem(request({ scene: 'idea', notes: 'cosy cabin' })), null, 'Jig could not write it out: the idea as written');
  assert.match(photoProblem(request({ scene: 'idea' }))!, /your idea/);
  assert.match(photoProblem(request({ scene: 'idea', notes: 'x'.repeat(601) }))!, /notes/);
  assert.match(photoProblem(request({ scene: 'idea', notes: 'cosy cabin', variant: 2 }))!, /variant/);
  assert.match(photoProblem(request({ scene: 'idea', notes: 'cosy cabin', sceneText: 'x'.repeat(601) }))!, /sceneText/);
  assert.match(photoProblem(request({ scene: 'custom', notes: 'on a boat', sceneText: written }))!, /sceneText/);
});

test('a photo made again with a change: its photo is the scene, the product from its render or a new angle', () => {
  const from = { photo: '/api/designs/abcdefgh-1234/images/0123456789abcdef0123456789abcdef.png', render: '/api/designs/abcdefgh-1234/images/fedcba9876543210fedcba9876543210.png' };
  const { render: _r, ...noRender } = request();
  assert.equal(photoProblem({ ...noRender, from, change: 'add a plant behind it' }), null);
  assert.equal(photoProblem({ ...request(), from, change: 'seen from lower' }), null, 'a new angle may come with it');
  assert.match(photoProblem({ ...noRender, from, change: ' ' })!, /change/);
  assert.match(photoProblem({ ...noRender, from: { photo: 'https://example.com/x.png' }, change: 'x' })!, /from/);
  assert.match(photoProblem(noRender)!, /render/);
  const p = photoEditPrompt({ ...noRender, from, change: 'add a plant behind it', notes: 'evening light' });
  assert.match(p, /THE PHOTO TO CHANGE: the second attached picture is an earlier photo/);
  // A small fix keeps the rest of the photo; recomposing only when the change asks for it.
  assert.match(p, /everything the change does not ask for stays exactly as in that photo \(the composition and framing, where the product and each of its pieces are, their size and angle in the frame/);
  assert.match(p, /keep the earlier photo instead/);
  assert.match(p, /If the change asks to move, spread, turn or recompose things/);
  assert.doesNotMatch(p, /afresh/);
  assert.match(p, /The product still matches the render \(the first attached picture\) exactly/);
  assert.doesNotMatch(p, /new render/);
  assert.match(p, /THE CHANGE \(the reason for the new photo – make it clearly\): add a plant behind it\./);
  assert.match(p, /Earlier wishes that still apply: evening light\./);
  assert.match(p, /KEEP THE OBJECT EXACTLY AS IN THE RENDER/);
  assert.match(photoPrompt(request()), /rests ON the surface, not above it/);
  // A new render (the design updated, or the view turned): only the product changes, on the same spot.
  const updated = photoEditPrompt({ ...request(), from: { photo: from.photo }, change: 'The design was updated since the earlier photo: show the product exactly as in the new render' });
  assert.match(updated, /The first attached picture is a new render of the product: show the product as in it \(its design and the angle it is seen from\), on the same spot in the scene/);
  assert.match(updated, /THE PHOTO TO CHANGE/);
});

test('an ornament on the tree hangs face-on from a ribbon, the only thing added', () => {
  const p = photoPrompt(request({ scene: 'xmas-tree', product: { name: 'Snowflake ornament', size: [80, 80, 3], faceOn: true } }));
  assert.match(p, /Christmas tree/);
  assert.match(p, /render shows its front face; it hangs with this face to the viewer/);
  assert.match(p, /only the thin ribbon it hangs from/);
  assert.match(p, /hangs freely from the branch on a thin red ribbon/);
  // A set of ornaments: each on its own ribbon, never tied into one piece.
  assert.match(p, /several separate pieces \(a set\), they stay separate pieces.*never join, link, chain or tie them/);
  assert.match(p, /each piece on its own ribbon from its own branch/);
  assert.doesNotMatch(p, /rests ON the surface/);
  assert.doesNotMatch(p, /hangs flat on the wall/);
  const gifts = photoPrompt(request({ scene: 'xmas-gifts' }));
  assert.match(gifts, /under a Christmas tree/);
  assert.match(gifts, /rests ON the surface/);
  assert.doesNotMatch(gifts, /ribbon it hangs from/);
  assert.match(photoPrompt(request({ scene: 'xmas-wall', product: { name: 'Sign', size: [300, 200, 3], faceOn: true } })), /hangs flat against the wall/);
});

test('the grey studio: a light grey sweep, studio light, everything sharp; the white studio as it was', () => {
  const grey = photoPrompt(request({ scene: SHOP_SCENE }));
  assert.match(grey, /seamless light grey \(#F3F3F3\) studio sweep/);
  assert.match(grey, /no props/);
  assert.match(grey, /soft, natural contact shadow/);
  assert.match(grey, /same backdrop, light and camera for every product/);
  assert.match(grey, /e-commerce studio product photo/);
  assert.doesNotMatch(grey, /background softly blurred/);
  const white = photoPrompt(request({ scene: 'studio' }));
  assert.match(white, /pure white studio sweep/);
  assert.match(white, /lifestyle product photo/);
});

test('a shop set: 5 square shots, each from its own angle; flat prints face-on, a close-up and at an angle', () => {
  const pick = (plan: ReturnType<typeof shopPlan>) => plan.map((x) => `${x.shot}:${x.camera}:${x.scene}:${x.faceOn ? 'face' : '-'}`);
  assert.deepEqual(pick(shopPlan({ size: [100, 80, 60], suggested: 'office' })),
    [`main:front:${SHOP_SCENE}:-`, `angle:angle:${SHOP_SCENE}:-`, `top:top:${SHOP_SCENE}:-`, 'lifestyle:angle:office:-', 'size:angle:hand:-']);
  // A wall piece: face-on, at an angle that shows its thickness, a close-up; its size on the wall.
  assert.deepEqual(pick(shopPlan({ size: [300, 200, 4], suggested: 'wall' })),
    [`main:face:${SHOP_SCENE}:face`, `angle:angle:${SHOP_SCENE}:-`, `detail:detail:${SHOP_SCENE}:face`, 'lifestyle:face:wall:face', 'size:face:wall:face']);
  // A small flat thing suggested in a hand: the lifestyle photo on a table instead of a second hand.
  assert.deepEqual(pick(shopPlan({ size: [40, 30, 4], suggested: 'hand' })).slice(3), ['lifestyle:angle:table:-', 'size:angle:hand:-']);
  // An ornament hangs face-on on the tree; its size in a hand.
  assert.deepEqual(pick(shopPlan({ size: [80, 80, 3], suggested: 'xmas-tree' })).slice(3), ['lifestyle:face:xmas-tree:face', 'size:angle:hand:-']);
  // Too big to hold up: next to a mug.
  assert.equal(shopPlan({ size: [400, 300, 200], suggested: 'table' })[4].scene, 'table');
});

test('the close-up: a macro shot that keeps the close crop, in 3 sub-scenes and a random one', () => {
  const close = photoPrompt(request({ scene: CLOSEUP_SCENE }));
  assert.match(close, /A CLOSE-UP PHOTO: taken from close by/);
  assert.match(close, /keep that close crop/);
  assert.match(close, /100 mm macro lens/);
  assert.doesNotMatch(close, /frame the photo around it|85 mm lens/);
  assert.match(photoPrompt(request({ scene: CLOSEUP_SCENE, variant: 2 })), /SCENE: a close-up on a dark matte slate surface/);
  assert.match(photoPrompt(request({ scene: CLOSEUP_SCENE, variant: 'random' })), /invent a fresh setting of this kind: a close-up/);
  assert.match(sceneWriterPrompt(CLOSEUP_SCENE, () => 0), /The kind of place: a close-up/);
  assert.doesNotMatch(photoPrompt(request()), /CLOSE-UP|macro/);
  assert.equal(photoProblem(request({ scene: CLOSEUP_SCENE, variant: 3 })), null);
});

test('a shop photo says what its shot shows', () => {
  const shop = (shot: PhotoRequest['shop'], scene = SHOP_SCENE, faceOn = false) => photoPrompt(request({ scene, shop: shot, product: { name: 'Sign', size: [180, 108, 4], faceOn } }));
  assert.match(shop('main'), /THE MAIN LISTING PHOTO: the whole product centred/);
  assert.match(shop('angle'), /3\/4 VIEW/);
  assert.match(shop('top'), /HIGH VIEW FROM ABOVE/);
  const main = shop('main', SHOP_SCENE, true);
  assert.match(main, /lies flat on the surface, face up, photographed from almost straight above/);
  assert.doesNotMatch(main, /keep it in the same orientation/);
  const detail = shop('detail', SHOP_SCENE, true);
  assert.match(detail, /CLOSE-UP DETAIL PHOTO/);
  assert.match(detail, /goes on past the edges of the picture/);
  assert.doesNotMatch(detail, /frame the photo around it/);
  const size = shop('size', 'wall', true);
  assert.match(size, /SIZE PHOTO FOR THE LISTING: a standard white light switch/);
  assert.doesNotMatch(size, /It is a small piece for a wall/, 'the size line says it once');
  assert.match(size, /beside it on the same wall, with free wall between them/);
  assert.match(size, /about 2\.1 times as wide and 1\.3 times as tall as the switch/, 'the ratio to the switch');
  assert.match(shop('size', 'hand'), /the hand shows how big it is: its longest side is about 0\.9 times the length of an adult hand \(190 mm\) and 2\.1 times the width of its palm/);
  assert.match(shop('size', 'table'), /coffee mug \(about 95 mm tall\) beside it, both fully in view; its longest side is about 1\.9 times the mug's height, so/);
  assert.match(photoPrompt(request({ scene: 'table', shop: 'size', product: { name: 'Box', size: [400, 300, 200] } })), /its longest side is about 4\.2 times the mug's height and it stands about 2\.1 times as tall as the mug/);
  assert.doesNotMatch(shop('lifestyle', 'office'), /LISTING:|LISTING PHOTO/);
  assert.doesNotMatch(photoPrompt(request()), /LISTING PHOTO|SIZE PHOTO/);
  assert.equal(photoProblem(request({ shop: 'main' })), null);
  assert.match(photoProblem(request({ shop: 'hero' as PhotoRequest['shop'] }))!, /shop must be one of/);
});

test('a larger picture is asked for as image_size; a model that refuses it draws at its default size', async () => {
  const saved = { fetch: globalThis.fetch, key: process.env.OPENROUTER_API_KEY, fallback: process.env.JIG_IMAGE_FALLBACK };
  const sent: Record<string, unknown>[] = [];
  const picture = { choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] } }], usage: { cost: 0.1 } };
  let refuse = false;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    sent.push(body.image_config);
    if (body.messages[0].content === 'no') return new Response(JSON.stringify({ error: { message: 'Bad request' } }), { status: 400 });
    if (refuse && body.image_config.image_size) return new Response(JSON.stringify({ error: { message: 'image_size is not supported' } }), { status: 400 });
    return new Response(JSON.stringify(picture), { status: 200 });
  }) as typeof fetch;
  try {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.JIG_IMAGE_FALLBACK = '';
    await requestImage('a cup', '1:1', undefined);
    assert.deepEqual(sent, [{ aspect_ratio: '1:1' }], 'the default size unless asked');
    sent.length = 0;
    const out = await requestImage('a cup', '1:1', undefined, undefined, undefined, '2K');
    assert.deepEqual(sent, [{ aspect_ratio: '1:1', image_size: '2K' }]);
    assert.equal(out.cost, 0.1);
    sent.length = 0;
    refuse = true;
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal((await requestImage('a cup', '1:1', undefined, undefined, undefined, '2K')).image.mediaType, 'image/png');
      assert.deepEqual(sent, [{ aspect_ratio: '1:1', image_size: '2K' }, { aspect_ratio: '1:1' }]);
      // Any other refusal still fails, after the one try at the default size.
      sent.length = 0;
      await assert.rejects(requestImage('no', '1:1', undefined, undefined, undefined, '2K'), /The image model refused: Bad request/);
      assert.equal(sent.length, 2);
    } finally {
      console.warn = warn;
    }
  } finally {
    globalThis.fetch = saved.fetch;
    for (const [k, v] of [['OPENROUTER_API_KEY', saved.key], ['JIG_IMAGE_FALLBACK', saved.fallback]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('the bedroom wall hangs a flat print face-on above the bed, and variant 2 uses its sub-scene', () => {
  const bw = (extra: Partial<PhotoRequest> = {}) => photoPrompt(request({ scene: 'bedroom-wall', product: { name: 'Plaque', size: [180, 108, 6.5], faceOn: true }, ...extra }));
  assert.match(bw(), /hangs flat on the wall/);
  assert.match(bw(), /render shows its front face/);
  assert.match(bw(), /entirely on a wide, flat, continuous stretch of wall/);
  assert.ok(bw({ variant: 2 }).includes(`SCENE: ${subScenes('bedroom-wall')[1].scene}.`));
});

test('a size photo\'s render: the light switch or mug beside the product at true size, in a frame of known size', () => {
  // The Lady with wine wall piece (116.6 × 250 × 2 mm), face-on in a square render.
  const lady = { min: [10, 20, 0] as Vec3, max: [126.6, 270, 2] as Vec3 };
  const { ref, frame } = scaleRefLayout('switch', lady, 1);
  const w = (b: { min: Vec3; max: Vec3 }, k: number) => +(b.max[k] - b.min[k]).toFixed(9);
  // An 85 mm plate on the wall, its centre a third of the way up the piece, 0.5 to 1 piece width to its right.
  assert.deepEqual([w(ref, 0), w(ref, 1), w(ref, 2)], [85, 85, 10]);
  assert.equal(ref.min[2], 0, 'on the wall, the piece\'s back');
  assert.ok(Math.abs((ref.min[1] + ref.max[1]) / 2 - (20 + 250 / 3)) < 1e-9);
  const gap = ref.min[0] - lady.max[0];
  assert.ok(gap >= 0.5 * 116.6 && gap <= 116.6, `gap ${gap}`);
  // The frame: a square of wall around both, with free wall on every side.
  assert.ok(Math.abs(w(frame, 0) - w(frame, 1)) < 1e-9);
  for (const b of [lady, ref]) for (const k of [0, 1]) assert.ok(frame.min[k] < b.min[k] && frame.max[k] > b.max[k]);
  // In the render the switch is about a third of the piece's height, as on a real wall.
  const share = (mm: number) => mm / w(frame, 1);
  assert.ok(Math.abs(share(85) / share(250) - 0.34) < 1e-9);
  assert.ok(share(250) > 0.55 && share(250) < 0.75, `the piece fills ${share(250)} of the height`);
  // A wide picture: the same wall area, wider.
  const wide = scaleRefLayout('switch', lady, 16 / 9).frame;
  assert.ok(Math.abs(w(wide, 0) / w(wide, 1) - 16 / 9) < 1e-9);
  assert.ok(Math.abs(w(wide, 1) - 250 / 0.7) < 1e-6, 'its height from the piece\'s');

  // Another sale size from that photo: the switch on its spot and the same frame; only the piece shrinks.
  const centre = (b: { min: Vec3; max: Vec3 }) => [0, 1].map((k) => (b.min[k] + b.max[k]) / 2);
  const small = { min: [29.4, 61.7, 0] as Vec3, max: [107.2, 228.3, 2] as Vec3 };
  assert.deepEqual(centre(small), centre(lady));
  const s = scaleRefLayout('switch', small, 1, { base: [116.6, 250, 2] });
  assert.deepEqual(s.ref, ref);
  assert.deepEqual(s.frame, frame);
  // A bigger size: the switch moves out of its way and the frame grows to fit.
  const big = { min: [-48.3, -105, 0] as Vec3, max: [184.9, 395, 2] as Vec3 };
  const b = scaleRefLayout('switch', big, 1, { base: [116.6, 250, 2] });
  assert.ok(b.ref.min[0] >= big.max[0] + 30 - 1e-9, '30 mm of free wall at least');
  for (const k of [0, 1]) assert.ok(b.frame.min[k] <= frame.min[k] && b.frame.max[k] >= frame.max[k] && b.frame.min[k] < big.min[k] && b.frame.max[k] > big.max[k]);

  // A mug on the table beside a big box, along the render's right: as far from the camera as the box.
  const box = { min: [0, 0, 0] as Vec3, max: [400, 300, 200] as Vec3 };
  const side: [number, number] = [1 / Math.hypot(1, 0.55), 0.55 / Math.hypot(1, 0.55)];
  const mug = scaleRefLayout('mug', box, 1, { side });
  assert.deepEqual([w(mug.ref, 0), w(mug.ref, 1), w(mug.ref, 2)], [82, 82, 95]);
  assert.equal(mug.ref.min[2], 0, 'standing on the table');
  const [mx, my] = centre(mug.ref), [bx, by] = centre(box);
  assert.ok(Math.abs((mx - bx) * -side[1] + (my - by) * side[0]) < 1e-9, 'not nearer the camera than the box');
  assert.ok(mug.ref.min[0] > box.max[0], 'clear of the box');
  for (const k of [0, 1, 2]) assert.ok(mug.frame.min[k] < Math.min(box.min[k], mug.ref.min[k]) + 1e-9 && mug.frame.max[k] > Math.max(box.max[k], mug.ref.max[k]));
});

test('a render with the light switch or mug at true size: the prompt keeps them as they are, the shop set\'s size photo has one', () => {
  const plan = (size: Vec3, suggested: string) => shopPlan({ size, suggested }).find((x) => x.shot === 'size')!;
  assert.equal(plan([116.6, 250, 2], 'wall').scaleRef, 'switch');
  assert.equal(plan([400, 300, 200], 'table').scaleRef, 'mug');
  assert.equal(plan([60, 40, 20], 'office').scaleRef, undefined, 'a small thing: in a hand');
  // The size photo beside a switch, the lifestyle one at true scale on its wall alone, the 3/4 view on a plain wall from the side.
  assert.deepEqual(shopPlan({ size: [116.6, 250, 2], suggested: 'wall' }).filter((x) => x.scaleRef).map((x) => [x.shot, x.scaleRef]), [['angle', 'wall'], ['lifestyle', 'wall'], ['size', 'switch']]);
  assert.match(photoPrompt(request({ scene: SHOP_SCENE, shop: 'angle', scaleRef: 'wall', product: { name: 'Lady with wine', size: [116.6, 250, 2] } })), /it hangs flat on the plain light studio wall of the render, upright, seen from the side/);
  const alone = scaleRefLayout('wall', { min: [0, 0, 0], max: [116.6, 250, 2] }, 1).frame;
  assert.ok(Math.abs(250 / (alone.max[1] - alone.min[1]) - 0.45) < 0.01, 'on its wall alone, the piece 45 % of the picture high');
  assert.match(photoPrompt(request({ scene: 'wall', shop: 'lifestyle', scaleRef: 'wall', product: { name: 'Lady with wine', size: [116.6, 250, 2], faceOn: true } })), /The picture shows only about 556 mm of wall across \(a light switch, 85 mm, would be about 15 % of its width\)/);

  const lady = request({ scene: 'wall', shop: 'size', scaleRef: 'switch', product: { name: 'Lady with wine', size: [116.6, 250, 2], faceOn: true } });
  const p = photoPrompt(lady);
  assert.match(p, /A SIZE PHOTO FOR THE LISTING: the render already shows it at its true size, on the wall beside a standard white light switch \(85 mm square\)\. Keep the product and the switch exactly where they are and exactly as large as in the render/);
  assert.match(p, /the switch stays a switch of that size/);
  assert.match(p, /about 1\.4 times as wide and 2\.9 times as tall as the switch/);
  assert.match(p, /the plain wall and the white switch in the render are not part of the product/);
  assert.match(p, /framed as in the render/);
  assert.doesNotMatch(p, /grey background|frame the photo around it|beside it on the same wall, with free wall/);
  // Without it (an older photo's render), as before.
  assert.match(photoPrompt({ ...lady, scaleRef: undefined }), /a standard white light switch \(about 85 mm square\) beside it on the same wall/);
  // A wall photo with the switch asked for: no shop line, the true size line instead of the small piece's.
  const wall = photoPrompt({ ...lady, shop: undefined });
  assert.match(wall, /\nThe render already shows it at its true size, on the wall beside/);
  assert.doesNotMatch(wall, /SIZE PHOTO|It is a small piece for a wall/);
  const mug = photoPrompt(request({ scene: 'table', shop: 'size', scaleRef: 'mug', product: { name: 'Box', size: [400, 300, 200] } }));
  assert.match(mug, /on the surface beside a plain white coffee mug \(82 mm across, 95 mm tall\)\. Keep the product and the mug exactly where/);
  assert.match(mug, /the plain surface and the white mug in the render/);
  // Another size from that photo: its render shows the same switch on the same spot.
  const l = sizeVariantPrompt({ ...lady, from: { photo: '/api/designs/abcdefgh-1234/images/0123456789abcdef0123456789abcdef.png' }, resize: { base: { label: 'M', size: [77.7, 166.7, 2] } } });
  assert.match(l, /shows it beside the same light switch, on the same spot and in the same framing as the earlier photo/);
  assert.match(l, /In the earlier photo the product was 0\.91x as wide as the light switch/);
  for (const t of [p, wall, mug]) for (const line of t.split('\n').filter((l) => /true size/.test(l))) assert.doesNotMatch(line, /[\u2013\u2014]/, 'plain hyphens in the new lines');
  assert.equal(photoProblem(lady), null);
  assert.match(photoProblem({ ...lady, scaleRef: 'hand' as PhotoRequest['scaleRef'] })!, /scaleRef must be one of switch, mug, wall/);
});

test('an open cut-out (line art): the prompt keeps the areas between its lines empty, no backing plate', () => {
  const open = photoPrompt(request({ scene: SHOP_SCENE, shop: 'detail', product: { name: 'Lady with wine', size: [116.6, 250, 2], faceOn: true, open: true } }));
  assert.match(open, /it is an OPEN CUT-OUT: only its lines are material/);
  assert.match(open, /never add a backing panel, board or plate behind or under it/);
  assert.doesNotMatch(photoPrompt(request({ scene: SHOP_SCENE, product: { name: 'Coaster', size: [90, 90, 4], faceOn: true } })), /OPEN CUT-OUT/);
  assert.match(photoProblem(request({ scene: SHOP_SCENE, product: { name: 'x', size: [1, 1, 1], open: 'yes' as unknown as boolean } }))!, /product.open/);
});

