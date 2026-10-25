// The activity panel's text for a reply: tool labels, shortened details and what a tool call does.
import { readFileSync } from 'node:fs';

/** Longest text kept with a step for the activity panel (it is saved with the design). */
const MAX_DETAIL = 8000;
export const detail = (text: string, max = MAX_DETAIL) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text);

export const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading a file',
  Write: 'Writing model.js',
  Edit: 'Editing model.js',
  mcp__cad__evaluate_model: 'Evaluating model',
  mcp__cad__render_model: 'Rendering preview',
  mcp__cad__render_scad: 'Rendering the OpenSCAD file',
  mcp__cad__generate_artwork: 'Generating artwork',
  mcp__cad__generate_picture: 'Generating a picture',
  mcp__cad__set_layertone: 'Changing the LayerTone filaments',
  mcp__cad__generate_line_art: 'Drawing line art',
  mcp__cad__trace_line_art: 'Tracing line art',
  mcp__cad__generate_concept: 'Drawing a concept picture',
  mcp__cad__generate_3d: 'Making a 3D model with Meshy',
  mcp__cad__ask_questions: 'Asking you a few questions',
  mcp__cad__submit_model: 'Validating & submitting',
  WebSearch: 'Searching the web',
  WebFetch: 'Reading a web page',
};

/** A file's text, or '' if it doesn't exist yet. */
export function readText(f: string): string {
  try { return readFileSync(f, 'utf8'); } catch { return ''; }
}

export function lastSentence(text: string) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 140 ? '…' + t.slice(-140) : t;
}

export function describeToolInput(name: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  if (name === 'Write' && typeof input.content === 'string') {
    return `Writing model.js – ${input.content.split('\n').length} lines, ${(input.content.length / 1024).toFixed(1)} KB`;
  }
  if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const a = input.old_string.split('\n').length, b = input.new_string.split('\n').length;
    return `Editing model.js – replacing ${a} line${a === 1 ? '' : 's'} with ${b}${input.replace_all ? ' (all occurrences)' : ''}`;
  }
  if (name === 'Read') return 'Reading model.js';
  if (name === 'mcp__cad__generate_picture' && typeof input.subject === 'string') return `Picture "${String(input.name ?? '')}": ${input.subject.slice(0, 200)}`;
  if (name === 'mcp__cad__generate_3d') return `3D model "${String(input.name ?? '')}": ${input.from_concept ? `from concept picture "${String(input.from_concept)}"` : input.from_photo ? 'from the attached photo' : String(input.prompt ?? '').slice(0, 200)}`;
  if (name === 'mcp__cad__generate_concept' && typeof input.subject === 'string') return `Concept "${String(input.name ?? '')}": ${input.subject.slice(0, 200)}`;
  if (name === 'mcp__cad__generate_artwork' && typeof input.subject === 'string') return `Artwork "${String(input.name ?? '')}": ${input.subject.slice(0, 200)}`;
  if (name === 'mcp__cad__render_scad' && typeof input.file === 'string') return `OpenSCAD: ${input.file}${input.values && typeof input.values === 'object' && Object.keys(input.values).length ? ` with ${Object.entries(input.values as Record<string, unknown>).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}` : ''}`;
  if ((name === 'mcp__cad__evaluate_model' || name === 'mcp__cad__render_model') && input.values && typeof input.values === 'object' && Object.keys(input.values).length) {
    return `${name.endsWith('render_model') ? 'Rendering' : 'Evaluating'} with ${Object.entries(input.values as Record<string, unknown>).map(([k, v]) => `${k}=${v}`).join(', ')}`;
  }
  if (name === 'mcp__cad__submit_model' && typeof input.summary === 'string') return `Submitting: ${input.summary}`;
  if (name === 'WebSearch' && typeof input.query === 'string') return `Searching the web: ${input.query}`;
  if (name === 'WebFetch' && typeof input.url === 'string') return `Reading ${input.url}`;
  return null;
}
