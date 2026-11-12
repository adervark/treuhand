/**
 * Network guard for everything the verifier fetches from a submission.
 *
 * Submitted URLs are chosen by the person who gets paid, so they are hostile:
 * a page that points the verifier at localhost, the cloud metadata endpoint
 * or a private network would turn the verifier into a proxy into our own
 * infrastructure (and screenshots are shown to both parties). Only http and
 * https to public addresses are allowed. Host names are resolved and every
 * address must be public; connections then go to exactly the vetted address
 * (see `guardedLookup`), which closes DNS rebinding between check and use.
 *
 * Private targets are allowed only after `unsafeAllowPrivateNetworkForTests`,
 * which the fixture-based tests and the eval script call. It refuses to run in
 * production.
 */
import dns from "node:dns";
import net from "node:net";

let allowPrivateNetwork = false;

/** Test-only: lets the verifier visit loopback and private addresses (the local fixture server). */
export function unsafeAllowPrivateNetworkForTests(allow: boolean): void {
  if (allow && process.env.NODE_ENV === "production") {
    throw new Error("unsafeAllowPrivateNetworkForTests cannot be enabled in production");
  }
  allowPrivateNetwork = allow;
}

export function privateNetworkAllowed(): boolean {
  return allowPrivateNetwork;
}

/** Raised when a target is refused; the check reports it as a conclusive fail. */
export class BlockedTargetError extends Error {
  readonly code = "BLOCKED_TARGET";
  constructor(message: string) {
    super(message);
    this.name = "BlockedTargetError";
  }
}

const blockList = new net.BlockList();
// IPv4: "this network", private, CGNAT, loopback, link-local (cloud metadata),
// IETF protocol assignments, documentation, benchmarking, multicast, reserved.
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockList.addSubnet(prefix, bits, "ipv4");
}
// IPv6: unspecified, loopback, NAT64, discard, documentation, ULA, link-local, site-local, multicast.
blockList.addAddress("::", "ipv6");
blockList.addAddress("::1", "ipv6");
for (const [prefix, bits] of [
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockList.addSubnet(prefix, bits, "ipv6");
}

/** The IPv4 address embedded in an IPv4-mapped or -compatible IPv6 address, if any. */
function embeddedIPv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = /^::(?:ffff:(?:0{1,4}:)?)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^::(?:ffff:(?:0{1,4}:)?)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
  }
  return null;
}

/** True for any address the verifier must not connect to (loopback, private, link-local, ...). */
export function isPrivateAddress(ip: string): boolean {
  const unbracketed = ip.replace(/^\[|\]$/g, "");
  const family = net.isIP(unbracketed);
  if (family === 4) return blockList.check(unbracketed, "ipv4");
  if (family === 6) {
    const v4 = embeddedIPv4(unbracketed);
    if (v4) return blockList.check(v4, "ipv4");
    return blockList.check(unbracketed, "ipv6");
  }
  return true; // not an IP address: refuse rather than guess
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|localdomain)\.?$/i;

/**
 * Checks a URL's shape (scheme, credentials, obviously-local names, IP
 * literals). Throws BlockedTargetError. DNS is checked by `assertPublicHost`.
 */
export function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedTargetError(`Only http and https URLs are checked, not ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new BlockedTargetError("URLs with embedded credentials are not checked.");
  }
  if (allowPrivateNetwork) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedTargetError(`${host} is a private or local network address.`);
  } else if (LOCAL_NAME.test(host) || !host.includes(".")) {
    throw new BlockedTargetError(`${host} is a local host name.`);
  }
  return url;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Thrown when a host name does not exist (NXDOMAIN): a fact about the submission, not a transient error. */
export class HostNotFoundError extends Error {
  readonly code = "HOST_NOT_FOUND";
  constructor(readonly host: string) {
    super(`The host ${host} does not exist (DNS returned no address).`);
    this.name = "HostNotFoundError";
  }
}

/**
 * Resolves `host` and returns its addresses if every one is public.
 * Throws BlockedTargetError (private address), HostNotFoundError (no such
 * name) or the DNS error itself (transient: the caller reports inconclusive).
 */
export async function resolvePublicHost(host: string): Promise<ResolvedAddress[]> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) {
    if (!allowPrivateNetwork && isPrivateAddress(bare)) {
      throw new BlockedTargetError(`${bare} is a private or local network address.`);
    }
    return [{ address: bare, family: net.isIP(bare) }];
  }
  if (!allowPrivateNetwork && (LOCAL_NAME.test(bare) || !bare.includes("."))) {
    throw new BlockedTargetError(`${bare} is a local host name.`);
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await dns.promises.lookup(bare, { all: true, verbatim: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") throw new HostNotFoundError(bare);
    throw error;
  }
  if (addresses.length === 0) throw new HostNotFoundError(bare);
  if (!allowPrivateNetwork) {
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    if (bad) throw new BlockedTargetError(`${bare} resolves to ${bad.address}, a private or local network address.`);
  }
  return addresses;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for `net.connect` / `http.request` that only ever hands back
 * vetted public addresses, so the connection goes to the address that was
 * checked. IP literals never reach a lookup; callers check them with
 * `resolvePublicHost` first.
 */
export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  resolvePublicHost(hostname).then(
    (addresses) => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    },
    (error: Error) => {
      const code =
        error instanceof HostNotFoundError
          ? "ENOTFOUND"
          : error instanceof BlockedTargetError
            ? "EBLOCKED"
            : ((error as NodeJS.ErrnoException).code ?? "EDNS");
      callback(Object.assign(new Error(error.message, { cause: error }), { code }), "", 0);
    },
  );
}
