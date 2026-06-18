export type ParsedIpRule =
  | { readonly kind: 'ipv4-cidr'; readonly network: number; readonly mask: number }
  | { readonly kind: 'exact'; readonly value: string };

function normalizeIp(ip: string): string {
  return ip.trim().replace(/^::ffff:/i, '');
}

function parseIpv4Address(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet < 0 || octet > 255) return null;
    result = ((result << 8) | octet) >>> 0;
  }

  return result;
}

function parseIpv4Cidr(value: string): ParsedIpRule | null {
  const [address, prefixText, extra] = value.split('/');
  if (!address || !prefixText || extra !== undefined) return null;

  const prefix = Number.parseInt(prefixText, 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;

  const ip = parseIpv4Address(address);
  if (ip === null) return null;

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return {
    kind: 'ipv4-cidr',
    network: ip & mask,
    mask,
  };
}

function parseIpRule(value: string): ParsedIpRule | null {
  const normalized = normalizeIp(value);
  if (!normalized) return null;

  if (normalized.includes('/')) {
    return parseIpv4Cidr(normalized);
  }

  return {
    kind: 'exact',
    value: normalized,
  };
}

export function parseCidrs(list: readonly string[]): ParsedIpRule[] {
  const parsed: ParsedIpRule[] = [];
  for (const item of list) {
    const rule = parseIpRule(item);
    if (rule) parsed.push(rule);
  }
  return parsed;
}

export function ipInAllowlist(ip: string | undefined, allowlist: readonly ParsedIpRule[]): boolean {
  if (!ip) return false;

  const normalized = normalizeIp(ip);
  const ipv4 = parseIpv4Address(normalized);

  for (const rule of allowlist) {
    switch (rule.kind) {
      case 'ipv4-cidr':
        if (ipv4 !== null && (ipv4 & rule.mask) === rule.network) return true;
        break;
      case 'exact':
        if (normalized === rule.value) return true;
        break;
    }
  }

  return false;
}
