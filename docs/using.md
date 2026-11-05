# Using prompt-to-part

Designs and versions, the chat, the viewer, print settings, cost and export. Back to the [README](../README.md).

## Designs and versions

- **Designs menu:** your designs, most recent first (starred ones marked), 10 at a time with *Load more*. Type in its search box to list only the designs whose name contains the text – case and accents don't matter, Enter opens the first match.
- **Tags:** mark designs as **Product** (live or planned in your shop, green) or **Temp** (a throwaway test, dashed), or give them your own tags (e.g. *Ornamente*); a design can have several, up to 12. Set them with the tag button in a Designs menu row or next to the open design's name. The chips at the top of the menu show only one tag, the starred designs or the designs without a tag; the list can be sorted by last change, age or name. While the menu shows *Temp*, new designs get the Temp tag too (once they are saved). Tags are kept in `data/tags.json` (like the stars in `data/starred.json`), so tagging never changes a design, and they are in the backup zip.
- **Bulk actions:** tick designs in the Designs menu (shift-click ticks a range; the box at the top ticks every design listed, also those under *Load more*) to star, unstar, tag or delete them together. Deleting asks once and names them; designs with a reply running are left alone. To clear out tests: show *Temp*, tick the top box, *Delete*.
- **Tabs:** designs you open appear as tabs in the top bar, so parallel generations are one click apart. A spinner marks designs with a reply running, and a dot marks ones that finished while you were looking at another. *Close all* closes every tab except designs with a reply running (nothing is deleted). Every saved design is in *Designs*. Right-click the logo to start a new design in a new browser tab.
- **Versions:** click *v2 of 5* in the top bar to jump to any version. Gold versions are generated or your own code edits, blue ones are settings you saved. A design has one chat and one Claude session: after you jump back, the next reply knows which version you are on and works from it, and its new version is added at the end. To start over from a version without that history, use the branch button next to it (*New design from vN*): a new design with that version's script and settings, an empty chat and its own Claude session (handy for product variants). The original design stays as it is.
- **Code (Code tab):** edit `model.js` by hand, with syntax colours, and *Apply* it (Ctrl+S) to make a new version. Edits you haven't applied stay there while you look at other tabs or designs.
- **Saved settings:** when your sliders, scale, text, SVG drawings or print overrides differ from the current version, *Save as vN* appears next to it and stores them as a new version. Restoring a version brings its settings back; switching versions with unsaved changes asks whether to save them, discard them or cancel.
- **Autosave:** every change is saved to `data/designs/<id>.json` about half a second later, even if you open another design right away. There is one file per design, overwritten; autosave never creates versions.
  - If a save fails, *Not saved – retry* appears in the top bar. The unsaved copy stays in memory if you open another design, so coming back and retrying saves your changes.
  - Closing the page with unsaved changes, or while a reply is running, asks first. Closing it stops the generation.
  - Each save is numbered (`rev`). If another tab or window saved the design since this one last did, that newer copy is shown instead of being overwritten (while a reply runs on the design here, that reply's copy wins).
  - A design deleted in one tab closes in the others, and nothing saves it back.
- **Messages while a reply runs:** type and press Enter (or *Send*, next to *Stop*) and the message is queued; it goes out once the reply is done, several queued messages together as one. If the reply is stopped or fails, the queue waits for *Send now*. Queued messages show above the chat box, each with a × to drop it.
- **Questions:** ask something about the design and the reply starts with the short answer, then the explanation; the model is only changed when you ask for a change.

## Side panel

Four tabs, each with two sections one under the other (click a section's title to fold it):

- **Object:** *Parts* and *Parameters*. *Parts* lists the model's parts as a tree: show or hide each part (hidden parts stay out of the view, the exports, validation and the cost, and stay hidden with the design), select one to highlight it in the view, export one part as STL, and switch the text and SVG drawings placed on it on and off. *Parameters* has the overall size and the sliders. A slider whose parts are all hidden is greyed out: prompt-to-part measures which parts each parameter changes (building the model once per parameter with its value nudged), and model scripts can name them with `part` / `parts`.
- **Text & SVG:** the text and SVG tools.
- **Print:** print settings and the cost.
- **Code:** the model's measurements, dimension sources and console, and the script editor.

## Messages while a reply runs

While a reply runs, *Send* puts your message into it: the reply reads it at its next step (after the current tool call or thinking) and takes it into account in the same reply; it shows in the steps as "You: …", and the activity panel notes when it was read. A message that arrives just as the reply ends gets its own answer before the reply finishes. The clock button next to it (*Later*) queues the message for after the reply instead, as do SVG and OpenSCAD attachments, which prompt-to-part only takes with a new request.

## Watching a reply

The chat shows every step with its time while a reply runs, and follows new output only while you are scrolled to the bottom. Hover the working line, click it to pin, or click *activity* on any reply to open the activity panel beside the chat. It shows:
- the thinking and the reply as they stream
- `model.js` as it is typed (edits as replace/with)
- each tool call with its result and render previews
- what was sent (the full request text, your current view and the four-view render) and the full text that came back from every tool (measurements, file reads, web pages, OpenSCAD reports), under *Show the full text*

The panel follows the newest output unless you scroll up. Drag its header to move it anywhere (over the 3D view, say) and its corner to resize it; it remembers where you put it, and a double-click on the header puts it back beside the chat. Pinned on a reply that is running, it follows the running replies: it shows the live reply of whichever design you open, is hidden on designs with no reply running, stays open on a reply that has just finished, and only its × stops this. On one design it keeps what it has shown: the next reply (a queued message, say) is added below, after a line with the message that started it. Thinking arrives as Claude Code's summaries, a few sentences at a time. The live transcript is kept in memory only; after a reload the panel is rebuilt from the saved steps.

## Viewer

- **Controls:** orbit/pan/zoom, a home view (`Home` key; `F` fits from the current angle), view presets and an ortho camera.
- **Overlays:** bounding-box dimensions, AI feature callouts, a click-to-measure tool with vertex snapping, a section plane, per-part visibility and a part-colour toggle.
- **Display:** fullscreen (`U` hides the controls there) and draft/normal/high preview quality.
- **Sidebars:** `T` and `N` hide the chat and parameter sidebars; drag their inner edge to resize them (double-click it for the default width). The chat's default width fits the whole composer bar (attach, model and effort, picture mode, options, microphone, send) on one row (the options menu holds the switches web search, ask first, *Send my view* and sounds; in 3D figure mode the ▾ beside the picture mode chip holds *Colour* and *Wait for my OK*); only a width you drag is remembered, so you keep yours.

**Printer:** prompt-to-part asks which printer you have on its first start and keeps it (`data/printer.json`); the Print tab's *Change* picks another, with its nozzle and how many filaments it loads at once (1 for no AMS, 4 for one AMS or AMS lite, up to 16). The list comes from your Bambu Studio: every Bambu Lab printer with its 0.2 / 0.4 / 0.6 / 0.8 nozzle, and the printer presets you saved there yourself when they are based on a Bambu Lab printer (Bambu Studio's `user` folder, read only; `BAMBU_STUDIO_USER_DIR` points elsewhere, and Docker needs it mounted, see `docker-compose.yml`). Without Bambu Studio a short built-in list is used. The chosen printer's plate is drawn, and its bed, nozzle and kind (bed-slinger or CoreXY) drive the checks, the split pieces and prompt-to-part's instructions. The baseline print settings come from the template built per printer from your Bambu Studio (`data/bambu/templates/`), its machine preset with its own default process and Bambu PLA Basic presets. Two-nozzle printers (H2D, H2D Pro, H2C, X2D) are listed, but Bambu Studio's command line can't slice prompt-to-part's project for them yet, so they get a plain 3MF without print settings or cost.

**Editable dimensions:** double-click any X/Y/Z or callout label (or type in *Overall size*) and the app solves for the parameter value that produces exactly that size. Uniform *Scale %* is available too.

**Multi-part designs:** a layout bar switches between print, assembled and exploded layouts, and *Assemble* animates prompt-to-part's assembly sequence step by step. Replies include assembly pictures and instructions.

## Print settings and validation

- **Print in one colour (top of the Print tab):** a switch, saved with the design like the print settings (`$oneColour` in its values: kept through reloads, export and import, new versions and "new design from version"; a setting you can save as a version). On, everything prints in one filament while keeping the print settings: the 3MF (Bambu project and plain), the Cost tab's slice and *Export project…* (its README says "printed in one colour") have one filament, no colour painting and no LayerTone filament changes or pauses. The filament is the design's main one (the biggest part's; a coloured figure's most used, a LayerTone print's first) or one you pick from the design's filaments. The 3D view and product photos show the model in it, with a "Printing in one colour" note in the view. Off (default): one filament per colour (AMS), as before.
- **Print settings (Print tab):** layer height, walls, top/bottom layers, infill % and pattern, supports (and whether they may only stand on the plate), brim, wall order, seam, ironing and fuzzy skin, for the whole model or per part. The baseline is Bambu Lab A1, PLA, 0.20 mm Standard as your Bambu Studio defines it: once the 3MF template has been built from your install, the Print tab, prompt-to-part and the export all read their defaults from it (until then, the Bambu Studio 2.8 values). prompt-to-part suggests changes where the design needs them (e.g. more walls for a hook, supports for an overhang), and your overrides win.
- **Validate** (and automatically on every export) checks the high-resolution mesh of the parts being exported. It checks:
  - fit in the printer and contact with the plate
  - holes, non-manifold edges, flipped or inside-out faces
  - floating parts and pieces in mid-air (a sealed cavity is not one)
  - tall narrow parts, overhangs that need supports, walls too thin for the nozzle
  - overlapping parts

  Supports and brim from the print settings are taken into account.

  These are prompt-to-part's own checks, run in the browser on the exported mesh (`src/geometry/validate.ts`); no slicer is involved, so they take a moment rather than a slice. They are rules of thumb: an overhang is a face tilted down more than 45°, and a wall thinner than two nozzle widths (0.8 mm on the A1's 0.4 mm nozzle) is a warning, thinner than one an error. Bambu Studio knows more, such as bridges between two supports and your exact line widths, so it can still disagree on a borderline part; for the final word, open the 3MF in Bambu Studio and look at its preview.

## Cost

The *Cost* section of the *Print* tab works out what a print costs, from Bambu Studio's own numbers:

- **Print time and filament:** the visible parts are built at export resolution, made into the same Bambu Studio project as the 3MF export (your print settings included) and sliced by your installed Bambu Studio (`server/slicer.ts`, with its own data folder in `data/bambu/slicer-data`, so your Bambu Studio settings are untouched). The time is Bambu Studio's estimate; the grams include supports, the prime tower and purge, per filament for multi-colour prints.
- **When:** only when you press *Slice* (slicing is CPU-heavy, so opening the Print tab never starts one). A change to the parameters, hidden parts, print settings or *Print in one colour* marks the numbers as out of date; *Slice again* updates them. The current stage (building the model, preparing the project, slicing) is shown with the time since the calculation started, in the tab and in the viewer's status bar. Small models slice in a second or two; the first project needs the Bambu Studio template, which takes longer.
- **Filament cost:** grams × your price per 1 kg roll, in the currency set by `PTP_CURRENCY` (US dollars by default).
- **Electricity:** your printer's average power while printing × the print time × your price per kWh. Measure it for the real figure (a plug-in meter: the kWh a print used ÷ its hours × 1000); the A1's 1300 W rating is its peak while the bed heats, not an average.
- **Defaults:** until you enter your own, typical prices for a 1 kg PLA roll and a kWh in US dollars ($20, $0.17), euros (€20, €0.25), pounds (£18, £0.25) or lei (140, 1.45); in another currency the Cost tab asks for them. The printer's power starts at 200 W (an upper estimate for the A1, which usually averages 100 to 150 W).
- **Selling price:** *Suggest a price* sends the costs, print time, size, parts and what the item is to Claude (Sonnet, one reply, no tools), which suggests a price, a range and its reasoning. It is shown as a suggestion, not a calculation. The price is in `PTP_CURRENCY`, and `PTP_COUNTRY` (e.g. `Romania`) tells Claude where you sell, so it prices for that market.

Your prices are kept in `data/cost.json`.

## Export

Exports contain the visible parts only; hide a part to leave it out (Object tab, or the part list in the view), or export a single part as STL from the Object tab. A part's colour swatch in the Object tab opens the filament picker (your own filaments, the common colours and the library): the part then prints with that filament - in the 3D view, the 3MF's filaments, the cost and the app's own renders - instead of the colour the design chose, until you reset it (↺); the pick is kept per part name in the design. Every export rebuilds the model at high resolution and validates exactly that mesh. Problems are reported, not blocking. If the high-resolution build fails, nothing is exported and the error is shown.

- **STL** (default): a single mesh, geometry only (a coloured figure's colours are only in the 3MF; the export menu says so).
- **3MF:** one named object per part, positioned exactly as in the viewer and centred on the printer's bed. Options:
  - **Colours (AMS):** each part keeps its colour, and Bambu Studio maps the colours onto AMS filaments. A coloured figure comes painted per triangle with its filaments (see [Colour](3d-models.md#3d-figures-with-meshy)). It is the opposite of the design's *Print in one colour* switch (Print tab), and changes it: off, everything is one filament.
  - **Print settings:** a Bambu Studio project with the A1 / PLA / 0.20 mm profile and your print settings (model-wide and per part). Parts that touch become one object with the parts inside it. Each part keeps its own walls, infill and top/bottom layers. Supports and brim can only be set per object in Bambu Studio, so an object gets supports if any of its parts needs them, and the widest brim. With more than one filament, the prime tower goes beside the model, 10 mm from it by one of its corners (its size measured with Bambu Studio's slicer: 31 mm square for two filaments, 7.5 mm more for each further one), so a big model doesn't collide with it ("G-code conflicts"); without room beside the centred model, the model moves towards a side of the bed, and without room anywhere (a model about the size of the bed) there is no tower and the A1 purges into its chute. The Cost tab's slice uses the same project, so its time and grams include the tower. The template is built from your own Bambu Studio install the first time and cached in `data/bambu/`; nothing from Bambu is bundled.
- **Blender (.blend):** built by your installed Blender (4.1 or newer) in the background. It has one object per part with materials, millimetre units, a *Dimensions* collection, parameter values as custom properties, and the model script embedded.
- **Export project…:** everything about the design in one folder, for keeping your best designs: `model.js` (the script), `values.json` (the parameter values), `design.ptp.json` (the whole design: chat, versions, values), the STL, the 3MF (a Bambu Studio project with your print settings and the colours when Bambu Studio is installed, otherwise a plain 3MF with the colours; in one filament with *Print in one colour*), the `.blend` (only when Blender is installed), `images/` (the chat's photos and drawings, renders, product photos and the LayerTone or lithophane pictures), `meshes/` (imported meshes) and a `README.md` (the summary, overall size, parameters, print settings that differ from the profile, where the dimensions come from, the date and prompt-to-part's version). Chrome and Edge ask for a folder and create the project's folder in it, named after the design (`Name (2)` when there is one already, so nothing is overwritten); other browsers (Firefox) download it as one zip, `<name>.zip`, built off the page's main thread. A piece that fails (Blender, say) is left out and the README says why; the rest is still written. To bring the design back, choose the zip in **Designs → Import designs…** (zip the folder first in Chrome and Edge): the import reads `design.ptp.json`, `images/` and `meshes/` and leaves the other files alone.
