// Compiling model scripts: syntax and undeclared-name checks, then evaluation inside an SES
// Compartment (see shared/sandbox.ts).
import { parse } from 'acorn';
import type { ScriptErrorInfo } from './types';

export class ScriptError extends Error {
  info: ScriptErrorInfo;
  constructor(info: ScriptErrorInfo) {
    super(info.message);
    this.info = info;
  }
}

export const PRELUDE_LINES = 2; // "(function (...) {" + '"use strict";'

export function locate(err: unknown): { line?: number; column?: number } {
  const stack = (err as Error)?.stack ?? '';
  const m = /model\.js:(\d+):(\d+)/.exec(stack);
  if (!m) return {};
  return { line: Number(m[1]) - PRELUDE_LINES, column: Number(m[2]) };
}

export type Compiled = (...args: unknown[]) => { meta: unknown; params: unknown; build: unknown };
const compileCache = new Map<string, Compiled>();

/** What scripts get besides the compartment's globals (see the wrapper in compile()). */
const SCRIPT_ARGS = ['Manifold', 'CrossSection', 'H', 'quality', 'console'];
let knownGlobals: Set<string> | null = null;

type Node = { type: string; [k: string]: unknown };
const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && typeof (v as Node).type === 'string';

/**
 * Finds the first identifier the script reads without declaring it. Inside the compartment such a
 * name silently evaluates to undefined (SES never throws a ReferenceError for it), so a typo like
 * `chamfr` would quietly drop a feature instead of failing with a line number. Scopes are ignored:
 * a name declared anywhere counts as declared, which can only miss a typo, never flag valid code.
 */
function findUndeclared(ast: Node): { name: string; line: number; column: number } | null {
  knownGlobals ??= new Set([...Object.getOwnPropertyNames(new Compartment().globalThis), ...SCRIPT_ARGS, 'arguments']);
  const declared = new Set<string>();
  const refs: Node[] = [];
  const pattern = (p: unknown): void => {
    if (!isNode(p)) return;
    if (p.type === 'Identifier') declared.add(p.name as string);
    else if (p.type === 'ObjectPattern') for (const prop of p.properties as Node[]) {
      if (prop.type === 'RestElement') pattern(prop.argument);
      else { if (prop.computed) visit(prop.key); pattern(prop.value); }
    }
    else if (p.type === 'ArrayPattern') (p.elements as unknown[]).forEach(pattern);
    else if (p.type === 'RestElement') pattern(p.argument);
    else if (p.type === 'AssignmentPattern') { pattern(p.left); visit(p.right); }
    else visit(p); // a member expression as a destructuring target
  };
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (!isNode(n)) return;
    switch (n.type) {
      case 'Identifier': refs.push(n); return;
      case 'VariableDeclarator': pattern(n.id); visit(n.init); return;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        if (n.id) pattern(n.id);
        (n.params as unknown[]).forEach(pattern);
        visit(n.body);
        return;
      case 'ClassDeclaration': case 'ClassExpression': if (n.id) pattern(n.id); visit(n.superClass); visit(n.body); return;
      case 'CatchClause': pattern(n.param); visit(n.body); return;
      case 'UnaryExpression': if (n.operator === 'typeof' && isNode(n.argument) && n.argument.type === 'Identifier') return; break;
      case 'MemberExpression': visit(n.object); if (n.computed) visit(n.property); return;
      case 'Property': case 'MethodDefinition': case 'PropertyDefinition': if (n.computed) visit(n.key); visit(n.value); return;
      case 'LabeledStatement': visit(n.body); return;
      case 'BreakStatement': case 'ContinueStatement': case 'MetaProperty': return;
    }
    for (const [k, v] of Object.entries(n)) if (k !== 'loc') visit(v);
  };
  visit(ast);
  const bad = refs.find((r) => !declared.has(r.name as string) && !knownGlobals!.has(r.name as string));
  if (!bad) return null;
  const loc = bad.loc as { start: { line: number; column: number } };
  return { name: bad.name as string, line: loc.start.line, column: loc.start.column + 1 };
}

/** Compiles a model script inside an SES Compartment (see shared/sandbox.ts); never outside one. */
export function compile(code: string): Compiled {
  const hit = compileCache.get(code);
  if (hit) return hit;
  if (typeof Compartment === 'undefined') throw new Error('Model sandbox is not active: import shared/sandbox.ts first');
  let ast: Node;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', locations: true }) as unknown as Node;
  } catch (e) {
    const loc = (e as { loc?: { line: number; column: number } }).loc;
    throw new ScriptError({ message: `Syntax error: ${(e as Error).message.replace(/ \(\d+:\d+\)$/, '')}`, stage: 'compile', line: loc?.line, column: loc ? loc.column + 1 : undefined });
  }
  const undeclared = findUndeclared(ast);
  if (undeclared) {
    throw new ScriptError({ message: `"${undeclared.name}" is not defined – check the spelling, or declare it with const/let`, stage: 'compile', line: undeclared.line, column: undeclared.column });
  }
  let fn: Compiled;
  try {
    const src = `(function (Manifold, CrossSection, H, quality, console) {\n"use strict";\n${code}\n;return { meta: typeof meta !== "undefined" ? meta : {}, params: typeof params !== "undefined" ? params : {}, build: typeof build === "function" ? build : undefined };\n})\n//# sourceURL=model.js\n`;
    fn = new Compartment({ __options__: true, name: 'model.js' }).evaluate(src) as Compiled;
  } catch (e) {
    throw new ScriptError({ message: `Syntax error: ${(e as Error).message}`, stage: 'compile' });
  }
  if (compileCache.size > 20) compileCache.clear();
  compileCache.set(code, fn);
  return fn;
}
