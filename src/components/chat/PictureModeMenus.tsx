// The composer's picture mode chip (3D model, AI artwork, LayerTone, Lithophane, Line art, 3D
// figure) and the ▾ menus beside it: the 3D figure's options and the line art's style.
import { meshColorBudget } from '../../../shared/meshColors';
import { useEffect } from 'react';
import type { GenerateRequest, MeshyBalance } from '../../../shared/api';
import { MESHY_CREDITS_PER_COLOR_MODEL, MESHY_CREDITS_PER_MODEL, meshyCredits } from '../../../shared/meshes';
import { DEFAULT_LINE_ART_STYLE, LINE_ART_STYLE_INFO, LINE_ART_STYLES, type LineArtStyle } from '../../../shared/lineart';
import { AUTO_BUILD_SECONDS } from '../../lib/autoBuild';
import { Icon } from '../Icon';
import { useChipMenu } from './useChipMenu';

export type ImageMode = NonNullable<GenerateRequest['imageMode']>;

export const IMAGE_MODES: { mode: ImageMode; label: string; short?: string; icon: string; desc: (meshy: boolean) => string; hint: (artworkModel: string | null, meshy: boolean) => string }[] = [
  { mode: 'off', label: '3D model', short: '3D model', icon: 'cube', desc: () => 'Everything modelled in 3D', hint: () => 'Jig models people, characters and animals as 3D objects.' },
  { mode: 'artwork', label: 'AI artwork', short: 'Artwork', icon: 'palette', desc: () => 'Flat colour layers for reliefs and signs', hint: (m) => `Jig has ${m ?? 'an image model'} draw the subject – a person, an animal, a scene or an object – as flat artwork first, then turns it into colour layers for wall art, reliefs and signs.` },
  { mode: 'layertone', label: 'LayerTone', short: 'LayerTone', icon: 'layers', desc: () => 'A picture painted by stacked filaments', hint: (art) => `A picture printed flat as a thin relief, painted by stacked filaments that let the ones below show through. Attach a photo${art ? ', or describe the picture and Jig makes one' : ''}; set the filaments in the Print tab.` },
  { mode: 'lithophane', label: 'Lithophane', short: 'Lithophane', icon: 'lamp', desc: () => 'A photo that glows lit from behind', hint: (art) => `A photo in white PLA, thick where it is dark and thin where bright, that glows lit from behind: night lights, frames, lamp shades. Attach a photo${art ? ', or describe one and Jig makes it' : ''}.` },
  { mode: 'lineart', label: 'Line art', short: 'Line art', icon: 'lineart', desc: () => 'One-piece wall cut-outs and key holders', hint: (art) => `A drawing cut out as one flat piece in one colour, about 2 mm thick with 1 mm lines, to hang with tape: a car and a motorbike on a key-holder bar, a figure in a frame, a name sign. Attach an SVG or a picture${art ? ', or describe it and Jig draws it' : ''}; pick the style in its ▾ menu.` },
  { mode: 'figure', label: '3D figure', short: 'Figure', icon: 'figure', desc: (meshy) => (meshy ? 'A sculpted AI mesh · Meshy credits' : 'Needs a Meshy API key'), hint: (art, meshy) => (!meshy
    ? 'Needs a Meshy API key: set MESHY_API_KEY in .env and restart Jig.'
    : art ? 'Jig draws a concept picture of the person, character or animal for you to approve, then Meshy sculpts it as a real 3D model (1–3 min, Meshy credits); or attach a photo. Jig adds the base, name or mount. Turn on Colour in its ▾ menu for a figure in up to 4 filaments.'
    : 'Meshy sculpts a real 3D model of a person, character or animal from your description or an attached photo (1–3 min, Meshy credits); Jig adds the base, name or mount. Turn on Colour in its ▾ menu for a figure in up to 4 filaments.') },
];

/** The palette button: what Claude does with pictures for this design (until you reload). */
/** "1,200 Meshy credits left", with when the monthly ones renew, and what a model costs (in colour or not). */
function creditsText(c: MeshyBalance, color = false): string {
  const resets = c.monthly_resets_at ? ` (monthly credits renew ${new Date(c.monthly_resets_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })})` : '';
  return `${c.balance.toLocaleString('en')} Meshy credits left${resets}; a model costs ${meshyCredits(color)}${color ? ' in colour' : ''}.`;
}

/** 3D figure mode's ▾ beside the picture mode button: Colour, Wait for my OK (`waitForOk` null without an image model) and the Meshy credits left. */
export function FigureMenu({ color, onColor, waitForOk, onWaitForOk, credits }: { color: boolean; onColor: (on: boolean) => void; waitForOk: boolean | null; onWaitForOk: (on: boolean) => void; credits: MeshyBalance | null }) {
  const m = useChipMenu();
  useEffect(() => { if (m.open) m.menu.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus(); }, [m.open]);
  return (
    <span className="mode-wrap" ref={m.wrap}>
      <button {...m.triggerProps} className={`web-toggle figure-more ${m.open ? 'open' : ''}`} aria-label="3D figure options" title="3D figure options: Colour, Wait for my OK and the Meshy credits left">
        <Icon name="chevron" size={12} />
      </button>
      {m.open && (
        <div className="mode-menu figure-menu" ref={m.menu} onKeyDown={m.onMenuKey}>
          <div role="menu" aria-label="3D figure options">
            <button role="menuitemcheckbox" aria-checked={color} className={color ? 'on' : ''} onClick={() => onColor(!color)}
              title={color
                ? `Colour (${meshColorBudget()} filaments) is on: Jig draws the concept in grey (the shape) and then paints it (the colours), Meshy builds the shape and paints the model from them (${MESHY_CREDITS_PER_COLOR_MODEL} credits instead of ${MESHY_CREDITS_PER_MODEL}), and it prints in up to ${meshColorBudget()} filaments with the AMS – you pick them in the Object tab. Click for one colour.`
                : `Colour (${meshColorBudget()} filaments): make the figure in colour, printed in up to ${meshColorBudget()} filaments with the AMS (${MESHY_CREDITS_PER_COLOR_MODEL} Meshy credits a model instead of ${MESHY_CREDITS_PER_MODEL}).`}>
              <span className="mode-check" aria-hidden>{color && <Icon name="check" size={13} />}</span>
              <span className="mode-icon" aria-hidden><span className={`figure-color-dots ${color ? 'on' : ''}`}><i /><i /><i /><i /></span></span>
              <span><b>Colour ({meshColorBudget()} filaments)</b><span>{color
                ? `Painted by Meshy, printed in up to ${meshColorBudget()} filaments with the AMS · ${MESHY_CREDITS_PER_COLOR_MODEL} credits a model.`
                : `In colour, printed in up to ${meshColorBudget()} filaments with the AMS · ${MESHY_CREDITS_PER_COLOR_MODEL} credits a model instead of ${MESHY_CREDITS_PER_MODEL}.`}</span></span>
            </button>
            {waitForOk != null && (
              <button role="menuitemcheckbox" aria-checked={waitForOk} className={waitForOk ? 'on' : ''} onClick={() => onWaitForOk(!waitForOk)}
                title={waitForOk
                  ? `Wait for my OK is on: Jig draws a concept picture of the figure and waits for you to approve it before Meshy builds it. Click to have it built by itself ${AUTO_BUILD_SECONDS} s after the picture, unless you stop it or type a change (${MESHY_CREDITS_PER_MODEL} Meshy credits a figure, ${MESHY_CREDITS_PER_COLOR_MODEL} in colour).`
                  : `Wait for my OK is off: ${AUTO_BUILD_SECONDS} s after Jig draws a concept picture, Meshy builds it (${MESHY_CREDITS_PER_MODEL} credits, ${MESHY_CREDITS_PER_COLOR_MODEL} in colour) unless you click Stop or type a change. Click to approve each picture yourself.`}>
                <span className="mode-check" aria-hidden>{waitForOk && <Icon name="check" size={13} />}</span>
                <span className="mode-icon" aria-hidden><Icon name={waitForOk ? 'hand' : 'timer'} size={16} /></span>
                <span><b>Wait for my OK</b><span>{waitForOk
                  ? 'Meshy builds a concept picture only once you approve it.'
                  : `Meshy builds a concept picture ${AUTO_BUILD_SECONDS} s after it is drawn, unless you stop it or type a change.`}</span></span>
              </button>
            )}
          </div>
          {credits && <div className={`figure-credits ${credits.balance < meshyCredits(color) ? 'low' : ''}`}><Icon name="coin" size={13} /> {creditsText(credits, color)}</div>}
        </div>
      )}
    </span>
  );
}

/** Line art mode's ▾ beside the picture mode button: the piece's style (outline, key holder, framed, …). */
export function LineArtMenu({ style, onStyle }: { style: LineArtStyle; onStyle: (s: LineArtStyle) => void }) {
  const m = useChipMenu();
  useEffect(() => { if (m.open) m.menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(); }, [m.open]);
  // As in the picture mode menu: picking another style keeps the menu open, the chosen one again closes it.
  const pick = (s: LineArtStyle) => (s !== style ? onStyle(s) : m.close());
  return (
    <span className="mode-wrap" ref={m.wrap}>
      <button {...m.triggerProps} className={`web-toggle figure-more ${m.open ? 'open' : ''}`} aria-label="Line art style" title={`Line art style: ${LINE_ART_STYLE_INFO[style].label}. Click to choose.`}>
        <Icon name="chevron" size={12} />
      </button>
      {m.open && (
        <div className="mode-menu lineart-menu" role="menu" aria-label="Line art style" ref={m.menu} onKeyDown={m.onMenuKey}>
          {LINE_ART_STYLES.map((s) => (
            <button key={s} role="menuitemradio" aria-checked={s === style} className={s === style ? 'on' : ''} onClick={() => pick(s)}>
              <span className="mode-check" aria-hidden>{s === style && <Icon name="check" size={13} />}</span>
              <span className="mode-icon" aria-hidden><Icon name={`la-${s}`} size={16} /></span>
              <span><b>{LINE_ART_STYLE_INFO[s].label}</b><span>{LINE_ART_STYLE_INFO[s].desc}</span></span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export function ImageModeMenu({ mode, artworkModel, meshy, credits, color, lineArtStyle, split, autoBuild, onMode }: {
  mode: ImageMode; artworkModel: string | null; meshy: boolean; credits: MeshyBalance | null; color: boolean; lineArtStyle: LineArtStyle;
  /** A ▾ menu (3D figure, Line art) is attached on the right; a figure's button then also marks Colour on and Wait for my OK off (`autoBuild`). */
  split: boolean; autoBuild: boolean; onMode: (m: ImageMode) => void;
}) {
  const { open, wrap, menu, triggerProps, onMenuKey: onKey, close } = useChipMenu();
  const modes = IMAGE_MODES.filter((m) => m.mode !== 'artwork' || artworkModel || mode === 'artwork');
  const current = IMAGE_MODES.find((m) => m.mode === mode) ?? IMAGE_MODES[0];
  // Opening puts the focus on the chosen mode; arrows, Home and End move it.
  useEffect(() => { if (open) menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(); }, [open]);
  // Picking another mode keeps the menu open (to compare the modes); picking the chosen one again,
  // Escape, Tab or a click outside closes it.
  const pick = (m: ImageMode) => (m !== mode ? onMode(m) : close());
  const figure = split && mode === 'figure';
  const marks = figure && (color || autoBuild);
  // Line art names its style (but plain "Line art" for the default outline).
  const style = mode === 'lineart' ? LINE_ART_STYLE_INFO[lineArtStyle] : null;
  const short = style && lineArtStyle !== DEFAULT_LINE_ART_STYLE ? style.label : current.short;
  const name = style ? `${current.label} – ${style.label}` : current.label;
  return (
    <span className="mode-wrap" ref={wrap}>
      <button
        {...triggerProps}
        className={`web-toggle art mode-btn mode-chip ${split ? 'split' : ''}`}
        aria-label={`Picture mode: ${name}`}
        title={`Picture mode: ${name}${style ? ` (${style.desc.toLowerCase()})` : ''}. ${current.hint(artworkModel, meshy)}${mode === 'figure' && credits ? ` ${creditsText(credits, color)}` : ''}${figure && color ? ' Colour is on.' : ''}${figure && autoBuild ? ` Wait for my OK is off: concept pictures are built ${AUTO_BUILD_SECONDS} s after they are drawn.` : ''} Click to choose.`}
      >
        <Icon name={current.icon} size={14} />
        {short && <span className="mode-label">{short}</span>}
        {mode === 'figure' && credits && <span className={`mode-credits ${credits.balance < meshyCredits(color) ? 'low' : ''}`} aria-label={creditsText(credits, color)}>{credits.balance.toLocaleString('en')}</span>}
        {/* Colour on and Wait for my OK off, at a glance (both are set in the ▾ menu). */}
        {marks && (
          <span className="figure-marks" aria-hidden>
            {color && <span className="figure-color-dots on"><i /><i /><i /><i /></span>}
            {autoBuild && <Icon name="timer" size={11} />}
          </span>
        )}
      </button>
      {open && (
        <div className="mode-menu" role="menu" aria-label="Picture mode" ref={menu} onKeyDown={onKey}>
          {modes.map((m) => {
            // Without a Meshy key the mode is shown, saying what it needs, but can't be chosen.
            const off = m.mode === 'figure' && !meshy && mode !== 'figure';
            return (
              <button key={m.mode} role="menuitemradio" aria-checked={m.mode === mode} aria-disabled={off || undefined} className={`${m.mode === mode ? 'on' : ''} ${off ? 'unavailable' : ''}`} onClick={() => { if (!off) pick(m.mode); }}
                title={`${m.hint(artworkModel, meshy)}${m.mode === 'figure' && credits ? ` ${creditsText(credits, color)}` : ''}`}>
                <span className="mode-check" aria-hidden>{m.mode === mode && <Icon name="check" size={13} />}</span>
                <span className="mode-icon" aria-hidden><Icon name={m.icon} size={16} /></span>
                <span><b>{m.label}{m.mode === 'off' && <i className="mode-default">Default</i>}</b><span>{m.desc(meshy)}</span></span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
