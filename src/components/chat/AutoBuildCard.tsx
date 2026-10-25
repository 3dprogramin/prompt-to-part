// The countdown card under a reply with new concept pictures ("Wait for my OK" off).
import { useEffect, useState } from 'react';
import { AUTO_BUILD_SECONDS, autoBuildText, type AutoBuild } from '../../lib/autoBuild';
import { Icon } from '../Icon';

/** The countdown under a reply that ended with new concept pictures: Build now, Stop, or the approval goes out by itself. */
export function AutoBuildCard({ a, onBuildNow, onStop }: { a: AutoBuild; onBuildNow: () => void; onStop: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((a.until - now) / 1000));
  return (
    <div className="auto-build" role="group" aria-label="Automatic build of the concept pictures">
      <div className="auto-build-head">
        <span className="auto-build-count" aria-hidden>{left}</span>
        <span className="auto-build-text">{autoBuildText(a.concepts, left)}</span>
      </div>
      <div className="auto-build-bar" aria-hidden><i style={{ animationDuration: `${AUTO_BUILD_SECONDS}s` }} /></div>
      <div className="auto-build-actions">
        <button className="btn primary" onClick={onBuildNow}><Icon name="cube" size={13} /> Build now</button>
        <button className="btn" onClick={onStop}><Icon name="stop" size={13} /> Stop</button>
        <span className="dim small">or type a change</span>
      </div>
    </div>
  );
}
