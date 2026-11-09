# Notice

Copyright (C) 2026 3dprogramin.

prompt-to-part's own code is free software under the GNU Affero General Public License, version 3 only (AGPL-3.0-only), see [LICENSE](LICENSE). You may use, change and share it; if you share a changed version, or run a changed version as a service other people use over a network, you must offer them its source code under the same licence.

**Additional permission under AGPL-3.0 section 7:** if you modify prompt-to-part, or any covered work, by linking or combining it with `@anthropic-ai/claude-agent-sdk` or the Claude Code executable (or a modified version of either), containing parts covered by Anthropic's terms, the copyright holder grants you additional permission to convey the resulting work. The source for those parts is not required as part of prompt-to-part's Corresponding Source.

Other licences (for example for a hosted or closed-source use of prompt-to-part) can be had from the copyright holder: andrei@3dprogramin.io.

## Third-party software

prompt-to-part depends on packages under their own licences:
- **`@anthropic-ai/claude-agent-sdk` and the Claude Code executable it installs** are proprietary and covered by [Anthropic's terms](https://www.anthropic.com/legal), not by prompt-to-part's licence. Install them with `pnpm install`; don't redistribute them (for example inside `node_modules` in an archive or image).
- **The packages bundled into the built app** (manifold-3d, SES, three.js, React and others) are MIT or Apache-2.0. `pnpm build` writes their licences to `dist/THIRD_PARTY_NOTICES.md`; keep that file with any copy of `dist/`.
- **The bundled fonts** (`@fontsource`) are under the SIL Open Font License.
- **OpenSCAD** (for `.scad` files in the chat) is GPL-2.0-or-later and not part of prompt-to-part: it downloads the [OpenSCAD Playground](https://github.com/openscad/openscad-playground) WebAssembly build from npm on first use (pinned version, checked against its hash) and runs it as a separate program on the server only. Its source is at [github.com/openscad/openscad](https://github.com/openscad/openscad); the libraries it comes with have their own licences.

## Trademarks

prompt-to-part is an independent project. It is not affiliated with or endorsed by Anthropic, Bambu Lab or the Blender Foundation. Claude, Bambu Lab, Bambu Studio and Blender are trademarks of their respective owners.
