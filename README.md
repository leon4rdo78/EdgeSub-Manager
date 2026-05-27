# EdgeSub Manager

EdgeSub Manager is a single-file Cloudflare Worker subscription manager for proxy subscription links.

It lets you manage clients from a small web panel, store manual subscription configs in Cloudflare KV, expose multiple subscription output formats, and optionally read traffic/expiry information from an upstream panel subscription link.

The project is designed for Cloudflare Workers and Cloudflare KV.

## Features

- Cloudflare Worker-based subscription manager
- Cloudflare KV client storage
- Minimal web admin panel
- Per-client enable/disable switch
- Per-client subscription output controls
- Optional upstream subscription URL for usage/expiry headers
- Optional storage-only subscriptions
- Optional UUID replacement
- Raw Xray/VLESS subscription output
- Base64 subscription output
- Mihomo/Clash YAML output
- sing-box JSON output
- Xray least-ping balancer JSON output
- Mihomo `url-test` auto-latency group
- Readable custom traffic/expiry headers

## **Worker Replacer Feature**

**EdgeSub Manager includes a Worker Replacer feature for Cloudflare Worker-style proxy configs.**

This feature can replace the `host` and `sni` query parameters inside pasted configs with one or more Worker hostnames.

Example Worker input in the admin panel:

```txt
worker-one.example.workers.dev, worker-two.example.workers.dev
```

If a client has 30 manual configs and 2 Worker addresses, the output can become 60 configs:

```txt
30 input configs × 2 Worker addresses = 60 output configs
```

The replacement behavior is intentionally conservative:

- **Only existing `host` parameters are replaced.**
- **Only existing `sni` parameters are replaced.**
- **Remarks are not changed.**
- **UUIDs are handled separately by the UUID setting.**
- **If the Worker address box is empty, the original Worker/SNI/host values are kept unchanged.**
- **If Worker replacement is disabled, stored Worker addresses are not applied.**

This makes it possible to use one set of template configs and generate multiple Worker-host variants automatically.

## Subscription Endpoints

For a client with this ID:

```txt
CLIENT_ID
```

the Worker exposes:

```txt
/sub/CLIENT_ID       Raw Xray/VLESS links
/sub/CLIENT_ID/ty    Base64-encoded raw subscription
/sub/CLIENT_ID/cl    Mihomo/Clash YAML
/sub/CLIENT_ID/sb    sing-box JSON
/sub/CLIENT_ID/bl    Xray least-ping balancer JSON
```

A legacy raw alias may also be available:

```txt
/client/CLIENT_ID
```

## Admin Panel

Default admin path:

```txt
/admin
```

Depending on your fork or deployment, the admin path may be changed in the Worker code or through an environment variable.

The admin panel lets you configure:

- Client name
- Client UUID
- Upstream subscription URL
- Manual configs
- Enabled/disabled state
- Available output formats
- Update interval
- Optional INFO config
- Worker replacement settings
- Worker addresses

## UUID Behavior

The UUID box controls whether pasted configs are rewritten.

If the Client UUID box is filled:

```txt
All UUIDs inside manual configs are replaced with that UUID.
```

If the Client UUID box is empty:

```txt
Manual configs are returned without changing their UUIDs.
```

This is useful for storage-only subscriptions.

Important behavior:

```txt
UUID box empty + upstream subscription URL filled
= traffic/expiry is fetched from upstream,
but UUIDs inside manual configs are not touched.
```

## Storage-Only Subscriptions

A storage-only subscription is a client entry without a Client UUID.

Use this when you want EdgeSub Manager to store and serve pasted configs exactly as they are.

For storage-only subscriptions:

- The Worker creates an internal link ID.
- UUIDs in manual configs are not changed.
- Worker replacement only applies if explicitly enabled.
- Upstream traffic/expiry can still be fetched if an upstream subscription URL is provided.

## Traffic and Expiry Headers

If an upstream subscription URL is configured, EdgeSub Manager fetches it and reads:

```http
Subscription-Userinfo: upload=...; download=...; total=...; expire=...
```

The same header is returned to compatible clients.

Additional readable headers are also returned:

```http
X-EdgeSub-Remaining-Traffic: ...
X-EdgeSub-Expire-Time: ...
X-EdgeSub-Remaining-Days: ...
```

Some apps may show usage/expiry information from `Subscription-Userinfo`. Support depends on the client app.

## Mihomo Output

The Mihomo output is available at:

```txt
/sub/CLIENT_ID/cl
```

It generates a minimal YAML profile with:

- proxy entries
- a manual selector group
- a `url-test` auto-latency group
- 3-minute latency check interval

The `url-test` group checks latency and selects the lowest-latency proxy.

No extra direct/block/custom routing rules are appended by default.

## sing-box Output

The sing-box output is available at:

```txt
/sub/CLIENT_ID/sb
```

It generates a minimal JSON config with:

- mixed inbound
- selector outbound
- urltest outbound
- generated VLESS outbounds
- final route through the proxy selector

No extra custom rules are appended by default.

## Xray Least-Ping Balancer Output

The Xray balancer output is available at:

```txt
/sub/CLIENT_ID/bl
```

It generates a JSON config with:

- mixed inbound
- generated VLESS outbounds
- `leastPing` balancer
- observatory
- minimal routing rule to use the balancer

No custom direct/block/domain rules are appended by default.

## Supported Input Links

Current converter support focuses on VLESS links.

Supported parsed fields include:

- UUID
- server
- port
- security/TLS
- SNI
- host
- path
- ALPN
- fingerprint
- insecure/allowInsecure
- WebSocket transport
- gRPC transport

Other protocols can still be served in raw output, but converter outputs may ignore unsupported link types.

## Cloudflare Requirements

You need:

- Cloudflare account
- Cloudflare Worker
- Cloudflare KV namespace
- KV binding named `SUB_DB`
- Admin username variable
- Admin password secret

Required KV binding:

```txt
SUB_DB
```

Example environment variables:

```txt
ADMIN_USER=admin
ADMIN_PASS=use-a-secret-not-plaintext
```

Use a secret for the password.

## Deploy with Wrangler

Install dependencies:

```bash
npm install
```

Create KV:

```bash
npx wrangler kv namespace create SUB_DB
```

Copy the example config:

```bash
cp wrangler.example.toml wrangler.toml
```

Add your KV namespace ID to `wrangler.toml`.

Set the admin password as a secret:

```bash
npx wrangler secret put ADMIN_PASS
```

Deploy:

```bash
npm run deploy
```

## Deploy from Cloudflare Dashboard

You can also deploy from inside the Cloudflare dashboard.

General steps:

1. Open Cloudflare dashboard.
2. Go to **Workers & Pages**.
3. Create a new Worker.
4. Open the online code editor.
5. Paste the contents of `src/worker.js`.
6. Save and deploy.
7. Create a KV namespace.
8. Bind the KV namespace to the Worker as `SUB_DB`.
9. Add `ADMIN_USER` as a variable.
10. Add `ADMIN_PASS` as a secret.
11. Open the admin path and log in.

See:

```txt
docs/CLOUDFLARE_DASHBOARD_DEPLOY.md
```

for the full dashboard deployment tutorial.

## Security Notes

Before publishing or deploying:

- Do not commit real admin passwords.
- Do not commit real subscription links.
- Do not commit private domains unless you intentionally want them public.
- Do not commit real client UUIDs.
- Use placeholders in screenshots and examples.
- Use `ADMIN_PASS` as a Worker secret.

Recommended placeholder examples:

```txt
example.com
worker-one.example.workers.dev
00000000-0000-4000-8000-000000000000
CLIENT_ID
admin
change-this-password
```

## Repository Structure

```txt
edgesub-manager/
├── src/
│   └── worker.js
├── docs/
│   ├── CLOUDFLARE_DASHBOARD_DEPLOY.md
│   └── OPEN_SOURCE_CHECKLIST.md
├── README.md
├── LICENSE
├── SECURITY.md
├── package.json
├── wrangler.example.toml
├── .env.example
└── .gitignore
```

## License

MIT License.

You may use, modify, distribute, and publish the project under the terms of the license.
