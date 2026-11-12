import { whenFull, whenShort } from '../lib/when';
import { Icon } from './Icon';

interface Props {
  /** The printed version's index (0-based). */
  v: number;
  /** When it was marked. */
  at: number;
  /** A 3MF was saved with the mark. */
  file: boolean;
  /** The saved 3MF has print settings in it. */
  settings: boolean;
  fileUrl: string;
  /** "New design from vN": the way to change a printed version. */
  onClone: () => void;
  /** Builds the 3MF again, for a mark saved without one. */
  onMake3mf: () => void;
  /** Why Make 3MF can't run now, or null. */
  makeDisabled?: string | null;
  /** The 3MF is being made. */
  making?: boolean;
  /** Takes the mark away (asks first). */
  onUnmark: () => void;
}

/** Over the 3D view while a printed version is shown: it is locked, its 3MF and how to change it. */
export function PrintedBanner({ v, at, file, settings, fileUrl, onClone, onMake3mf, makeDisabled, making, onUnmark }: Props) {
  return (
    <span className="printed-banner">
      <Icon name="printer" size={13} />
      <b>Printed v{v + 1} · locked</b>
      <time className="dim" title={`Marked ${whenFull(at)}`}>{whenShort(at)}</time>
      {file
        ? <span><a className="link" href={fileUrl} download title="The 3MF saved when it was marked">Download 3MF</a>{!settings && <span className="dim"> (no print settings)</span>}</span>
        : making
          ? <span><span className="spinner" /> Making the 3MF…</span>
          : <button className="link" disabled={!!makeDisabled} onClick={onMake3mf} title={makeDisabled ?? 'No 3MF was saved when it was marked: build it now'}>Make 3MF</button>}
      <button className="link" onClick={onClone} title={`A new design from v${v + 1}, free to change (this one stays as printed)`}>Clone to change</button>
      <button className="link" onClick={onUnmark} title={`Unmark v${v + 1}: deletes its saved 3MF and unlocks it`}>Unmark</button>
    </span>
  );
}
