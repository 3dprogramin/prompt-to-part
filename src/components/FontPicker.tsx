import { useEffect, useMemo, useRef, useState } from 'react';
import type { FontEntry } from '../lib/api';

// Load fonts into the browser for previews (once per id).
const loaded = new Map<string, Promise<string | null>>();
export function previewFamily(id: string): Promise<string | null> {
  let p = loaded.get(id);
  if (!p) {
    p = (async () => {
      try {
        const r = await fetch(`/api/fonts/data?id=${encodeURIComponent(id)}`);
        if (!r.ok) return null;
        const { files } = (await r.json()) as { files: string[] };
        const family = `pv-${loaded.size}-${id.replace(/[^a-z0-9]/gi, '')}`;
        for (const b64 of files) {
          const face = new FontFace(family, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
          document.fonts.add(await face.load());
        }
        return family;
      } catch {
        return null;
      }
    })();
    loaded.set(id, p);
  }
  return p;
}

function usePreview(id: string, enabled = true) {
  const [family, setFamily] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    previewFamily(id).then((f) => alive && setFamily(f));
    return () => { alive = false; };
  }, [id, enabled]);
  return family;
}

export function fontLabel(fonts: FontEntry[], id: string) {
  const f = fonts.find((x) => x.id === id);
  return f ? `${f.family} ${f.style}` : id.replace(/^(std|sys):/, '').replace('|', ' ');
}

export function FontPicker({ fonts, value, onChange }: { fonts: FontEntry[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const family = usePreview(value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? fonts.filter((f) => `${f.family} ${f.style}`.toLowerCase().includes(s)) : fonts;
  }, [fonts, q]);
  const std = filtered.filter((f) => f.source === 'standard');
  const sys = filtered.filter((f) => f.source === 'installed');

  return (
    <div className="font-picker" ref={wrap}>
      <button className="font-current" onClick={() => setOpen(!open)} style={{ fontFamily: family ?? undefined }}>
        {fontLabel(fonts, value)}
      </button>
      {open && (
        <div className="font-menu">
          <input autoFocus placeholder="Search fonts…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="font-list">
            {std.length > 0 && <div className="font-group">Standard</div>}
            {std.map((f) => <FontRow key={f.id} f={f} on={f.id === value} pick={() => { onChange(f.id); setOpen(false); }} />)}
            {sys.length > 0 && <div className="font-group">Installed on this computer ({sys.length})</div>}
            {sys.map((f) => <FontRow key={f.id} f={f} on={f.id === value} pick={() => { onChange(f.id); setOpen(false); }} />)}
            {!filtered.length && <div className="font-empty">No fonts match</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function FontRow({ f, on, pick }: { f: FontEntry; on: boolean; pick: () => void }) {
  const el = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); io.disconnect(); } });
    if (el.current) io.observe(el.current);
    return () => io.disconnect();
  }, []);
  const family = usePreview(f.id, visible);
  return (
    <button ref={el} className={`font-row ${on ? 'on' : ''}`} onClick={pick}>
      <span className="font-sample" style={{ fontFamily: family ?? 'inherit', opacity: family ? 1 : 0.4 }}>{f.family}</span>
      <span className="font-style">{f.style}</span>
    </button>
  );
}
