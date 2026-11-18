import { useEffect, useRef, useState } from 'react';
import type { DesignSummary } from '../../shared/types';
import { DESIGN_KIND_LABEL, type DesignKind } from '../../shared/designKind';
import { designThumbInfo, designThumbUrl } from '../lib/api';
import { whenShort } from '../lib/when';
import { Icon } from './Icon';
import { nextTry, type ThumbInfo } from './designThumbRetry';

/** Each kind's icon, as in the chat's picture menu; a plain parametric model has none. */
export const KIND_ICON: Partial<Record<DesignKind, string>> = { lineart: 'lineart', layertone: 'layers', lithophane: 'lamp', figure: 'figure', artwork: 'palette' };

/** The picture itself, over the tile's icon: shown once loaded; asks again (nextTry) while the server says "not yet". */
function ThumbImage({ id, thumb }: { id: string; thumb: string }) {
  const [loaded, setLoaded] = useState(false);
  // Loads asked again so far (the first load is not one).
  const [reloads, setReloads] = useState(0);
  const [dead, setDead] = useState(false);
  const alive = useRef(true);
  // An ask under way (the info, then the wait): a second error event starts no second one.
  const asking = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, []);
  // An image can't tell a 404 (no picture, for good) from a 503 (not drawn yet): the info route can.
  const failed = () => {
    if (dead || asking.current) return;
    asking.current = true;
    const tries = reloads + 1;
    const next = (info: ThumbInfo | 'error') => {
      if (!alive.current) return;
      const ms = nextTry(tries, info);
      if (ms === null) return void setDead(true);
      timer.current = setTimeout(() => { asking.current = false; if (alive.current) setReloads(tries); }, ms);
    };
    designThumbInfo(id, thumb).then(next, () => next('error'));
  };
  if (dead) return null;
  const url = designThumbUrl(id, thumb);
  return <img className={loaded ? 'loaded' : ''} loading="lazy" decoding="async" alt="" src={reloads ? `${url}&r=${reloads}` : url} onLoad={() => setLoaded(true)} onError={failed} />;
}

/**
 * A square picture of the design's latest version on a dark tile; its kind's icon until the picture is
 * there. Decorative (hidden from screen readers, never focused): `onClick` only repeats what the row's
 * open button does, for the pointer.
 */
export function DesignThumb({ design, size, onClick }: { design: DesignSummary; size: number; onClick?: () => void }) {
  const icon = (design.kind && KIND_ICON[design.kind]) || 'cube';
  return (
    <span className={`design-thumb ${onClick ? 'opens' : ''}`} style={{ width: size, height: size }} aria-hidden="true" onClick={onClick}>
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
      const next = (info: ThumbInfo | 'error') => {
        if (!live) return;
        if (info && info !== 'pending' && info !== 'error') return void setSize(info.size);
        const ms = nextTry(n, info);
        if (ms !== null) timer = setTimeout(() => ask(n + 1), ms);
      };
      designThumbInfo(design.id, key).then(next, () => next('error'));
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
  const parts = [kind, `${design.versions} ${design.versions === 1 ? 'version' : 'versions'}`, `changed ${whenShort(design.updatedAt)}`];
  return (
    <>
      <DesignThumb design={design} size={260} />
      <div className="design-preview-name">{design.name}</div>
      <div className="dim small">{parts.join(' · ')}</div>
      {/* Its own line, kept in place while the size is on its way, so nothing moves when it arrives. */}
      <div className="dim small design-preview-size">{size ? `${size.map((n) => Math.round(n)).join(' x ')} mm` : '\u00a0'}</div>
    </>
  );
}
