# Lithophane preview widget

A drop-in web component, `<litho-preview>`, for a shop that sells photo lithophanes: the customer uploads a photo and straight away sees how the lithophane will look, lit from behind and as a 3D object they can turn. Everything runs in the customer's browser, with no server, no AI and no tokens, and the photo stays on their device until they order. On a Shopify product page the widget adds the customer's choices and the photo to the order. The same code gives the shop the print-ready STL and 3MF for each order (the [production page](#production-page-shop-only)).

It reuses Jig's lithophane engine (`shared/lithophane.ts`): the same Beer–Lambert thickness mapping, backlit colours, mesh and print settings as a lithophane designed in Jig. The widget contains no shop name and no "Jig".

- **Customer flow:** upload (file picker, drag and drop, or the phone camera) → **Frame** (shape, size, portrait/landscape, drag and pinch to pan and zoom, a brightness slider) → **Lit** (the backlit simulation) and **3D** (three.js, turned with a finger or the mouse), both with a *light on / off* switch. The live price follows the size. Photo tips appear when a picture is likely to print badly: too dark, too bright, low contrast, or too few pixels for the size.
- **Shapes:** flat panel, curved panel (an arc, 120° by default) and lamp (a full cylinder, with the frame along the top and bottom only).
- **Fast on phones:** previews use a 480 px picture and a mesh of about 170 cells along its longer side, rebuilt only when a drag ends. The production page builds at full resolution (0.2 mm by default).
- **Languages:** Romanian (default) and English (`litho/src/i18n.ts`).

## Build and run

```sh
npm run dev:litho     # http://localhost:5174/ (demo) and /production.html
npm run build:litho   # → dist-litho/
```

`dist-litho/` then holds:

| File | What it is |
| --- | --- |
| `litho-preview.js` | The component as **one classic script** with its styles inside (shadow DOM): about 600 kB minified, **155 kB gzipped**. Most of that is three.js, for the 3D view. This is the only file the shop's theme needs. |
| `index.html` | A demo page, with a stand-in product form that shows what would be sent. It loads `litho-preview.js` exactly as a theme does. |
| `production.html` + `assets/` | The shop's production page. Don't upload it to the theme. |

Jig's own `npm run build` and `dist/` are unaffected.

## Component API

```html
<script src="litho-preview.js" defer></script>
<litho-preview lang="ro" form="product-form-123" config='{"currency":"lei"}'></litho-preview>
```

| Attribute | Meaning |
| --- | --- |
| `lang` | `ro` (default) or `en`; a tag such as `en-GB` works too. |
| `config` | JSON, see below. Or put it in a child `<script type="application/json">` (easier in Liquid). |
| `variants` | Shopify variants as JSON (`{{ product.variants \| json }}`). Or put them in a child `<script type="application/json" data-variants>`. |
| `form` | The id of the product form to fill. Without it, the widget uses the form around it, or the page's first `form[action*="/cart/add"]`. |

**Config** (everything is optional; the defaults are in `litho/src/config.ts`, and their prices are examples only):

```json
{
  "currency": "lei",
  "border": 3, "minThickness": 0.8, "maxThickness": 3, "angle": 120, "stand": 0,
  "photoMaxSide": 2400,
  "sizes": [
    { "id": "flat-10x15", "shape": "flat", "width": 150, "height": 100, "price": 79, "options": ["Panou drept", "10×15 cm"] },
    { "id": "curved-13x18", "shape": "curved", "width": 180, "height": 130, "price": 115, "angle": 120 },
    { "id": "lamp-10x15", "shape": "cylinder", "width": 100, "height": 150, "variant": 44012345678901 }
  ]
}
```

- `width` × `height` is the **outer size in mm**, frame included. Flat and curved sizes are given as landscape, and the customer can turn them to portrait. A curved panel's width is measured along the arc. A lamp's `width` is its outside **diameter**: the picture wraps the full circumference. Sides are limited to 250 mm (the A1's build volume).
- `price` is shown when no Shopify variant gives one. `variant` (an id) or `options` (option values, matched loosely: case, diacritics, spaces and "10×15" vs "10x15" don't matter) link a size to a Shopify variant. The variant's price then wins, and choosing the size selects that variant in the form.
- `stand` gives a flat panel a foot, `stand` mm deep, so it stands on a shelf. It is off by default.
- `photoMaxSide` is the longest side of the photo kept in the browser and attached to the order. 2400 px is plenty: a 15 cm panel at 0.2 mm needs about 750 px.

**Light or dark:** `theme="light"` (the default), `theme="dark"`, or `theme="auto"` to follow the visitor's system setting. Set it to match the shop's theme; the demo and production pages have a switch for it (Auto → Light → Dark, remembered in the browser). **Theming** is done with CSS custom properties on the element: `--litho-accent`, `--litho-accent-text`, `--litho-font` (by default the theme's font), `--litho-bg`, `--litho-fg`, `--litho-muted`, `--litho-border`, `--litho-radius` and `--litho-stage-height`. The layout uses a container query: one column when narrow, and the preview beside the options from 720 px of widget width.

**Events and JS:** a `litho-change` event (detail `{ order, price, variant, ready }`) fires after every change. `el.order` gives the current choices as they go with the order, `el.loadFile(blob)` loads a photo, and `el.applyOrder(settings)` restores a saved order.

## Shopify setup

How it carries the order: Shopify keeps **line item properties** (inputs named `properties[Name]` inside the product form) with each cart line and in the order. A **file input** in the form is uploaded by Shopify and shows up on the order as a link to the file. The widget therefore adds these to the product form (in the page's DOM, not its shadow DOM):

| Property | Example | Seen by |
| --- | --- | --- |
| `Formă` | `Panou drept` | customer (cart, checkout, emails) and shop |
| `Dimensiune` | `10 × 15 cm (vertical)` | customer and shop |
| `Fotografie` | the photo: a JPEG of at most 2400 px, typically 0.3–1.5 MB | customer and shop (a link) |
| `_litho` | `{"v":1,"size":"flat-10x15",…,"crop":{…},"litho":{…}}` | the shop. The leading `_` marks it private, and themes and checkout hide it from the customer. |

`_litho` is everything the production page needs to rebuild exactly what the customer saw: the size, the orientation, the crop as fractions of the attached photo, and Jig's lithophane options. Property names follow the widget's language (`Shape` / `Size` / `Photo` in English); `_litho` never changes. The widget also sets the form to `multipart/form-data`, selects the size's variant (the form's `id` input), and **holds back "Add to cart" until there is a photo**, showing a message instead.

Steps (Dawn and other Online Store 2.0 themes):

1. **Product:** create *Litofanie personalizată* with two options, e.g. **Formă** (`Panou drept`, `Panou curbat`, `Lampă`) and **Dimensiune** (`10×15 cm`, `13×18 cm`, …). Give each variant its price. Leave out combinations you don't sell.
2. **Upload the script:** *Online Store → Themes → ⋯ → Edit code → Assets → Add a new asset*, then upload `dist-litho/litho-preview.js`.
3. **Product template:** *Customize →* the product page *→ Create template* (e.g. `lithophane`), and assign it to the product (*Products → the product → Theme template*). In the *Product information* section:
   - Add a **Custom Liquid** block above *Buy buttons* and paste the snippet below.
   - Remove the **Variant picker** block: the widget picks the variant, and the theme's picker would disagree with it. The theme's **Price** block doesn't follow the widget either, so remove it or leave it showing the "from" price; the widget shows the live price.
   - In **Buy buttons**, turn off **Show dynamic checkout buttons**. *Buy it now* / Shop Pay go straight to checkout and can skip the photo upload.
4. **Snippet** (the `options` must match your variants' option values):

```liquid
<script src="{{ 'litho-preview.js' | asset_url }}" defer></script>
<litho-preview lang="{{ request.locale.iso_code }}" form="product-form-{{ section.id }}"
  style="--litho-accent: #b4531a; margin: 1rem 0;">
  <script type="application/json">
  {
    "currency": "lei",
    "sizes": [
      { "id": "flat-10x15",   "shape": "flat",     "width": 150, "height": 100, "options": ["Panou drept", "10×15 cm"] },
      { "id": "flat-13x18",   "shape": "flat",     "width": 180, "height": 130, "options": ["Panou drept", "13×18 cm"] },
      { "id": "curved-10x15", "shape": "curved",   "width": 150, "height": 100, "options": ["Panou curbat", "10×15 cm"] },
      { "id": "lamp-10x15",   "shape": "cylinder", "width": 100, "height": 150, "options": ["Lampă", "Ø10×15 cm"] }
    ]
  }
  </script>
  <script type="application/json" data-variants>{{ product.variants | json }}</script>
</litho-preview>
```

   Dawn's product form has the id `product-form-{{ section.id }}`. In other themes, find the `<form action="/cart/add" …>` and use its id, or drop `form="…"`: the widget then uses the page's first add-to-cart form.
5. **Test** with a test order (*Settings → Payments →* test mode, or the Bogus gateway). Check that the order shows *Fotografie* as a link, and that `_litho` is there.
6. **Privacy:** customers' photos (often of people) are stored by Shopify. Anyone with the file's link can open it, though the link can't be guessed. Mention this in the privacy policy and delete the files after printing if you promise to.

### What needs a real store to verify

None of this could be tried without a store. It follows Shopify's documented behaviour and Dawn's code as far as known:

- **File upload through the theme's AJAX cart.** Shopify uploads file properties when the form is posted with its file. Dawn posts `new FormData(form)`, which includes the file. Themes, or cart-drawer apps, that serialise the form to JSON drop it. If the order has no photo link, turn off the cart drawer (*Cart type: Page*) or change the theme's add-to-cart code to post `FormData`.
- **File size limit:** Shopify doesn't clearly document one for line item uploads. The widget keeps the photo around 1 MB, well below any plausible limit.
- **`section.id` inside a Custom Liquid block,** and the exact form id in your theme.
- **Showing `_litho`:** private (`_`) properties are hidden by Dawn's cart and by checkout. That the admin order page shows them in full, ready to copy, is expected but should be checked; the order JSON / API has them in any case.
- **Selecting the variant:** setting the form's `id` input changes what goes into the cart, but not the theme's own price and picker, hence step 3.
- **Phones:** iOS hands HEIC photos over as JPEG through `accept="image/*"`. Filling a file input from script needs `DataTransfer` (Safari 14.1+, all current browsers).

## Production page (shop only)

`npm run dev:litho` and open `http://localhost:5174/production.html`, or serve the built `dist-litho/` (e.g. `npx vite preview -c litho/vite.config.ts`; opening it as a `file://` page won't load its script). It is not linked from anywhere and isn't part of the theme upload.

1. Paste the order's `_litho` value (with or without the `_litho:` in front).
2. Choose the order's photo (download it from the order's *Fotografie* link).
3. The customer's framing appears in the same widget, where you can check it or adjust it.
4. Pick the detail (0.2 mm by default, or 0.15 / 0.3 mm), then **Build full resolution**, then **Download STL** / **Download 3MF**. The files are named after the order number, shape and size. The page shows the size, triangle count and Jig's recommended print settings (`lithoPrint`): white PLA standing upright, 0.12 mm layers, 100 % zig-zag infill, walls enough to fill the panel solid, and a brim unless it has a foot; a lamp puts the seam at the back. It also shows the printing note.

The 3MF is a plain core-spec file (one object, millimetres) that Bambu Studio, PrusaSlicer and Cura open. The print settings aren't embedded, so set them from the page. A manual order (no `_litho`) works too: load a photo and frame it on the page.

## Code

`litho/src/`: `element.ts` (the component), `config.ts` (sizes, prices, variants), `crop.ts` (framing), `order.ts` (`_litho`), `tips.ts`, `lit.ts` (lit/unlit flat preview), `view3d.ts` (three.js), `photo.ts` (decode, downscale, crop), `shopify.ts` (the form bridge), `production.ts`, `i18n.ts` and `styles.ts`. From Jig it uses `shared/lithophane.ts`, `shared/layertone.ts` (picture helpers) and `shared/stl.ts` (the STL writer, shared with Jig's export). Unit tests are in `test/litho.test.ts`.
