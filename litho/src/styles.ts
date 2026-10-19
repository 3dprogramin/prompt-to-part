// The widget's styles, inside its shadow DOM so the shop's theme can't break them (nor they the
// theme). The host page themes it through CSS custom properties on <litho-preview>:
//   --litho-accent, --litho-accent-text, --litho-font, --litho-bg, --litho-fg, --litho-muted,
//   --litho-border, --litho-radius, --litho-stage-height.
// and picks light or dark defaults with theme="light" (the default), "dark" or "auto" (the system's).

/** The dark theme's defaults (the same custom properties still override them). */
const DARK = `
  color: var(--litho-fg, #ece6dd);
  --a: var(--litho-accent, #e2803f);
  --at: var(--litho-accent-text, #1a1208);
  --bg: var(--litho-bg, #1b1916);
  --mu: var(--litho-muted, #a99f92);
  --bd: var(--litho-border, #3a342d);
  --stage: #26221d; --day-1: #4a443c; --day-2: #2a2622;
  --tip-bg: #3a2c14; --tip-fg: #f3d29a; --good-bg: #16301e; --good-fg: #a3dbb2; --err: #ff8f85;
  color-scheme: dark;
`;

export const STYLES = `
:host {
  display: block;
  container-type: inline-size;
  font-family: var(--litho-font, inherit);
  color: var(--litho-fg, #1f1b16);
  --a: var(--litho-accent, #b4531a);
  --at: var(--litho-accent-text, #fff);
  --bg: var(--litho-bg, #fff);
  --mu: var(--litho-muted, #6f665c);
  --bd: var(--litho-border, #e4ddd2);
  --r: var(--litho-radius, 14px);
  --tint: color-mix(in srgb, var(--a) 9%, var(--bg));
  --stage: #ece8e1; --day-1: #f6f3ee; --day-2: #ddd7cd;
  --tip-bg: #fff4e0; --tip-fg: #6b3d06; --good-bg: #e9f6ec; --good-fg: #1d5b2c; --err: #b42318;
  -webkit-tap-highlight-color: transparent;
}
:host([theme="dark"]) {${DARK}}
@media (prefers-color-scheme: dark) { :host([theme="auto"]) {${DARK}} }
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
button, input { font: inherit; color: inherit; }
button { cursor: pointer; }
[hidden] { display: none !important; }
.root { background: var(--bg); border: 1px solid var(--bd); border-radius: var(--r); padding: 14px; }

/* Upload */
.drop {
  display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px;
  padding: 34px 18px 26px; border: 2px dashed var(--bd); border-radius: calc(var(--r) - 4px);
  background: var(--tint); transition: border-color .15s, background .15s;
}
.drop.over { border-color: var(--a); background: color-mix(in srgb, var(--a) 16%, var(--bg)); }
.drop > svg { width: 46px; height: 46px; color: var(--a); }
.drop h3 { margin: 4px 0 0; font-size: 1.15rem; font-weight: 650; }
.drop p { margin: 0; color: var(--mu); font-size: .92rem; max-width: 34ch; }
.row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.btn {
  border: 1px solid var(--bd); background: var(--bg); border-radius: 999px; padding: 10px 18px;
  font-weight: 600; font-size: .95rem; min-height: 44px; display: inline-flex; align-items: center; gap: 8px;
}
.btn.primary { background: var(--a); border-color: var(--a); color: var(--at); }
.btn:focus-visible, .chip:focus-visible, .seg button:focus-visible, .lights:focus-visible { outline: 3px solid color-mix(in srgb, var(--a) 45%, transparent); outline-offset: 2px; }
.btn svg { width: 18px; height: 18px; }
.camera { display: none; }
@media (pointer: coarse) { .camera { display: inline-flex; } }
.privacy { display: flex; gap: 6px; align-items: flex-start; font-size: .8rem; color: var(--mu); margin-top: 6px; text-align: left; }
.privacy svg { width: 14px; height: 14px; flex: none; margin-top: 2px; color: var(--mu); }
.status { text-align: center; color: var(--mu); font-size: .9rem; margin: 8px 0 0; }
.status.error { color: var(--err); }

/* Workspace */
.work { display: grid; gap: 14px; }
@container (min-width: 720px) {
  .work { grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); align-items: start; }
  .stage-col { position: sticky; top: 12px; }
}
.seg { display: flex; background: color-mix(in srgb, var(--mu) 13%, var(--bg)); border-radius: 999px; padding: 3px; gap: 2px; }
.seg button {
  flex: 1; border: 0; background: transparent; border-radius: 999px; padding: 8px 6px; min-height: 40px;
  font-weight: 600; font-size: .92rem; color: var(--mu);
}
.seg button[aria-selected="true"], .seg button[aria-pressed="true"] { background: var(--bg); color: inherit; box-shadow: 0 1px 3px rgb(0 0 0 / .14); }
.stage {
  position: relative; margin-top: 10px; height: var(--litho-stage-height, clamp(300px, 88cqw, 460px));
  border-radius: calc(var(--r) - 4px); overflow: hidden; background: var(--stage); user-select: none;
}
.stage.dark { background: radial-gradient(120% 90% at 50% 40%, #2c241d 0%, #110e0b 70%); }
.stage.day { background: radial-gradient(120% 90% at 50% 30%, var(--day-1) 0%, var(--day-2) 100%); }
.pane { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.pane canvas { display: block; }
.frame canvas { width: 100%; height: 100%; touch-action: none; cursor: grab; }
.frame canvas:active { cursor: grabbing; }
.lit canvas { border-radius: 2px; transition: box-shadow .3s; }
.stage.dark .lit canvas { box-shadow: 0 0 46px 6px rgb(255 196 120 / .28), 0 0 0 1px rgb(255 220 170 / .2); }
.stage.day .lit canvas { box-shadow: 0 10px 24px rgb(60 45 30 / .22); }
.three canvas { width: 100% !important; height: 100% !important; touch-action: none; }
.badge { position: absolute; left: 10px; bottom: 10px; font-size: .75rem; padding: 3px 8px; border-radius: 999px; background: rgb(0 0 0 / .45); color: #fff; }
.lights {
  position: absolute; top: 10px; right: 10px; display: inline-flex; align-items: center; gap: 6px;
  border: 0; border-radius: 999px; padding: 7px 12px 7px 9px; font-size: .82rem; font-weight: 600; min-height: 36px;
  background: rgb(255 255 255 / .9); color: #2a231c; box-shadow: 0 1px 4px rgb(0 0 0 / .2);
}
.lights[aria-pressed="true"] { background: #ffd58a; }
.lights svg { width: 18px; height: 18px; }
.hint { margin: 8px 2px 0; font-size: .82rem; color: var(--mu); min-height: 1.2em; }
.zoomrow { display: flex; align-items: center; gap: 10px; margin-top: 8px; font-size: .85rem; color: var(--mu); }
.zoomrow input { flex: 1; }
.next { margin-top: 10px; width: 100%; justify-content: center; }
input[type=range] { accent-color: var(--a); min-height: 32px; }

/* Options */
.controls { display: grid; gap: 14px; }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
legend { font-size: .76rem; text-transform: uppercase; letter-spacing: .06em; color: var(--mu); font-weight: 650; margin-bottom: 6px; padding: 0; }
.chips { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 8px; }
.shapes { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.chip {
  border: 1.5px solid var(--bd); background: var(--bg); border-radius: 12px; padding: 9px 6px; text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: 3px; min-height: 48px; justify-content: center;
}
.chip[aria-pressed="true"] { border-color: var(--a); background: var(--tint); }
.chip svg { width: 34px; height: 24px; color: var(--mu); }
.chip[aria-pressed="true"] svg { color: var(--a); }
.chip b { font-weight: 650; font-size: .88rem; }
.sizes b { white-space: nowrap; }
.chip small { color: var(--mu); font-size: .8rem; }
.tones { display: flex; align-items: center; gap: 10px; }
.tones input { flex: 1; }
.sub { font-size: .8rem; color: var(--mu); margin: 2px 0 0; }
.tips { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.tips li { display: flex; gap: 8px; font-size: .86rem; padding: 9px 11px; border-radius: 10px; background: var(--tip-bg); color: var(--tip-fg); }
.tips li.good { background: var(--good-bg); color: var(--good-fg); }
.tips svg { width: 16px; height: 16px; flex: none; margin-top: 1px; }
.summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-top: 1px solid var(--bd); padding-top: 12px; }
.summary .what { font-size: .88rem; color: var(--mu); }
.summary .price { font-size: 1.45rem; font-weight: 700; }
.note { font-size: .82rem; color: var(--mu); margin: 0; }
.note.warn { color: var(--err); font-weight: 600; }
.link { border: 0; background: none; padding: 6px 0; color: var(--a); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
`;
