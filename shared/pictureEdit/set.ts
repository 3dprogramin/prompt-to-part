// What a picture edit sets in a design's values (PictureEditResponse.set, the chat's pictureEdited
// event): keys to set, null to delete; applied the same way by the server's tools and the app.
import type { ParamValues } from '../types';

/** The values with what a picture edit sets merged in (null deletes the key). */
export function withSet(values: ParamValues, set: Record<string, string | null>): ParamValues {
  const out = { ...values };
  for (const [k, v] of Object.entries(set)) if (v === null) delete out[k]; else out[k] = v;
  return out;
}
