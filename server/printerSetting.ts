// The user's printer choice (data/printer.json): which printer and how many filaments it loads at
// once. The server's current printer (shared/printer.ts) follows it.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config';
import { listPrinters } from './printers';
import { writeAtomically } from './routes/store';
import { clampFilaments, DEFAULT_PRINTER, setPrinter, type ActivePrinter, type Printer, type PrinterSetup } from '../shared/printer';
import type { PrinterInfo } from '../shared/api';

export const PRINTER_FILE = path.join(DATA_DIR, 'printer.json');

/** The saved printer in `list` with its filament count; the A1 0.4 (missing: true) when it isn't there. */
export function activePrinter(setup: PrinterSetup | null, list: Printer[]): { printer: ActivePrinter; missing: boolean } {
  const filaments = clampFilaments(setup?.filaments);
  const found = setup ? list.find((p) => p.id === setup.printerId) : list.find((p) => p.id === DEFAULT_PRINTER.id);
  const p = found ?? DEFAULT_PRINTER;
  // The built-in A1 entry (no Bambu Studio) still names its Bambu presets, as Jig always did.
  const presets = p.presets ?? (p.id === DEFAULT_PRINTER.id ? DEFAULT_PRINTER.presets : null);
  return { printer: { ...p, presets, filaments }, missing: !!setup && !found };
}

async function readSetup(): Promise<PrinterSetup | null> {
  try {
    const o = JSON.parse(await readFile(PRINTER_FILE, 'utf8')) as Partial<PrinterSetup>;
    return typeof o.printerId === 'string' && o.printerId ? { printerId: o.printerId, filaments: clampFilaments(o.filaments) } : null;
  } catch {
    return null;
  }
}

async function writeSetup(s: PrinterSetup): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeAtomically(PRINTER_FILE, JSON.stringify(s));
}

/** Jig was used before printers could be chosen: it has designs or a Bambu Studio template. */
async function existingInstall(): Promise<boolean> {
  if (existsSync(path.join(DATA_DIR, 'bambu', 'template.json'))) return true;
  return (await readdir(path.join(DATA_DIR, 'designs')).catch(() => [])).length > 0;
}

let loaded: Promise<PrinterInfo> | null = null;

/**
 * Reads the saved printer and makes it the server's current one. With nothing saved, an existing
 * install keeps the A1 (saved now, no question); a new one is a first start (the app asks).
 */
export function loadPrinterSetting(): Promise<PrinterInfo> {
  const job = (async () => {
    let setup = await readSetup();
    const firstStart = !setup && !(await existingInstall());
    if (!setup && !firstStart) await writeSetup((setup = { printerId: DEFAULT_PRINTER.id, filaments: DEFAULT_PRINTER.filaments }));
    const printers = await listPrinters(true);
    const { printer, missing } = activePrinter(setup, printers);
    setPrinter(printer);
    return { printer, printers, firstStart, missing };
  })();
  loaded = job;
  return job;
}

/** The saved printer has been read (the first load, started when the server starts). */
export function printerLoaded(): Promise<PrinterInfo> {
  return loaded ?? loadPrinterSetting();
}

/** Saves the user's choice and makes it current; rejects a printer that isn't in the list. */
export async function savePrinterSetting(s: PrinterSetup): Promise<PrinterInfo> {
  const printers = await listPrinters();
  if (!printers.some((p) => p.id === s.printerId)) throw new Error(`There is no printer "${s.printerId}"`);
  await writeSetup({ printerId: s.printerId, filaments: clampFilaments(s.filaments) });
  return loadPrinterSetting();
}
