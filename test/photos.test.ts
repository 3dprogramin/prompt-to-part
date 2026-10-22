import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familiar, photoEditPrompt, photoProblem, photoPrompt, SHOP_SCENE, shopPlan, suggestScene, vsSwitch, type PhotoRequest } from '../shared/photos';
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
  assert.match(photoProblem(request({ aspect: '2:1' as PhotoRequest['aspect'] }))!, /aspect/);
  assert.match(photoProblem(request({ render: { mediaType: 'image/webp', data: 'x' } }))!, /PNG or JPEG/);
  assert.match(photoProblem(request({ product: { name: 'x', size: [1, 2, Infinity] } }))!, /size/);
  assert.match(photoProblem(request({ product: { name: 'x', size: [1, 2, 3], colors: ['red'] } }))!, /colors/);
  assert.match(photoProblem(request({ product: { name: 'x'.repeat(300), size: [1, 2, 3] } }))!, /name/);
  assert.match(photoProblem(null as unknown as PhotoRequest)!, /render/);
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
