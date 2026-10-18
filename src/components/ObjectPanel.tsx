import { useState } from 'react';
import type { EvalResult } from '../../shared/types';
import type { TextFeature } from '../../shared/textFeatures';
import type { SvgFeature } from '../../shared/svgFeatures';
import type { ExportFormat } from '../lib/export';
import { Icon } from './Icon';

interface Props {
  result: EvalResult;
  hiddenParts: string[];
  onHiddenParts: (names: string[]) => void;
  onExport: (format: ExportFormat, partName?: string) => void;
  textFeatures: TextFeature[];
  onTextFeatures: (f: TextFeature[]) => void;
  svgFeatures: SvgFeature[];
  onSvgFeatures: (f: SvgFeature[]) => void;
  /** Open the Text or SVG section to edit a feature. */
  onEdit: (section: 'text' | 'svg') => void;
  /** The selected part (highlighted in the view); clicking it again clears the selection. */
  selected: string | null;
  onSelect: (name: string | null) => void;
}

/**
 * Object tab: the model as a tree, like FreeCAD's. Each part can be shown or hidden – hidden parts
 * are left out of the view, the exports, validation and the cost – and the text and SVG drawings
 * placed on it are listed under it, each with its own switch.
 */
export function ObjectPanel(p: Props) {
  const names = p.result.parts.map((x) => x.name);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const visible = names.filter((n) => !p.hiddenParts.includes(n));
  // Features without a (known) part go on the first one, as the runtime places them.
  const onPart = (f: { part?: string }, name: string) => (f.part && names.includes(f.part) ? f.part === name : name === names[0]);
  const toggle = (name: string) => p.onHiddenParts(p.hiddenParts.includes(name) ? p.hiddenParts.filter((x) => x !== name) : [...p.hiddenParts, name]);
  return (
    <div className="object-panel">
      <div className="object-head">
        <span className="dim small">{visible.length} of {names.length} part{names.length > 1 ? 's' : ''} shown</span>
        <span className="spacer" />
        {p.hiddenParts.some((n) => names.includes(n)) && <button className="link" onClick={() => p.onHiddenParts([])}>Show all</button>}
      </div>
      <ul className="object-tree" role="tree" aria-label="Parts">
        {p.result.parts.map((part) => {
          const hidden = p.hiddenParts.includes(part.name);
          const texts = p.textFeatures.filter((f) => onPart(f, part.name));
          const svgs = p.svgFeatures.filter((f) => onPart(f, part.name));
          const children = texts.length + svgs.length;
          const open = children > 0 && !collapsed.includes(part.name);
          const b = part.bbox;
          return (
            <li key={part.name} role="treeitem" aria-expanded={children ? open : undefined} aria-selected={p.selected === part.name} className={hidden ? 'off' : ''}>
              <div className={`object-row ${p.selected === part.name ? 'selected' : ''}`}>
                {children
                  ? <button className="icon-btn tree-chev" aria-label={open ? `Collapse ${part.name}` : `Expand ${part.name}`} onClick={() => setCollapsed((c) => (open ? [...c, part.name] : c.filter((x) => x !== part.name)))}><span className={`chev ${open ? 'open' : ''}`}><Icon name="chevron" size={11} /></span></button>
                  : <span className="tree-chev" />}
                <button className="icon-btn" aria-pressed={!hidden} title={hidden ? 'Show (included in the view and exports)' : 'Hide (left out of the view and exports)'} aria-label={`${hidden ? 'Show' : 'Hide'} ${part.name}`} onClick={() => toggle(part.name)}>
                  <Icon name={hidden ? 'eyeOff' : 'eye'} size={14} />
                </button>
                <span className="swatch" style={{ background: part.paint ? `conic-gradient(${part.paint.filaments.map((f, i, a) => `${f.color} ${(i / a.length) * 360}deg ${((i + 1) / a.length) * 360}deg`).join(', ')})` : part.color }} title={part.paint ? `Coloured: ${part.paint.filaments.map((f) => f.name ?? f.color).join(', ')}` : undefined} />
                <button className="object-meta" title={p.selected === part.name ? 'Selected (highlighted in the view) – click to clear' : 'Select: highlight it in the view'} onClick={() => p.onSelect(p.selected === part.name ? null : part.name)}>
                  <div className="object-name">{part.name}</div>
                  <div className="mono dim small">{(b.max[0] - b.min[0]).toFixed(1)} × {(b.max[1] - b.min[1]).toFixed(1)} × {(b.max[2] - b.min[2]).toFixed(1)} mm</div>
                </button>
                <button className="icon-btn" title="Export this part as STL" aria-label={`Export ${part.name} as STL`} onClick={() => p.onExport('stl', part.name)}><Icon name="download" size={14} /></button>
              </div>
              {open && (
                <ul role="group">
                  {texts.map((f) => (
                    <li key={f.id} role="treeitem" aria-selected={false} className={`object-row child ${f.enabled ? '' : 'off'}`}>
                      <button className="icon-btn" aria-pressed={f.enabled} aria-label={`${f.enabled ? 'Hide' : 'Show'} text "${f.text}"`} onClick={() => p.onTextFeatures(p.textFeatures.map((x) => (x.id === f.id ? { ...x, enabled: !x.enabled } : x)))}><Icon name={f.enabled ? 'eye' : 'eyeOff'} size={13} /></button>
                      <span className="tab-glyph" aria-hidden>T</span>
                      <button className="object-child-name" title="Edit in the Text tab" onClick={() => p.onEdit('text')}>{f.text.split('\n')[0] || '(empty)'}</button>
                      <span className={`text-mode ${f.mode}`}>{f.mode === 'emboss' ? 'Raised' : 'Engraved'}</span>
                    </li>
                  ))}
                  {svgs.map((f) => (
                    <li key={f.id} role="treeitem" aria-selected={false} className={`object-row child ${f.enabled ? '' : 'off'}`}>
                      <button className="icon-btn" aria-pressed={f.enabled} aria-label={`${f.enabled ? 'Hide' : 'Show'} SVG ${f.drawing.name}`} onClick={() => p.onSvgFeatures(p.svgFeatures.map((x) => (x.id === f.id ? { ...x, enabled: !x.enabled } : x)))}><Icon name={f.enabled ? 'eye' : 'eyeOff'} size={13} /></button>
                      <Icon name="shapes" size={13} />
                      <button className="object-child-name" title="Edit in the SVG tab" onClick={() => p.onEdit('svg')}>{f.drawing.name}</button>
                      <span className={`text-mode ${f.mode}`}>{f.mode === 'emboss' ? 'Raised' : 'Engraved'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <p className="dim small text-tip">Hidden parts are left out of the 3D view, the STL/3MF and Blender exports, validation and the Cost tab.</p>
    </div>
  );
}
