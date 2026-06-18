// Loopback hosts where plain http is acceptable (local self-hosting / dev).
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Guard the server base URL before we ever attach a bearer token to a request.
 * Requires https, except http is allowed for localhost/loopback so people can
 * develop or self-host locally. Returns the url unchanged when safe; throws
 * otherwise. Applied at the `--url` input boundary (connect) and again at
 * request time (sync), in case auth.json was hand-edited.
 */
export function assertSecureBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid server URL: ${raw}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const isLoopback = LOOPBACK.has(host);

  if (url.protocol === "https:") return raw;
  if (url.protocol === "http:" && isLoopback) return raw;

  throw new Error(
    `Refusing to send your token over an insecure connection ` +
      `(${url.protocol}//${url.host}). Use https:// — http:// is allowed only for localhost.`,
  );
}
