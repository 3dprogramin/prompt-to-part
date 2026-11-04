// Messages between the app's browser tabs (saves and running generations), over a BroadcastChannel.
import type { Design } from '../../shared/types';
import { uid } from './files';

export const TAB_ID = uid();

export type TabMessage =
  | { type: 'saved'; tab: string; design: Design }
  | { type: 'deleted'; tab: string; id: string }
  | { type: 'running'; tab: string; id: string; on: boolean }
  | { type: 'hello'; tab: string };

export const channel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('jig') : null;

/** Tell the other tabs (this tab's own id is added). */
export function tell(msg: DistributiveOmit<TabMessage, 'tab'>) {
  channel?.postMessage({ ...msg, tab: TAB_ID } as TabMessage);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
