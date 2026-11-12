/** A name as a file-name part: lower case letters and digits joined by hyphens. */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model';
