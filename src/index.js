/**
 * jmap-wellknown-worker
 *
 * Advertises JMAP autodiscovery on your email domains. It answers
 *
 *     GET https://<email-domain>/.well-known/jmap
 *
 * with a redirect to the JMAP well-known (or session) resource on the
 * mail server that actually serves that domain (e.g. Stalwart). A client
 * that follows the redirect discovers the JMAP session and sets the
 * account up over JMAP instead of quietly falling back to IMAP autoconfig.
 *
 * Reference: RFC 8620 section 2.2 (JMAP autodiscovery via /.well-known/jmap).
 *
 * Config comes from environment variables. Nothing here is secret, but
 * keeping infra identifiers (your real domains / mail host) out of the
 * repo is deliberate -- set these in the Cloudflare dashboard:
 *
 *   JMAP_TARGETS          (required) JSON object mapping each email domain
 *                         (the host the client requests) to the ORIGIN of
 *                         the mail server serving its JMAP endpoint, e.g.
 *                           {"example.com":"https://mail.example.com",
 *                            "example.net":"https://mail.example.net"}
 *                         Lookup is by the request hostname.
 *
 *   JMAP_WELL_KNOWN_PATH  (optional) path appended to the target origin.
 *                         Default "/.well-known/jmap" -- lets the mail
 *                         server do the final hop to its session resource.
 *                         Set to "/jmap/session" to point straight at the
 *                         session and save one redirect.
 *
 *   JMAP_REDIRECT_STATUS  (optional) 301 | 302 (default) | 307 | 308.
 */

const WELL_KNOWN_PATH = "/.well-known/jmap";
const DEFAULT_TARGET_PATH = "/.well-known/jmap";
const DEFAULT_STATUS = 302;
const ALLOWED_STATUS = new Set([301, 302, 307, 308]);

let cachedRaw = null;
let cachedTargets = null;

function parseTargets(env) {
  const raw = env.JMAP_TARGETS ?? "";
  if (raw === cachedRaw && cachedTargets) return cachedTargets;

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("JMAP_TARGETS is not valid JSON");
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("JMAP_TARGETS must be a JSON object");
  }

  const map = new Map();
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`JMAP_TARGETS["${k}"] must be a non-empty string`);
    }
    // normalise: lowercase host, drop trailing dot on key, trim trailing / on value
    map.set(k.toLowerCase().replace(/\.$/, ""), v.replace(/\/+$/, ""));
  }

  cachedRaw = raw;
  cachedTargets = map;
  return map;
}

function redirectStatus(env) {
  const n = Number(env.JMAP_REDIRECT_STATUS);
  return ALLOWED_STATUS.has(n) ? n : DEFAULT_STATUS;
}

function targetPath(env) {
  const p = env.JMAP_WELL_KNOWN_PATH;
  if (typeof p !== "string" || p.length === 0) return DEFAULT_TARGET_PATH;
  return p.startsWith("/") ? p : `/${p}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // We only own the JMAP well-known path. Leave everything else alone.
    if (url.pathname !== WELL_KNOWN_PATH) {
      return new Response("Not found\n", { status: 404 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          Allow: "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", {
        status: 405,
        headers: { Allow: "GET, HEAD, OPTIONS" },
      });
    }

    let targets;
    try {
      targets = parseTargets(env);
    } catch (err) {
      console.error("jmap-wellknown config error:", err.message);
      return new Response("Worker misconfigured\n", { status: 500 });
    }

    const host = url.hostname.toLowerCase();
    const origin = targets.get(host);
    if (!origin) {
      return new Response("No JMAP target configured for this host\n", {
        status: 404,
      });
    }

    const location = `${origin}${targetPath(env)}`;
    const status = redirectStatus(env);

    const headers = {
      Location: location,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/plain; charset=utf-8",
    };

    return new Response(
      request.method === "HEAD" ? null : `Redirecting to ${location}\n`,
      { status, headers },
    );
  },
};
