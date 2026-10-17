// What a print costs: filament from Bambu Studio's slice (the grams it will extrude, purge and prime
// tower included) and, only when the user has measured their printer, electricity.

/** Costs are in Romanian lei. */
export const CURRENCY = 'RON';

/** What Bambu Studio reports for a sliced plate. */
export interface SliceStats {
  /** Bambu Studio's estimate of the whole print, in seconds. */
  seconds: number;
  /** Filament used, in grams (all filaments, purge and prime tower included). */
  grams: number;
  filaments: { color: string; grams: number }[];
}

/** The user's prices, and their printer's measured average power. Unset values are left out of the cost. */
export interface CostSettings {
  /** Price of a 1 kg filament roll. */
  filamentPerKg?: number;
  /** Price of one kWh of electricity. */
  electricityPerKwh?: number;
  /**
   * The printer's average power while printing, measured (e.g. with a plug-in meter: kWh used by a
   * print ÷ its hours × 1000). The A1's 1300 W rating is its peak while the bed heats, not an average.
   */
  averageWatts?: number;
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

export const money = (v: number) => `${v.toFixed(2)} ${CURRENCY}`;

/** "3 h 53 min" */
export function duration(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
