// The photos panel's gallery: the photos being made (or failed) and the photos made, each with
// its size, scene, download and delete, picked several at a time or opened enlarged.
import type { ProductPhoto } from '../../../shared/types';
import { Icon } from '../Icon';
import { DeleteButton } from './DeleteButton';
import { lookOf, lookTitle, photoLabel, sceneLabel } from './photoHelpers';
import type { PhotoJob } from './usePhotoJobs';

interface Props {
  /** The open design's photos being made, and the photos shown (newest first). */
  jobs: PhotoJob[];
  photos: ProductPhoto[];
  picking: boolean;
  picked: ReadonlySet<string>;
  pickPhoto: (url: string, range: boolean) => void;
  openBig: (ph: ProductPhoto) => void;
  outdated: (ph: ProductPhoto) => string | null;
  refresh: (ph: ProductPhoto) => Promise<void>;
  sizeName: (s?: { id: string; label: string }) => string | undefined;
  nameOf: (ph: { scene: string; shop?: string; saleSize?: { id: string; label: string } }) => string;
  save: (ph: ProductPhoto, n: number) => Promise<void>;
  /** Date.now(), ticking (useTicker). */
  elapsed: number;
  p: { imageModel: string | null; onRetry: (jobId: string) => void; onDismiss: (jobId: string) => void; onDelete: (url: string) => void };
}

/** The tiles under the photos panel's controls (PhotosPanel). */
export function PhotoGallery({ jobs, photos, picking, picked, pickPhoto, openBig, outdated, refresh, sizeName, nameOf, save, elapsed, p }: Props) {
  return (
    <div className={`ph-gallery ${picking ? 'picking' : ''}`}>
      {jobs.map((j) => (
        <div key={j.id} className={`ph-tile pending ${j.error ? 'failed' : ''}`} role={j.error ? 'alert' : 'status'}>
          {j.error
            ? <><Icon name="alert" size={16} /><span className="small">{nameOf({ ...j, saleSize: j.request.saleSize })}: {j.error}</span>
              <span className="ph-job-actions">
                {p.imageModel && <button className="link" onClick={() => p.onRetry(j.id)}>Try again</button>}
                <button className="link" onClick={() => p.onDismiss(j.id)}>Dismiss</button>
              </span></>
            : <><span className="spinner" /><span className="small" title={j.change ?? (j.shop ? sceneLabel(j.scene) : undefined)}>{nameOf({ ...j, saleSize: j.request.saleSize })}{j.change && !j.request.resize ? ' · changed' : ''}</span>
              <span className="dim small mono">{j.waiting ? 'waiting' : `${Math.max(0, Math.round((elapsed - j.startedAt) / 1000))} s`}</span></>}
        </div>
      ))}
      {photos.map((ph, i) => {
        const old = outdated(ph);
        return (
          <div key={ph.url + ph.createdAt} className={`ph-tile ${old ? 'outdated' : ''} ${picking && picked.has(ph.url) ? 'picked' : ''}`}>
            <button className="ph-thumb" onClick={(e) => (picking ? pickPhoto(ph.url, e.shiftKey) : openBig(ph))}
              aria-label={picking ? `Pick the ${nameOf(ph)} photo` : `${nameOf(ph)} photo, enlarge`} aria-pressed={picking ? picked.has(ph.url) : undefined}>
              <img src={ph.url} alt="" loading="lazy" />
              {picking && <span className={`ph-pick ${picked.has(ph.url) ? 'on' : ''}`} aria-hidden="true"><Icon name="check" size={12} /></span>}
            </button>
            {old && <button className="ph-outdated" onClick={() => void refresh(ph)} disabled={!p.imageModel} title={`Out of date: ${old}. Click to make it again in the same scene (the old photo stays).`}><Icon name="restore" size={11} /> {old.startsWith('made for an') ? 'Design changed' : old.split(',')[0].replace('made', 'Made')}</button>}
            <div className="ph-tile-bar">
              {sizeName(ph.saleSize) && <b className="ph-size" title={`Size ${sizeName(ph.saleSize)}`}>{sizeName(ph.saleSize)}</b>}
              <span className="small" title={[ph.change ?? ph.notes ?? (ph.shop ? sceneLabel(ph.scene) : undefined), lookTitle(ph)].filter(Boolean).join('\n') || undefined}>
                {photoLabel(ph.scene, ph.shop)}{lookOf(ph).variant ? ` · ${lookOf(ph).variant}` : ''}{ph.editOf ? ' · changed' : ''}
              </span>
              <button className="icon-btn" onClick={() => void save(ph, photos.length - i)} title="Download" aria-label={`Download the ${nameOf(ph)} photo`}><Icon name="download" size={13} /></button>
              <DeleteButton label={`${nameOf(ph)} photo`} onDelete={() => p.onDelete(ph.url)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
