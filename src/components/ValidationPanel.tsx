import type { Severity, ValidationIssue, ValidationReport } from '../geometry/validate';
import { Icon } from './Icon';

export interface ValidationState {
  report: ValidationReport;
  /** e.g. "Validated" or "Exported wine-opener.stl" */
  label: string;
}

export function summarize(issues: ValidationIssue[]): { text: string; level: 'ok' | Severity } {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  if (!errors && !warnings) return { text: 'No problems found', level: 'ok' };
  const parts = [errors && `${errors} error${errors > 1 ? 's' : ''}`, warnings && `${warnings} warning${warnings > 1 ? 's' : ''}`].filter(Boolean);
  return { text: parts.join(', '), level: errors ? 'error' : 'warning' };
}

const ICON: Record<Severity, string> = { error: 'alert', warning: 'alert', info: 'info' };

export function ValidationPanel({ state, highlight, onHighlight, onClose }: {
  state: ValidationState; highlight: boolean; onHighlight: (on: boolean) => void; onClose: () => void;
}) {
  const { report } = state;
  const sum = summarize(report.issues);
  const s = report.stats;
  const hasOverlay = report.overlay.overhang.length > 0 || report.overlay.thin.length > 0;
  return (
    <div className="validation-panel">
      <div className="vp-head">
        <div>
          <div className="vp-title">{state.label}</div>
          <div className={`vp-summary ${sum.level}`}><Icon name={sum.level === 'ok' ? 'check' : 'alert'} size={14} /> {sum.text}</div>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close"><Icon name="x" size={14} /></button>
      </div>
      <div className="vp-stats mono">
        <span title="Thinnest wall found">wall ≥ {s.minWall != null ? `${s.minWall.toFixed(2)} mm` : '–'}</span>
        <span title="Surface facing down steeper than 45°">overhang {s.overhangPct.toFixed(1)} %</span>
        <span title="Area touching the build plate">on plate {s.bedContact.toFixed(0)} mm²</span>
        <span>{(s.volume / 1000).toFixed(1)} cm³</span>
      </div>
      {report.issues.length > 0 && (
        <ul className="vp-issues">
          {report.issues.map((i, k) => (
            <li key={k} className={i.severity}>
              <Icon name={ICON[i.severity]} size={14} />
              <div><b>{i.title}</b><span>{i.detail}</span></div>
            </li>
          ))}
        </ul>
      )}
      {hasOverlay && (
        <label className="check vp-highlight">
          <input type="checkbox" checked={highlight} onChange={(e) => onHighlight(e.target.checked)} />
          Highlight on model <span className="dim">(<i className="sw red" /> overhang, <i className="sw orange" /> thin wall)</span>
        </label>
      )}
    </div>
  );
}
