import { useMemo, useState } from 'react';
import type { EvalResult } from '../../shared/types';
import { MIN_MODULE, newQrFeature, nextQrName, qrMatrix, qrPayload, type QrEcc, type QrFeature, type WifiSecurity } from '../../shared/qrFeatures';
import { uid } from '../lib/files';
import { Icon } from './Icon';
import { Placement, Row, Seg, Slider } from './PlacementControls';

interface Props {
  result: EvalResult | null;
  features: QrFeature[];
  onChange: (features: QrFeature[]) => void;
  picking: string | null;
  onPick: (featureId: string | null) => void;
}

const ECC_HINT: Record<QrEcc, string> = {
  L: 'Low: smallest code, reads while 7 % is lost.',
  M: 'Medium: reads while 15 % is lost (a good default).',
  Q: 'Quartile: reads while 25 % is lost.',
  H: 'High: reads while 30 % is lost (scuffs, a small logo on top).',
};

/** QR code tab: a scannable code on the model, a white tile and black modules printed as their own parts. */
export function QrPanel({ result, features, onChange, picking, onPick }: Props) {
  const [selected, setSelected] = useState<string | null>(features[0]?.id ?? null);
  const sel = features.find((f) => f.id === selected) ?? null;
  // The model's own parts (a QR code's tile and modules are not places to put things).
  const parts = result?.parts.filter((p) => !p.qr).map((p) => p.name) ?? [];

  const update = (id: string, patch: Partial<QrFeature>) => onChange(features.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const add = () => {
    const f = newQrFeature(uid(), { part: parts[0], name: nextQrName(features) });
    onChange([...features, f]);
    setSelected(f.id);
  };
  const remove = (id: string) => {
    onChange(features.filter((f) => f.id !== id));
    if (selected === id) setSelected(null);
  };
  const duplicate = (f: QrFeature) => {
    const copy = { ...f, id: uid(), name: nextQrName(features), offset: [f.offset[0] + f.size * 1.2, f.offset[1]] as [number, number] };
    onChange([...features, copy]);
    setSelected(copy.id);
  };

  if (!result) return <div className="empty-note">Generate a model first, then add a QR code to it.</div>;

  return (
    <div className="text-panel">
      <div className="text-list">
        {features.map((f) => (
          <div key={f.id} className={`text-item ${f.id === selected ? 'on' : ''} ${f.enabled ? '' : 'off'}`} onClick={() => setSelected(f.id)}>
            <button className="text-select" aria-pressed={f.id === selected} aria-label={`Edit ${f.name}`} onClick={(e) => { e.stopPropagation(); setSelected(f.id); }}>
              <span className={`text-mode ${f.style === 'raised' ? 'emboss' : 'engrave'}`}>{f.style === 'raised' ? 'Raised' : 'Flush'}</span>
              <span className="text-preview qr-name">{f.name}</span>
              <span className="dim small qr-what">{f.kind === 'wifi' ? `Wi-Fi ${f.wifi.ssid}` : f.text.trim()}</span>
            </button>
            <button className="icon-btn" title={f.enabled ? 'Hide' : 'Show'} aria-label={f.enabled ? `Hide ${f.name}` : `Show ${f.name}`} onClick={(e) => { e.stopPropagation(); update(f.id, { enabled: !f.enabled }); }}><Icon name={f.enabled ? 'eye' : 'eyeOff'} size={14} /></button>
            <button className="icon-btn" title="Delete" aria-label={`Delete ${f.name}`} onClick={(e) => { e.stopPropagation(); remove(f.id); }}><Icon name="trash" size={14} /></button>
          </div>
        ))}
        <button className="btn ghost wide" onClick={add}><Icon name="plus" size={14} /> Add QR code</button>
      </div>

      {sel && <QrEditor key={sel.id} f={sel} parts={parts} picking={picking} onPick={onPick} onChange={(patch) => update(sel.id, patch)} onDuplicate={() => duplicate(sel)} />}
      <p className="dim small text-tip">The white tile and the black modules are parts of their own: they print in their own filaments (pick them in the Object tab). Scan the preview with your phone before printing.</p>
    </div>
  );
}

function QrEditor({ f, parts, picking, onPick, onChange, onDuplicate }: {
  f: QrFeature; parts: string[]; picking: string | null; onPick: (id: string | null) => void; onChange: (patch: Partial<QrFeature>) => void; onDuplicate: () => void;
}) {
  const payload = qrPayload(f);
  const matrix = useMemo(() => (payload ? qrMatrix(payload, f.ecc) : null), [payload, f.ecc]);
  const module = matrix ? f.size / (matrix.length + 2 * f.border) : 0;
  const wifi = (patch: Partial<QrFeature['wifi']>) => onChange({ wifi: { ...f.wifi, ...patch } });
  return (
    <div className="text-editor">
      <Row label="Name"><input className="text-param" aria-label="Name" value={f.name} maxLength={60} onChange={(e) => onChange({ name: e.target.value })} onBlur={(e) => { if (!e.target.value.trim()) onChange({ name: 'QR code' }); }} /></Row>
      <Row label="Holds">
        <Seg value={f.kind} options={[['text', 'Link or text'], ['wifi', 'Wi-Fi']]} onChange={(kind) => onChange({ kind })} />
      </Row>
      {f.kind === 'text'
        ? <textarea className="text-input" rows={2} aria-label="Link or text" value={f.text} onChange={(e) => onChange({ text: e.target.value })} placeholder="https://your-shop.com" />
        : (
          <div className="qr-wifi">
            <Row label="Network"><input className="text-param" aria-label="Network name" value={f.wifi.ssid} maxLength={64} onChange={(e) => wifi({ ssid: e.target.value })} placeholder="Network name" /></Row>
            <Row label="Security">
              <Seg<WifiSecurity> value={f.wifi.security} options={[['WPA', 'WPA/WPA2/WPA3'], ['WEP', 'WEP'], ['nopass', 'None']]} onChange={(security) => wifi({ security })} />
            </Row>
            {f.wifi.security !== 'nopass' && <Row label="Password"><input className="text-param" aria-label="Wi-Fi password" value={f.wifi.password} maxLength={128} onChange={(e) => wifi({ password: e.target.value })} autoComplete="off" spellCheck={false} /></Row>}
            <label className="check small"><input type="checkbox" checked={f.wifi.hidden} onChange={(e) => wifi({ hidden: e.target.checked })} /> Hidden network</label>
            <div className="hint-line">The password is printed inside the code: anyone who scans it can join.</div>
          </div>
        )}

      {!payload
        ? <div className="hint-line">{f.kind === 'wifi' ? 'Type the network name.' : 'Type a link or some text.'}</div>
        : !matrix
          ? <div className="bad-note small" role="alert">Too long for a QR code at this error correction: shorten it or pick a lower one.</div>
          : (
            <div className="qr-summary">
              <QrPreview matrix={matrix} border={f.border} />
              <div className="small">
                <div>{matrix.length} × {matrix.length} modules, each {module.toFixed(2)} mm</div>
                {module < MIN_MODULE
                  ? <div className="warn-note" role="status">Modules under {MIN_MODULE} mm are hard to print sharply: make the code bigger, shorten the content or lower the error correction.</div>
                  : <div className="dim">Prints well with a 0.4 mm nozzle.</div>}
              </div>
            </div>
          )}

      <Slider label="Size (with the quiet zone)" unit="mm" min={10} max={150} step={0.5} value={f.size} onChange={(size) => onChange({ size })} />
      <Row label="Error correction">
        <Seg<QrEcc> value={f.ecc} options={[['L', 'L'], ['M', 'M'], ['Q', 'Q'], ['H', 'H']]} onChange={(ecc) => onChange({ ecc })} />
      </Row>
      <div className="hint-line">{ECC_HINT[f.ecc]}</div>
      <Slider label="Quiet zone" unit="modules" min={0} max={4} step={1} value={f.border} onChange={(border) => onChange({ border: Math.round(border) })} />
      <div className="hint-line">The plain margin round the code: 4 is the standard, most phones read 2.</div>

      <h4>Print</h4>
      <label className="check"><input type="checkbox" checked={f.tile} onChange={(e) => onChange({ tile: e.target.checked })} /> White tile under the code</label>
      {f.tile
        ? <Slider label="Tile height" unit="mm" min={0.2} max={5} step={0.1} value={f.tileHeight} onChange={(tileHeight) => onChange({ tileHeight })} />
        : <div className="hint-line">The model's surface is the white: give that part a light filament.</div>}
      <Row label="Modules">
        <Seg value={f.style} options={[['raised', 'Raised'], ['flush', 'Flush']]} onChange={(style) => onChange({ style })} />
      </Row>
      <Slider label={f.style === 'raised' ? 'Module height' : 'Inlay depth'} unit="mm" min={0.2} max={5} step={0.1} value={f.depth} onChange={(depth) => onChange({ depth })} />
      <div className="hint-line">{f.style === 'raised' ? 'The black modules stand on the white.' : 'The black is inlaid level with the white: a smooth top, best printed face up.'}</div>

      <Placement f={f} parts={parts} picking={picking} onPick={onPick} onChange={onChange} />

      <h4>Shape</h4>
      <Row label="Curve">
        <Seg value={f.curve === 'wrap' ? 'wrap' : 'none'} options={[['none', 'Flat'], ['wrap', 'Wrap']]} onChange={(curve) => onChange({ curve })} />
      </Row>
      {f.curve === 'wrap' && <Slider label="Wrap radius (0 = auto)" unit="mm" min={0} max={200} step={0.5} value={f.wrapRadius} onChange={(wrapRadius) => onChange({ wrapRadius })} />}
      <button className="btn ghost wide" onClick={onDuplicate}>Duplicate</button>
    </div>
  );
}

/** The code as it will print, black on white, quiet zone included. */
function QrPreview({ matrix, border }: { matrix: boolean[][]; border: number }) {
  const n = matrix.length + 2 * border;
  const d = useMemo(() => matrix.flatMap((row, r) => row.map((on, c) => (on ? `M${c + border} ${r + border}h1v1h-1z` : ''))).join(''), [matrix, border]);
  return (
    <svg className="qr-preview" viewBox={`0 0 ${n} ${n}`} role="img" aria-label="QR code preview" shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
