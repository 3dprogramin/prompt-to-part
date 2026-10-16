// Reads the fields of a JSON object that is still streaming in (a tool call's input), so text
// such as the model.js being written can be shown before the call is complete.

const ESC: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** Decodes the JSON string starting at src[i] (a quote) as far as it has arrived. */
function readString(src: string, i: number): { value: string; end: number; done: boolean } {
  let out = '';
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '"') return { value: out, end: j + 1, done: true };
    if (c !== '\\') { out += c; j++; continue; }
    const e = src[j + 1];
    if (e === undefined) break;
    if (e === 'u') {
      const hex = src.slice(j + 2, j + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      j += 6;
    } else {
      out += ESC[e] ?? e;
      j += 2;
    }
  }
  return { value: out, end: src.length, done: false };
}

/**
 * Top-level fields of a possibly incomplete JSON object. String values are decoded (the last
 * one may be cut short); other values come back as their raw JSON text.
 */
export function partialFields(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = src.indexOf('{');
  if (i < 0) return out;
  i++;
  const ws = () => { while (i < src.length && /[\s,]/.test(src[i])) i++; };
  while (i < src.length) {
    ws();
    if (src[i] !== '"') break;
    const key = readString(src, i);
    if (!key.done) break;
    i = key.end;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== ':') break;
    i++;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;
    if (src[i] === '"') {
      const v = readString(src, i);
      out[key.value] = v.value;
      if (!v.done) break;
      i = v.end;
    } else {
      const start = i;
      let depth = 0, inStr = false;
      for (; i < src.length; i++) {
        const c = src[i];
        if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') { if (depth === 0) break; depth--; }
        else if (c === ',' && depth === 0) break;
      }
      out[key.value] = src.slice(start, i).trim();
    }
  }
  return out;
}
