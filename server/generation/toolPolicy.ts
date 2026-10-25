// What Claude may do in a design's workspace: its model.js, the CAD tools and (with web search on)
// public web pages only.
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';

export const MODEL_FILE = 'model.js';

/**
 * What Claude may do in a design's workspace: read and write its model.js, use the CAD tools, and
 * (only with web search on) search and read public web pages. Returns why a call is refused, or
 * null to allow it. `resolve` looks up a host name's addresses (replaceable in tests).
 */
export function toolPolicy(ws: string, webSearch: boolean, resolve = resolveHost) {
  const file = path.join(ws, MODEL_FILE);
  return async (name: string, input: Record<string, unknown>): Promise<string | null> => {
    if (['Read', 'Write', 'Edit'].includes(name)) {
      return path.resolve(ws, String(input.file_path ?? '')) === file ? null : `Only ${file} may be accessed.`;
    }
    if (name.startsWith('mcp__cad__')) return null;
    if (webSearch && name === 'WebSearch') return null;
    // A page Claude reads could tell it to fetch a local address (Jig's own API, a router), so local
    // and private addresses are never fetched. It could also tell it to put the design into a
    // public URL; that can't be told apart from a normal fetch, which is why web search can be
    // turned off per design.
    if (webSearch && name === 'WebFetch') return await publicPage(input.url, resolve) ? null : 'Only public http(s) web pages can be fetched.';
    return 'Tool not available in Jig.';
  };
}

/** Host name or address of an http(s) URL, or null for anything else. */
function urlHost(raw: unknown): string | null {
  let u: URL;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** An address on the internet: not this computer, the local network, link-local or multicast. */
function publicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224);
  }
  const h = ip.toLowerCase();
  return net.isIPv6(h) && !(h === '::' || h === '::1' || /^f[cdf]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:') || h.startsWith('64:ff9b:'));
}

/** http(s) URL on a public host: not this computer, the local network or a private address. */
export function publicUrl(raw: unknown): boolean {
  const h = urlHost(raw);
  if (h === null) return false;
  if (net.isIP(h)) return publicIp(h);
  // Single-label names (e.g. "router") and local-only domains resolve on the local network.
  return h.includes('.') && !/\.(localhost|local|internal|lan|home\.arpa)$/.test(h);
}

async function resolveHost(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

/**
 * publicUrl, and the host name resolves only to public addresses: anyone can make a public name
 * (e.g. 127.0.0.1.nip.io) point at this computer or the local network. A name that doesn't resolve
 * is refused too. (A DNS server built to answer differently a moment later could still get past
 * this; WebFetch itself refuses loopback and metadata hosts on cross-host redirects.)
 */
export async function publicPage(raw: unknown, resolve: (host: string) => Promise<string[]> = resolveHost): Promise<boolean> {
  if (!publicUrl(raw)) return false;
  const h = urlHost(raw)!;
  if (net.isIP(h)) return true;
  try {
    const ips = await resolve(h);
    return ips.length > 0 && ips.every(publicIp);
  } catch {
    return false;
  }
}
