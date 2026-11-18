// Values kept with a design that build nothing: the model is the same with or without them.
import { EDIT_HISTORY_KEY } from './editHistory';
import { PICTURE_MARKS_KEY } from './pictureEdit/mark';

/** The picture marks (the area selected for an edit) and the hand edits' restore points. */
export const NON_BUILD_KEYS: readonly string[] = [PICTURE_MARKS_KEY, EDIT_HISTORY_KEY];
