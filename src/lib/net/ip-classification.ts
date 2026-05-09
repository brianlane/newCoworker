/**
 * Single source of truth for IPv4 / IPv6 private-range classification.
 *
 * Two callers consume these helpers:
 *
 *   1. `lib/website-ingest` — runs the helper on DNS-resolved addresses
 *      while crawling owner-supplied URLs. Calls always come in as
 *      well-formed dotted-quad / colon-separated literals (Node's
 *      `dns.lookup` only returns valid addresses), but the helper
 *      defensively treats any "weird" input (non-numeric octets,
 *      length≠4, etc.) as private — the cost of a false positive is
 *      a refused crawl, the cost of a false negative is SSRF.
 *
 *   2. `lib/db/custom-integrations` — runs the helper on
 *      `URL.hostname` for the owner-registered integration's base URL.
 *      Callers there are responsible for first checking that the
 *      hostname IS in IPv4 / IPv6 shape before consulting this module
 *      (see `isPrivateOrLoopbackHost`). That keeps "api.acme.com"
 *      from being misclassified as private.
 *
 * Keeping both callers on this single helper closes the gap Cursor
 * Bugbot flagged: a previous duplicate in `custom-integrations.ts`
 * omitted the `a >= 224` check (multicast/reserved) and treated
 * unparseable IPs as `false` instead of `true`, so the two layers of
 * defense had subtly different semantics.
 */

/**
 * True iff `ip` is an IPv4 dotted-quad in a private, loopback,
 * link-local, multicast, or reserved range. Inputs that don't parse
 * as four numeric octets in 0–255 are conservatively classified as
 * private — see module docstring for why.
 */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((x) => Number(x));
  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 (current network)
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a >= 224) return true; // multicast (224–239) + reserved (240–255)
  return false;
}

/**
 * True iff `ip` is an IPv6 literal in a loopback / unspecified /
 * link-local / unique-local range, or an IPv4-mapped form (`::ffff:`)
 * pointing at a private IPv4. `host` is expected to already be
 * lowercased; the function does NOT lowercase it for the caller
 * because callers usually need the lowercase form for other checks
 * too.
 */
export function isPrivateIpv6(host: string): boolean {
  if (host === "::1" || host === "::") return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // fc00::/7 ULA
  if (host.startsWith("fe80:")) return true; // link-local fe80::/10
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length);
    return isPrivateIpv4(mapped);
  }
  return false;
}
