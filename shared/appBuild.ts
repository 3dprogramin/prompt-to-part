// Which build of prompt-to-part made a design version or a printed mark: the package.json version
// and, when known, the short git commit. Missing on anything made before it was recorded.

export interface AppBuild {
  version: string;
  commit?: string;
}

/** The build to keep: a non-empty version of at most 40 characters, a commit only when it looks like a git hash. */
export function cleanAppBuild(v: unknown): AppBuild | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const { version, commit } = v as Record<string, unknown>;
  if (typeof version !== 'string' || !version || version.length > 40) return undefined;
  return typeof commit === 'string' && /^[0-9a-f]{7,40}$/.test(commit) ? { version, commit } : { version };
}

/** "v0.2.0 (abc1234)", "v0.2.0", or '' when there is no build. */
export function formatAppBuild(a?: AppBuild): string {
  return a ? `v${a.version}${a.commit ? ` (${a.commit})` : ''}` : '';
}
