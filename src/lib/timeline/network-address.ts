import { isIP } from "node:net";

/**
 * Reject every address that is not globally routable public unicast. Timeline
 * crawling never needs transition, documentation, multicast, local, or mapped
 * address space, so a conservative allow-list is safer than maintaining a
 * partial list of private prefixes.
 */
export function isPrivateOrReservedAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized || normalized.includes("%")) return true;
  const family = isIP(normalized);
  if (family === 4) return isPrivateOrReservedIpv4(normalized);
  if (family !== 6) return true;

  const words = parseIpv6Words(normalized);
  if (!words) return true;

  // Currently routable global unicast space is 2000::/3. This excludes
  // unspecified, loopback, IPv4-compatible/mapped, NAT64, discard-only,
  // unique-local, link/site-local, multicast, and future-reserved ranges.
  if ((words[0]! & 0xe000) !== 0x2000) return true;

  // IANA special-purpose allocations that live inside 2000::/3.
  if (words[0] === 0x2001 && (words[1]! & 0xfe00) === 0) return true; // 2001::/23
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true; // documentation
  if (words[0] === 0x2002) return true; // deprecated 6to4 transition space
  if (words[0] === 0x3fff && (words[1]! & 0xf000) === 0) return true; // documentation
  return false;
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a = 0, b = 0, c = 0] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function parseIpv6Words(address: string): number[] | null {
  let normalized = address;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4 = normalized.slice(lastColon + 1).split(".").map(Number);
    if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    normalized = `${normalized.slice(0, lastColon)}:${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const omitted = 8 - left.length - right.length;
  if (halves.length === 2 && omitted < 1) return null;

  const words = [
    ...left.map(parseHextet),
    ...Array.from({ length: Math.max(0, omitted) }, () => 0),
    ...right.map(parseHextet),
  ];
  return words.length === 8 && words.every((word) => word !== null)
    ? words as number[]
    : null;
}

function parseHextet(value: string): number | null {
  return /^[0-9a-f]{1,4}$/i.test(value) ? Number.parseInt(value, 16) : null;
}
