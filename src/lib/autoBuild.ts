// 3D figure mode with "Wait for my OK" off: a reply that ends with new concept pictures is
// approved by itself after a short countdown. The approval is an ordinary user message, so the
// server's guard (no generate_3d from a concept drawn in the same reply) and the per-reply Meshy
// limit work as for one the user types.
import { meshyCredits } from '../../shared/meshes';

/** Seconds the countdown card waits before it sends the approval. */
export const AUTO_BUILD_SECONDS = 10;

/** A concept picture drawn in a reply (its `concept` event): `color` = drawn for a coloured figure. */
export interface DrawnConcept { name: string; color: boolean }

/** A countdown under the reply `messageId` of the design `designId`, sending the approval at `until` (ms). */
export interface AutoBuild { designId: string; messageId: string; concepts: DrawnConcept[]; until: number }

/** The concepts drawn in a reply, each once (a picture drawn again under its name counts as it was drawn last). */
export function drawnConcepts(events: DrawnConcept[]): DrawnConcept[] {
  const byName = new Map<string, DrawnConcept>();
  for (const c of events) { byName.delete(c.name); byName.set(c.name, c); }
  return [...byName.values()];
}

/**
 * The countdown to start when a reply has ended, or null: only for a reply that ended normally
 * (no error, not stopped) with new concept pictures, on the design open in this tab, with
 * "Wait for my OK" off and no message of the user's waiting to go out after it.
 */
export function autoBuildAfter(reply: {
  designId: string; messageId: string; concepts: DrawnConcept[];
  completed: boolean; error: boolean; openDesignId: string; waitForOk: boolean; queued: boolean; now: number;
}): AutoBuild | null {
  const concepts = drawnConcepts(reply.concepts);
  if (reply.waitForOk || !reply.completed || reply.error || reply.queued || !concepts.length || reply.designId !== reply.openDesignId) return null;
  return { designId: reply.designId, messageId: reply.messageId, concepts, until: reply.now + AUTO_BUILD_SECONDS * 1000 };
}

/** Meshy credits of building all the concepts (25 each, 35 in colour). */
export const autoBuildCredits = (concepts: DrawnConcept[]) => concepts.reduce((sum, c) => sum + meshyCredits(c.color), 0);

/** The countdown card's line: "Building with Meshy in 10 s · 25 credits" (several: their names and the total). */
export function autoBuildText(concepts: DrawnConcept[], seconds: number): string {
  const what = concepts.length > 1 ? ` ${concepts.length} figures (${concepts.map((c) => `"${c.name}"`).join(', ')})` : '';
  return `Building${what} with Meshy in ${seconds} s · ${autoBuildCredits(concepts)} credits`;
}

/** The message sent for the user: it has to read as an approval to the AI (and names the pictures when there are several). */
export function approvalText(concepts: DrawnConcept[]): string {
  if (concepts.length <= 1) return 'Approved – build it.';
  const names = concepts.map((c) => `"${c.name}"`);
  return `Approved – build ${names.slice(0, -1).join(', ')} and ${names.at(-1)}.`;
}

/**
 * A follow-up's view of the model (the screenshot and the four-view render at the user's
 * settings), left out with "Send my view" off and for an approval of concept pictures; the
 * notes about the script (scale, restored version) still go.
 */
export function withView<T extends { currentView?: unknown; renderValues?: unknown }>(context: T, send: boolean): T {
  if (send) return context;
  const { currentView: _view, renderValues: _render, ...rest } = context;
  return rest as T;
}
