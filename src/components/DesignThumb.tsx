import { useEffect, useRef, useState } from 'react';
import type { DesignSummary } from '../../shared/types';
import { DESIGN_KIND_LABEL, type DesignKind } from '../../shared/designKind';
import { designThumbInfo, designThumbUrl } from '../lib/api';
import { whenShort } from '../lib/when';
import { Icon } from './Icon';

/** Each kind's icon, as in the chat's picture menu; a plain parametric model has none. */
export const KIND_ICON: Partial<Record<DesignKind, string>> = { lineart: 'lineart', layertone: 'layers', lithophane: 'lamp', figure: 'figure', artwork: 'palette' };

/** Seconds between asking again for a picture the server has not drawn yet, and how often to ask. */
const RETRY_MS = 5000;
const MAX_TRIES = 12;

/** The picture itself, over the tile's icon: shown once loaded; asks again while the server is "not yet". */
function ThumbImage({ id, thumb }: { id: string; thumb: string }) {
  const [loaded, setLoaded] = useState(false);
  const [tries, setTries] = useState(0);
  const [dead, setDead] = useState(false);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, []);
  // An image can't tell a 404 (no picture, for good) from a 503 (not drawn yet): the info route can.
  const failed = () => {
    if (dead || tries >= MAX_TRIES) return;
    const again = (ms: number) => { timer.current = setTimeout(() => { if (alive.current) setTries((t) => t + 1); }, ms); };
    designThumbInfo(id, thumb).then((info) => {
      if (!alive.current) return;
      if (info === null) setDead(true);
      else again(info === 'pending' ? RETRY_MS : 0);
    }, () => { if (alive.current) again(RETRY_MS); });
  };
  if (dead) return null;
  const url = designThumbUrl(id, thumb);
  return <img className={loaded ? 'loaded' : ''} loading="lazy" decoding="async" alt="" src={tries ? `${url}&r=${tries}` : url} onLoad={() => setLoaded(true)} onError={failed} />;
}

/** A square picture of the design's latest version on a dark tile; its kind's icon until the picture is there. */
export function DesignThumb({ design, size }: { design: DesignSummary; size: number }) {
  const icon = (design.kind && KIND_ICON[design.kind]) || 'cube';
  return (
    <span className="design-thumb" style={{ width: size, height: size }} aria-hidden="true">
      <Icon name={icon} size={Math.round(size / 3)} />
      {design.thumb && <ThumbImage key={`${design.id}:${design.thumb}`} id={design.id} thumb={design.thumb} />}
    </span>
  );
}

/** Its overall size in mm, once the server has it (not while it is drawing, or for no picture). */
function useThumbSize(design: DesignSummary): [number, number, number] | null {
  const [size, setSize] = useState<[number, number, number] | null>(null);
  useEffect(() => {
    setSize(null);
    const key = design.thumb;
    if (!key) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (n: number) => {
      designThumbInfo(design.id, key).then((info) => {
        if (!live) return;
        if (info && info !== 'pending') setSize(info.size);
        else if (info === 'pending' && n < MAX_TRIES) timer = setTimeout(() => ask(n + 1), RETRY_MS);
      }, () => { /* the line just has no size */ });
    };
    ask(1);
    return () => { live = false; clearTimeout(timer); };
  }, [design.id, design.thumb]);
  return size;
}

/** The larger picture shown beside the menu for the design pointed at: its name, kind, size, versions and date. */
export function DesignPreview({ design }: { design: DesignSummary }) {
  const size = useThumbSize(design);
  const kind = design.kind && design.kind !== 'model' ? DESIGN_KIND_LABEL[design.kind] : '3D model';
  const parts = [kind, size && size.map((n) => Math.round(n)).join(' x ') + ' mm', `${design.versions} ${design.versions === 1 ? 'version' : 'versions'}`, whenShort(design.updatedAt)];
  return (
    <>
      <DesignThumb design={design} size={260} />
      <div className="design-preview-name">{design.name}</div>
      <div className="dim small">{parts.filter(Boolean).join(' · ')}</div>
    </>
  );
}
