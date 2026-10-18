import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { clearUsage, limitResetsAt, recordRateLimit, recordUsage, usageWindows } from '../server/usage';
import { formatReset, usageSummary, type UsageWindow } from '../shared/usage';

const NOW = new Date(2026, 9, 18, 14, 0).getTime(); // Sun 18 Oct 2026, 14:00 local time
const HOUR = 3600_000;
const sec = (ms: number) => Math.round(ms / 1000);

test('reset times: the time today, the weekday and time on another day', () => {
  assert.equal(formatReset(new Date(2026, 9, 18, 18, 40).getTime(), NOW), '18:40');
  assert.equal(formatReset(new Date(2026, 9, 19, 9, 0).getTime(), NOW), 'Mon 09:00');
});

test('the chip: the most-used window, amber from 80 %, red while a limit is reached', () => {
  const w = (percent: number, extra: Partial<UsageWindow> = {}): UsageWindow => ({ kind: 'five_hour', label: '5-hour', percent, limited: false, at: NOW, ...extra });
  assert.equal(usageSummary([], NOW), null);
  assert.deepEqual(usageSummary([w(62), w(30, { kind: 'seven_day' })], NOW), { percent: 62, level: 'ok' });
  assert.equal(usageSummary([w(10), w(85, { kind: 'seven_day' })], NOW)?.level, 'warn');
  assert.deepEqual(usageSummary([w(100, { limited: true, resetsAt: NOW + HOUR })], NOW), { percent: 100, level: 'limited', until: NOW + HOUR });
  // Once its reset time has passed, a window starts again from 0 %.
  assert.deepEqual(usageSummary([w(100, { limited: true, resetsAt: NOW - 1 })], NOW), { percent: 0, level: 'ok' });
});

test('replies report the windows: the limiting one, and both when Claude Code sends them', () => {
  clearUsage();
  recordRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.62, resetsAt: sec(NOW + 2 * HOUR) }, NOW);
  assert.deepEqual(usageWindows(NOW).map((w) => [w.kind, w.label, Math.round(w.percent), w.resetsAt, w.limited]), [['five_hour', '5-hour', 62, NOW + 2 * HOUR, false]]);
  // The undocumented per-window field (both windows on every event).
  const info = { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.81, resetsAt: sec(NOW + 50 * HOUR),
    unifiedWindows: { five_hour: { utilization: 0.7, resetsAt: sec(NOW + 2 * HOUR) }, seven_day: { utilization: 0.81, resetsAt: sec(NOW + 50 * HOUR) } } } as SDKRateLimitInfo;
  recordRateLimit(info, NOW + 1000);
  assert.deepEqual(usageWindows(NOW).map((w) => [w.kind, Math.round(w.percent)]), [['five_hour', 70], ['seven_day', 81]]);
  assert.equal(limitResetsAt(NOW), undefined);
  // Refused: the limit is reached until the window resets.
  recordRateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: sec(NOW + 2 * HOUR) }, NOW + 2000);
  assert.equal(usageWindows(NOW).find((w) => w.kind === 'five_hour')?.limited, true);
  assert.equal(limitResetsAt(NOW), NOW + 2 * HOUR);
  assert.equal(limitResetsAt(NOW + 3 * HOUR), undefined, 'reset since');
  // An older report doesn't overwrite a newer one.
  recordRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1 }, NOW);
  assert.equal(usageWindows(NOW).find((w) => w.kind === 'five_hour')?.limited, true);
});

test('Claude Code\'s /usage data: percentages and ISO reset times, per-model windows', () => {
  clearUsage();
  recordUsage({
    five_hour: { utilization: 7, resets_at: new Date(NOW + HOUR).toISOString() },
    seven_day: { utilization: 64, resets_at: new Date(NOW + 46 * HOUR).toISOString() },
    seven_day_opus: null,
    model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: new Date(NOW + 47 * HOUR).toISOString() }],
  }, NOW);
  assert.deepEqual(usageWindows(NOW).map((w) => [w.label, w.percent, w.resetsAt, w.limited]), [
    ['5-hour', 7, NOW + HOUR, false],
    ['7-day', 64, NOW + 46 * HOUR, false],
    ['7-day Fable', 0, NOW + 47 * HOUR, false],
  ]);
  // A reply's report of the same model window keeps its name.
  recordRateLimit({ status: 'allowed', rateLimitType: 'seven_day_overage_included', utilization: 0.05 }, NOW + 1000);
  assert.equal(usageWindows(NOW).find((w) => w.kind === 'seven_day_overage_included')?.label, '7-day Fable');
  recordUsage({ five_hour: { utilization: 100, resets_at: new Date(NOW + HOUR).toISOString() } }, NOW + 2000);
  assert.equal(limitResetsAt(NOW), NOW + HOUR);
  clearUsage();
});
