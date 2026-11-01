// What a print costs: filament from Bambu Studio's slice (the grams it will extrude, purge and prime
// tower included) and, only when the user has measured their printer, electricity.

import { DEFAULT_PRINTER } from './printer';
import type { ParamValues } from './types';
import type { PrintProfile } from './print';

/** Costs are in US dollars unless the server says otherwise (JIG_CURRENCY). */
export const DEFAULT_CURRENCY = 'USD';

/** An ISO 4217 currency code (USD, EUR, RON…), upper-cased, or null when it isn't one. */
export function parseCurrency(raw: string | undefined): string | null {
  const c = raw?.trim().toUpperCase();
  if (!c || !/^[A-Z]{3}$/.test(c)) return null;
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: c });
    return c;
  } catch {
    return null;
  }
}

// The page's currency: set once from the server's capabilities (setCurrency); the server passes its own.
let pageCurrency = DEFAULT_CURRENCY;
export const currency = () => pageCurrency;
export function setCurrency(c: string | undefined) { pageCurrency = parseCurrency(c) ?? DEFAULT_CURRENCY; }

/** What Bambu Studio reports for a sliced plate. */
export interface SliceStats {
  /** Bambu Studio's estimate of the whole print, in seconds. */
  seconds: number;
  /** Filament used, in grams (all filaments, purge and prime tower included). */
  grams: number;
  filaments: { color: string; grams: number }[];
}

/**
 * What a cost calculation is made from (the script, values, hidden parts, print settings and
 * "Print in one colour"): a result with another key is out of date.
 */
export function costKey(code: string, values: ParamValues, hiddenParts: string[], userPrint: PrintProfile, oneColour: null | 'main' | string, printerId: string): string {
  // The A1 0.4 (Jig's printer before it could be chosen) keeps the old key, so slices saved then stay valid.
  return JSON.stringify(printerId === DEFAULT_PRINTER.id ? [code, values, hiddenParts, userPrint, oneColour] : [code, values, hiddenParts, userPrint, oneColour, printerId]);
}

/** The user's prices, and their printer's measured average power. Unset values are left out of the cost. */
export interface CostSettings {
  /** Price of a 1 kg filament roll. */
  filamentPerKg?: number;
  /** Price of one kWh of electricity. */
  electricityPerKwh?: number;
  /**
   * The printer's average power while printing, measured (e.g. with a plug-in meter: kWh used by a
   * print ÷ its hours × 1000). A printer's rated power (the A1's 1300 W) is its peak while the bed heats, not an average.
   */
  averageWatts?: number;
}

/** Typical prices of a 1 kg PLA roll and a kWh in a few currencies; in others the Cost tab asks for them. */
const TYPICAL_PRICES: Record<string, CostSettings> = {
  USD: { filamentPerKg: 20, electricityPerKwh: 0.17 },
  EUR: { filamentPerKg: 20, electricityPerKwh: 0.25 },
  GBP: { filamentPerKg: 18, electricityPerKwh: 0.25 },
  RON: { filamentPerKg: 140, electricityPerKwh: 1.45 },
};

/** What the Cost tab starts from until the user saves their own prices and printer: typical prices in `c`, and 200 W. */
export function defaultCostSettings(c: string): CostSettings {
  return { ...TYPICAL_PRICES[c], averageWatts: 200 };
}

export interface CostBreakdown {
  /** null: no filament price set. */
  filament: number | null;
  /** null: no electricity price or measured power set. */
  electricity: number | null;
  /** Electricity used, in kWh (null without a measured power). */
  kwh: number | null;
  /** Sum of the costs that could be worked out. */
  total: number;
}

export function costOf(stats: SliceStats, s: CostSettings): CostBreakdown {
  const filament = s.filamentPerKg != null ? (stats.grams / 1000) * s.filamentPerKg : null;
  const kwh = s.averageWatts != null ? (s.averageWatts * stats.seconds) / 3600 / 1000 : null;
  const electricity = kwh != null && s.electricityPerKwh != null ? kwh * s.electricityPerKwh : null;
  return { filament, electricity, kwh, total: (filament ?? 0) + (electricity ?? 0) };
}

/** Settings as stored: only positive, finite numbers. */
export function cleanCostSettings(raw: unknown): CostSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: CostSettings = {};
  for (const k of ['filamentPerKg', 'electricityPerKwh', 'averageWatts'] as const) {
    const v = Number(o[k]);
    if (o[k] != null && o[k] !== '' && Number.isFinite(v) && v > 0 && v < 1e6) out[k] = v;
  }
  return out;
}

/** "$12.50", "€12.50", "RON 12.50" */
export const money = (v: number, c = pageCurrency) => new Intl.NumberFormat('en', { style: 'currency', currency: c }).format(v);

/** "3 h 53 min" */
export function duration(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
