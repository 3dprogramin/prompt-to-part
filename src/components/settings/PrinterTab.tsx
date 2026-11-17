// The Printer tab of Settings: the same form as the first-start dialog, but every change is saved at once.
import { useEffect, useRef, useState } from 'react';
import type { PrinterInfo } from '../../../shared/api';
import type { PrinterSetup } from '../../../shared/printer';
import { PrinterForm } from '../PrinterPicker';
import { latestWins } from './latestWins';

interface Props {
  info: PrinterInfo | null;
  onPrinter: (setup: PrinterSetup) => Promise<void>;
}

export function PrinterTab({ info, onPrinter }: Props) {
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onPrinterRef = useRef(onPrinter);
  onPrinterRef.current = onPrinter;
  // One save at a time, the newest change next: answers can't arrive (or be written) out of order.
  const enqueue = useRef<(s: PrinterSetup) => void>(undefined);
  enqueue.current ??= latestWins<PrinterSetup>((s) => onPrinterRef.current(s), {
    onStart: () => { clearTimeout(timer.current); setNote(null); },
    onSaved: () => { setNote({ text: 'Saved' }); timer.current = setTimeout(() => setNote(null), 2000); },
    onFailed: (e) => setNote({ text: e.message, error: true }),
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!info) return <p className="dim">Loading the printer list…</p>;

  return (
    <div className="settings-printer">
      <p>Every design follows it: the plate, the checks, the AI's instructions and the Bambu Studio project. Changes are saved as you make them.</p>
      <PrinterForm info={info} onChange={(s) => { if (s) enqueue.current?.(s); }} />
      <p className={`small settings-saved ${note?.error ? 'warn-note' : 'dim'}`} role={note?.error ? 'alert' : 'status'}>{note?.text ?? ''}</p>
    </div>
  );
}
