import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { errors } from '../kernel/errors.js';

/**
 * SSRF guard for webhook targets. A tenant admin controls webhook URLs, so an
 * unguarded delivery worker is a proxy into the deployer's private network
 * (cloud metadata endpoints, internal services). Unless private targets are
 * explicitly allowed (the default on embedded dev databases), a target must
 * resolve exclusively to public unicast addresses — checked at creation AND
 * re-checked at every delivery (DNS answers change).
 */

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split('.').map((n) => Number.parseInt(n, 10));
  return ((a! << 24) >>> 0) + (b! << 16) + (c! << 8) + d!;
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local / cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

export function isPrivateIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const ip = ipv4ToInt(address);
    return PRIVATE_V4.some(([base, bits]) => inCidr4(ip, base, bits));
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
    if (lower.startsWith('ff')) return true; // multicast
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // v4-mapped
    if (mapped) return isPrivateIp(mapped[1]!);
    return false;
  }
  return false; // not an IP literal
}

const FORBIDDEN_HOSTNAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

/**
 * Validate a webhook target URL. Resolves DNS and requires every answer to be
 * a public address. Throws a `validation` error otherwise.
 */
export async function assertPublicWebhookTarget(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw errors.validation('Webhook url is not a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw errors.validation('Webhook url must be http(s)');
  }
  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip ipv6 brackets

  if (FORBIDDEN_HOSTNAMES.test(host)) {
    throw errors.validation(`Webhook target "${host}" is not allowed (private/internal host)`);
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw errors.validation(`Webhook target "${host}" is not allowed (private address)`);
    }
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw errors.validation(`Webhook target "${host}" does not resolve`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw errors.validation(`Webhook target "${host}" resolves to a private address`);
    }
  }
}
