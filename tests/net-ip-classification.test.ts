import { describe, expect, it } from "vitest";
import { isPrivateIpv4, isPrivateIpv6 } from "@/lib/net/ip-classification";

/**
 * `isPrivateIpv4` is the single source of truth for IPv4 private-range
 * classification used by both `website-ingest` (post-DNS) and
 * `custom-integrations` (registration-time). Cursor Bugbot flagged that
 * the previous duplicate helpers diverged on multicast / reserved
 * coverage and on unparseable-input semantics; these tests pin the
 * unified behavior so they can never silently drift again.
 */
describe("isPrivateIpv4", () => {
  it.each([
    // RFC1918 private + loopback + link-local + 0.0.0.0/8.
    ["10.0.0.5", true],
    ["10.255.255.255", true],
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["169.254.169.254", true],
    ["169.254.0.0", true],
    ["172.16.0.1", true],
    ["172.31.255.254", true],
    ["172.15.255.254", false], // outside RFC1918 lower bound
    ["172.32.0.1", false], // outside RFC1918 upper bound
    ["192.168.0.1", true],
    ["192.168.255.255", true],
    ["192.169.0.1", false],
    ["0.0.0.0", true],
    ["0.255.255.255", true],
    // Multicast (224.0.0.0 – 239.255.255.255) + reserved (240+).
    // These were missed by the previous custom-integrations duplicate.
    ["224.0.0.1", true],
    ["239.255.255.255", true],
    ["240.0.0.1", true],
    ["255.255.255.255", true],
    // Public space — must NOT be classified as private.
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["93.184.216.34", false],
    // Non-numeric / malformed → conservatively private.
    ["not-an-ip", true],
    ["api.acme.com", true],
    ["", true],
    ["1.2.3", true],
    ["1.2.3.4.5", true],
    ["1.2.3.999", true],
    ["1.2.3.-1", true]
  ])("classifies %s as private=%s", (ip, expected) => {
    expect(isPrivateIpv4(ip)).toBe(expected);
  });
});

describe("isPrivateIpv6", () => {
  it.each([
    // Loopback / unspecified.
    ["::1", true],
    ["::", true],
    // Unique-local fc00::/7.
    ["fc00::1", true],
    ["fd12:3456::abcd", true],
    // Link-local fe80::/10.
    ["fe80::1", true],
    ["fe80::abcd:ef01", true],
    // IPv4-mapped pointing at private IPv4 → must be blocked too.
    ["::ffff:127.0.0.1", true],
    ["::ffff:10.0.0.5", true],
    ["::ffff:169.254.169.254", true],
    ["::ffff:224.0.0.1", true],
    // IPv4-mapped pointing at public IPv4 → not private.
    ["::ffff:8.8.8.8", false],
    // Public IPv6 → not private.
    ["2001:4860:4860::8888", false],
    ["2606:4700:4700::1111", false],
    // Edge: similar prefix but NOT fc/fd.
    ["fb00::1", false]
  ])("classifies %s as private=%s", (host, expected) => {
    expect(isPrivateIpv6(host)).toBe(expected);
  });
});
