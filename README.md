# jmap-wellknown-worker

A tiny Cloudflare Worker that advertises **JMAP autodiscovery** on your email
domains, so clients like [Sterna Mail](https://sternamail.org/) set accounts up
over **JMAP** instead of quietly falling back to IMAP autoconfig.

It answers one request:

```
GET https://<email-domain>/.well-known/jmap
```

and redirects it to the JMAP well-known (or session) resource on the mail
server that actually serves that domain (e.g. a Stalwart host). See
[RFC 8620 section 2.2](https://www.rfc-editor.org/rfc/rfc8620#section-2.2).

## Why this exists

Autodiscovery in JMAP clients probes `https://<domain-after-the-@>/.well-known/jmap`,
where `<domain>` is the part after the `@` in your address, **not** your mail
host. If your address is `you@example.com` but the server lives at
`mail.example.com`, then whatever answers the apex `example.com` has to point
JMAP discovery at the mail host. If it doesn't, the client silently uses
whatever IMAP autoconfig / SRV records it *can* find and you end up on IMAP.

This Worker makes the apex answer that probe correctly, without having to route
the apex web host through your mail server or reverse proxy.

## How the redirect chain works

```
client -> example.com/.well-known/jmap          (302, this worker)
       -> mail.example.com/.well-known/jmap      (302, Stalwart)
       -> mail.example.com/jmap/session          (401 -> client retries with auth)
```

Set `JMAP_WELL_KNOWN_PATH=/jmap/session` if you'd rather skip the middle hop and
point straight at the session resource.

## Configuration

All config is via environment variables (plaintext vars, nothing secret). Keeping
your real domains and mail host out of the repo is deliberate; set them in the
Cloudflare dashboard under **Settings -> Variables and Secrets**.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `JMAP_TARGETS` | yes | - | JSON object mapping each email domain (the requested host) to the **origin** of its mail server. |
| `JMAP_WELL_KNOWN_PATH` | no | `/.well-known/jmap` | Path appended to the target origin. Use `/jmap/session` to point straight at the session. |
| `JMAP_REDIRECT_STATUS` | no | `302` | `301`, `302`, `307`, or `308`. |

Example `JMAP_TARGETS`:

```json
{
  "yourdomain-one.tld": "https://mail.yourdomain-one.tld",
  "yourdomain-two.tld": "https://mail.yourdomain-two.tld"
}
```

## Deploy (Cloudflare Workers Builds)

1. Push this repo to GitHub.
2. In the Cloudflare dashboard: **Workers & Pages -> Create -> Workers -> Connect
   to Git**, pick this repo. Workers Builds rebuilds on every push.
3. Add the two routes under **Settings -> Domains & Routes** (one per domain):
   - `yourdomain-one.tld/.well-known/jmap`
   - `yourdomain-two.tld/.well-known/jmap`
4. Add the variables under **Settings -> Variables and Secrets** (see table above).
5. Redeploy (or push) so the new vars/routes take effect.

Prefer to keep routes/vars in the repo instead of the dashboard? Uncomment the
`routes` and `[vars]` blocks in `wrangler.toml`.

## Cloudflare proxying gotcha

A Worker **route** only fires if the matched hostname is proxied through
Cloudflare (orange cloud). Email domains often have MX records but no proxied web
record on the apex, in which case the route never runs.

If the apex has no proxied origin, add a placeholder proxied DNS record so
Cloudflare terminates HTTP for it and the route engages, e.g.:

```
AAAA   @   100::   (Proxied)
```

(`100::` is the IPv6 discard prefix; the Worker intercepts `/.well-known/jmap`
before anything is forwarded, and nothing else on the apex changes.) If the apex
already serves a website through Cloudflare, you don't need this.

Use path-scoped **routes**, not a Worker **Custom Domain** -- a custom domain
would take over the whole hostname, not just `/.well-known/jmap`.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # edit with your domains
npm run dev
```

Then, in another shell, override the Host header to test a mapped domain:

```sh
curl -isS -H 'Host: yourdomain-one.tld' http://127.0.0.1:8787/.well-known/jmap
```

You should see a `302` with a `Location:` pointing at your mail host.

## Test in production

```sh
curl -iL https://yourdomain-one.tld/.well-known/jmap
```

Expect the redirect chain above, ending at your JMAP session resource, over a
cert the client trusts.

## Note: SRV is a separate (optional) route

`/.well-known/jmap` is the primary discovery mechanism. RFC 8620 also allows a
DNS `_jmap._tcp.<domain>` SRV record. That's a DNS change, not something a Worker
can do -- add it in your zone if you want belt-and-suspenders discovery.

## License

MIT
