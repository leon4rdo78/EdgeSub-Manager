# EdgeSub Manager

EdgeSub Manager is a Cloudflare Worker subscription manager for Xray-style proxy links.

It stores clients in Cloudflare KV, serves per-client subscription links, optionally reads traffic and expiry data from an upstream subscription URL, and can convert VLESS links into raw Xray links, Base64 subscriptions, Mihomo YAML, sing-box JSON, and an Xray least-ping balancer JSON.

The project is designed to be self-hosted on Cloudflare Workers.

## Features

- Admin panel protected by Basic Auth.
- Cloudflare KV client database.
- Per-client manual config storage.
- Optional upstream subscription URL for traffic and expiry headers.
- Safe UUID replacement rules.
- Storage-only subscriptions.
- Per-client output enable/disable switches.
- Raw Xray/VLESS subscription output.
- Base64 encoded subscription output.
- Mihomo YAML output with selector and `url-test` latency balancer.
- sing-box JSON output.
- Xray JSON least-ping balancer output.
- No bundled routing rules, direct rules, block rules, or rule providers.

## Endpoints

Assuming the Worker is deployed at:

```txt
https://example-sub-worker.example.workers.dev
```

The subscription endpoints are:

```txt
/sub/CLIENT_ID        Raw Xray/VLESS subscription links
/sub/CLIENT_ID/ty     Base64 encoded raw subscription
/sub/CLIENT_ID/cl     Mihomo YAML
/sub/CLIENT_ID/sb     sing-box JSON
/sub/CLIENT_ID/bl     Xray least-ping balancer JSON
/client/CLIENT_ID     Backward-compatible raw subscription alias
```

The admin panel is:

```txt
/admin
```

You can change the admin path with `ADMIN_PATH` in `wrangler.toml`.

## How client records work

Each client has:

- client name
- optional client UUID
- optional upstream subscription URL
- manual configs, one per line
- profile title
- enabled/disabled status
- optional INFO config for raw/Base64 output
- update interval
- enabled output formats

### UUID behavior

If the Client UUID field is filled, every UUID found inside the manual configs is replaced with that client UUID.

If the Client UUID field is empty, manual configs are served exactly as stored. This is useful for storage-only subscriptions.

If the Client UUID field is empty but the upstream subscription URL is filled, the Worker still fetches traffic and expiry headers from the upstream link, but does not touch UUIDs inside manual configs.

## Traffic and expiry data

The Worker fetches the upstream subscription URL and reads:

```http
Subscription-Userinfo: upload=...; download=...; total=...; expire=...
```

The Worker forwards this standard header to clients and also adds readable helper headers:

```http
X-EdgeSub-Remaining-Traffic: infinite
X-EdgeSub-Expire-Tehran: 2026-06-20 14:30:00 Asia/Tehran
X-EdgeSub-Remaining-Days: 26
```

For compatibility, the standard `Subscription-Userinfo` header remains numeric. Infinite traffic is shown as `∞` only in the optional INFO config remark.

## Mihomo output

The `/cl` output returns a minimal Mihomo YAML with:

- `proxies`
- a manual `select` group
- an automatic `url-test` group

The automatic group checks latency every 180 seconds, which is 3 minutes:

```yaml
proxy-groups:
  - name: "EdgeSub"
    type: select
    proxies:
      - "Auto - Lowest Latency"
      - "Example Proxy 1"
      - "Example Proxy 2"

  - name: "Auto - Lowest Latency"
    type: url-test
    proxies:
      - "Example Proxy 1"
      - "Example Proxy 2"
    url: "http://www.gstatic.com/generate_204"
    interval: 180
    tolerance: 50
```

No rules are appended.

## Requirements

- Node.js
- Cloudflare account
- Wrangler CLI
- Cloudflare Workers KV namespace

## Installation

Clone the repository:

```bash
git clone https://github.com/example-user/edgesub-manager.git
cd edgesub-manager
```

Install dependencies:

```bash
npm install
```

Copy the example Wrangler config:

```bash
cp wrangler.example.toml wrangler.toml
```

Create a KV namespace:

```bash
npx wrangler kv namespace create SUB_DB
```

Copy the returned namespace ID into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SUB_DB"
id = "PASTE_YOUR_KV_NAMESPACE_ID_HERE"
```

Set the admin password as a secret:

```bash
npx wrangler secret put ADMIN_PASS
```

Set a long random password when prompted.

Check syntax:

```bash
npm run check
```

Deploy:

```bash
npm run deploy
```

Open the admin panel:

```txt
https://YOUR-WORKER.workers.dev/admin
```

Use:

```txt
username: admin
password: the secret you set with wrangler
```

## Example client setup

Normal UUID-rewrite client:

```txt
Client name: Example User
Client UUID: 6f6a2f6d-8e42-4ef3-bf21-3ef9e57b0a01
Upstream subscription URL: https://panel.example.net:2096/sub/example-token
Manual configs:
vless://11111111-1111-4111-8111-111111111111@example.net:443?encryption=none&security=tls&type=ws&host=worker.example.net&path=%2Fdownload#Example-Proxy
```

The output will replace the UUID inside the manual config with:

```txt
6f6a2f6d-8e42-4ef3-bf21-3ef9e57b0a01
```

Storage-only client:

```txt
Client name: Storage Example
Client UUID: leave empty
Upstream subscription URL: optional
Manual configs: paste configs exactly as you want them returned
```

## Testing

Raw output:

```bash
curl -L "https://YOUR-WORKER.workers.dev/sub/CLIENT_ID"
```

Base64:

```bash
curl -L "https://YOUR-WORKER.workers.dev/sub/CLIENT_ID/ty"
```

Mihomo:

```bash
curl -L "https://YOUR-WORKER.workers.dev/sub/CLIENT_ID/cl"
```

sing-box:

```bash
curl -L "https://YOUR-WORKER.workers.dev/sub/CLIENT_ID/sb"
```

Xray least-ping balancer:

```bash
curl -L "https://YOUR-WORKER.workers.dev/sub/CLIENT_ID/bl"
```

Headers:

```bash
curl -I "https://YOUR-WORKER.workers.dev/sub/CLIENT_ID"
```

## GitHub upload tutorial

### Option A: GitHub CLI

Create the local repository:

```bash
git init
git add .
git commit -m "Initial open source release"
```

Create and push the GitHub repository:

```bash
gh repo create edgesub-manager --public --source . --remote origin --push
```

### Option B: Browser + Git

1. Create a new empty repository on GitHub.
2. Do not add a README, `.gitignore`, or license from the browser if you already have these files locally.
3. Copy the repository URL.
4. Run:

```bash
git init
git add .
git commit -m "Initial open source release"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/edgesub-manager.git
git push -u origin main
```

## License

This repository includes the MIT License.

Before publishing, replace `Example Maintainers` in `LICENSE` with your GitHub username, organization, or preferred copyright holder.

If you copy code from other projects, check their licenses first and preserve any required notices.

## Disclaimer

This project is a generic subscription-management tool. You are responsible for how you deploy and use it. Do not commit private subscription URLs, real client identifiers, passwords, tokens, or other secrets.
