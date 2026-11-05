# Modes

The mode decides what kind of thing prompt-to-part makes from your request. Pick it with the mode chip under the chat (*3D model* by default); in the menu, **E** on a mode shows an example of what came out for one request. Back to the [README](../README.md).

| Mode | What you get | Good for | Needs | Extra cost per design |
|---|---|---|---|---|
| [3D model](#3d-model) | A solid model built from code, with sliders | Stands, clips, boxes, mounts, anything that has to fit | Claude only | none |
| [AI artwork](#ai-artwork) | A flat picture turned into raised colour layers | Signs, reliefs, wall art with a character or scene | `OPENROUTER_API_KEY` | about $0.07 a picture |
| [LayerTone](#layertone) | A photo painted by stacked filaments | Photo pictures in a few colours of filament | A photo, or `OPENROUTER_API_KEY` to have one made | about $0.07 if a picture is made |
| [Lithophane](#lithophane) | A photo in white PLA that shows when lit from behind | Night lights, lamp shades, photo frames | A photo, or `OPENROUTER_API_KEY` | about $0.07 a picture made |
| [Line art](#line-art) | A drawing cut out as one flat piece | Wall cut-outs, key holders, name signs | An SVG or picture, or `OPENROUTER_API_KEY` | about $0.07 a picture made |
| [3D figure](#3d-figure) | A sculpted mesh made by Meshy, on a printable base | People, animals, characters, figurines | `MESHY_API_KEY` (and `OPENROUTER_API_KEY` for the concept picture) | 25 Meshy credits, 35 in colour |

Every mode ends in a design with sliders, the print checks and the usual exports, and you can keep changing it in the chat. The keys go in `.env` (see [Configuration](configuration.md)).

## 3D model

The default. Claude writes a parametric script, so the result is an exact solid with named sizes you can change with sliders: a phone stand for your exact phone, a box with a sliding lid, a clip for a 6 mm cable. With web search on, it looks up the real sizes of named products (a phone, a bottle, a screw).

- **Ask like this:** say what it is for and what it has to fit. "A wall hook for a 30 mm broom handle, two screws" works better than "a hook".
- **Photos help:** attach a photo of the thing it has to fit, or a sketch with sizes.
- **People and animals** come out as simple geometric shapes in this mode. For a real sculpted figure use [3D figure](#3d-figure).
- **Check before you print:** sizes that have to fit (holes, threads, clearances) are worth measuring, see *Check before you print* in the [README](../README.md#check-before-you-print).

## AI artwork

An image model (on OpenRouter) first draws the subject as flat artwork: a person, an animal, a scene or an object. prompt-to-part then turns the picture into raised layers, one per colour, for a relief, a sign or wall art. Good when the picture matters more than the exact shape.

- **Ask like this:** describe the picture and the piece: "a round wall plaque, 15 cm, with a howling wolf in front of a full moon".
- **Prints** in a few colours, one per layer (with an AMS or by changing filament).

More detail in [Pictures](pictures.md).

## LayerTone

A picture printed flat as a thin relief and painted by the filaments themselves: thin layers of light filament let the darker ones below show through, so a few filaments give many shades. Attach a photo, or describe a picture to have one made.

- **Set the filaments** you have in the *Print* tab: the picture is worked out for them.
- **Best with** clear photos with strong contrast: a pet, a portrait, a landscape.

More detail in [Pictures](pictures.md).

## Lithophane

A photo in white PLA, thick where the photo is dark and thin where it is bright. Unlit it looks like a white relief; lit from behind, the photo appears. Attach a photo, or describe one to have it made.

- **Good for** night lights with a foot, lamp shades, frames for a window.
- **Print** in white or natural PLA. It stands upright as built (the finest tones) and brings its own print settings (fine layers, 100 % infill).

More detail in [Pictures](pictures.md).

## Line art

A drawing cut out as one flat piece in one colour, about 2 mm thick with 1 mm lines, to hang with tape or stand on a shelf. Attach an SVG or a picture, or describe it to have it drawn.

- **Pick the style** in the mode's ▾ menu: *Outline* (just the drawing), *Key holder* (on a bar with pegs for keys), *Framed*, *Medallion* (a round or oval frame), *Name sign* (on a bar with a name) or *Desk stand* (in a slotted base).
- **Small colour accents** are possible, for example a red heart on a black drawing.
- **Edit the drawing** by hand afterwards in the line art editor: draw, erase, and join loose pieces.

More detail in [Pictures](pictures.md).

## 3D figure

A sculpted mesh made by [Meshy](https://www.meshy.ai) from your description or a photo, set on a printable base that prompt-to-part builds around it. With an image model it first draws a concept picture of the figure and waits for your OK before spending Meshy credits.

- **Wait for my OK** (on by default): you approve the concept picture or say what to change. Turned off, Meshy starts by itself 10 s after the picture unless you stop it.
- **Colour:** the *Colour* switch makes a figure painted in up to 4 filaments, for printing with an AMS (35 credits instead of 25).
- **Only the subject** comes from Meshy: the base, a name plate or a stand are built by the script, so they stay exact and adjustable.
- **Needs** a Meshy API key (`MESHY_API_KEY`, Meshy's Pro plan); without it the mode is shown but can't be chosen. The chip shows the credits left.

More detail in [3D models, text and SVG](3d-models.md#3d-figures-with-meshy).
