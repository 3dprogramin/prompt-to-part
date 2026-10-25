// Line art: wall cut-outs of a drawing (a car and a motorbike on a key holder, a figure in a frame),
// printed flat in one colour as one connected piece. H.lineart takes a drawing (an attached SVG, a
// traced picture or one the image model drew), redraws its lines at an even width at the final
// size, joins loose bits to the rest with short bridges, drops specks too small to print, and adds
// the style's bar, frame, hooks or stand.
export { cleanLineArtInfo, DEFAULT_LINE_ART_STYLE, isLineArt, isLineArtStyle, LINE_ART_STYLE_INFO, LINE_ART_STYLES, type LineArtDeps, type LineArtInfo, type LineArtOptions, type LineArtPieceInfo, lineArtPrint, type LineArtResult, type LineArtSplitInfo, type LineArtStyle } from './lineart/info';
export { DEFAULT_JOIN_ENDS, DEFAULT_SPLIT_JOIN, formatLineArtSize, LINEART_EDITS_KEY, LINEART_ENDS_KEY, LINEART_JOIN_KEY, LINEART_LAYOUT_KEY, LINEART_LAYOUTS, LINEART_SIZE_KEY, LINEART_SPLIT_KEY, MAX_JOIN_MARKS, MAX_LINEART_SIZE, parseLineArtEnds, parseLineArtJoin, parseLineArtSize, parseLineArtSplit } from './lineart/settings';
export { colourBands, colourBottom, type ColourDepth, colourLayers, colourSwaps, depthLayers, filamentTd, LINEART_DEPTH_KEY, type LineArtPaint, MAX_COLOUR_LAYERS, MIN_COLOUR_LAYERS, type PaintMaterial, parseLineArtDepth, type PrintLayers, SWAP_COST } from './lineart/depth';
export { colourStrokes, drawingFingerprint, drawingPicture, FILL_WIDTH, type LineArtEdits, type LineArtStroke, MAX_LINEART_STROKES, MAX_STROKE_POINTS, parseLineArtEdits } from './lineart/strokes';
export { type LineArtGrid, rasterize, sqDistance } from './lineart/raster';
export { lineArtMask, type LineArtMaskOptions } from './lineart/mask';
export { traceField, traceMask } from './lineart/trace';
export { squareOutlines } from './lineart/outlines';
export { buildLineArt } from './lineart/build';
export { MIN_PAINT } from './lineart/paint';
export { seamCuts } from './lineart/pieces';
