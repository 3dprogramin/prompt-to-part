// The Printer tab of Settings: the same form as the first-start dialog, but every change is saved at once.
import { useEffect, useRef, useState } from 'react';
import type { PrinterInfo } from '../../../shared/api';
import type { PrinterSetup } from '../../../shared/printer';
import { PrinterForm } from '../PrinterPicker';

interface Props {
  info: PrinterInfo | null;
  onPrinter: (setup: PrinterSetup) => Promise<void>;
}

export function PrinterTab({ info, onPrinter }: Props) {
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Only the latest save reports; an older one finishing late must not overwrite it.
  const latest = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!info) return <p className="dim">Loading the printer list…</p>;

  const save = async (setup: PrinterSetup | null) => {
    if (!setup) return;
    const id = ++latest.current;
    clearTimeout(timer.current);
    setNote(null);
    try {
      await onPrinter(setup);
      if (id !== latest.current) return;
      setNote({ text: 'Saved' });
      timer.current = setTimeout(() => setNote(null), 2000);
    } catch (e) {
      if (id === latest.current) setNote({ text: (e as Error).message, error: true });
    }
  };

  return (
    <div className="settings-printer">
      <p>Every design follows it: the plate, the checks, the AI's instructions and the Bambu Studio project. Changes are saved as you make them.</p>
      <PrinterForm info={info} onChange={(s) => void save(s)} />
      <p className={`small settings-saved ${note?.error ? 'warn-note' : 'dim'}`} role={note?.error ? 'alert' : 'status'}>{note?.text ?? ''}</p>
    </div>
  );
}
