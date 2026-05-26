# Deploy from the Cloudflare Dashboard

This guide explains how to deploy EdgeSub Manager without using Wrangler or a local terminal.

Use this method when you want to copy `src/worker.js` directly into the Cloudflare Workers online editor.

## What you need

- A Cloudflare account.
- The full contents of `src/worker.js` from this repository.
- A Cloudflare Workers KV namespace.
- One admin username and one strong admin password.

## 1. Create the Worker

1. Open the Cloudflare dashboard.
2. Go to **Workers & Pages**.
3. Choose **Create application** or **Create Worker**.
4. Create a basic Worker. The default starter code is fine because you will replace it.
5. Give it a generic name, for example:

```txt
edgesub-manager
```

6. Deploy the starter Worker once.
7. Open the Worker and go to the code editor / quick editor.
8. Delete the starter code.
9. Paste the full contents of:

```txt
src/worker.js
```

10. Save and deploy.

If deployment fails, copy the exact syntax error and line number. The Worker must be deployed as an ES module Worker because the code uses:

```js
export default {
  async fetch(request, env) {
    // ...
  },
};
```

## 2. Create a KV namespace

1. In the Cloudflare dashboard, go to **Workers KV**.
2. Select **Create instance** or **Create namespace**.
3. Give it a generic name, for example:

```txt
edgesub_clients
```

4. Create it.

The namespace name can be anything. The important part is the Worker binding variable name in the next step.

## 3. Bind KV to the Worker

1. Go back to **Workers & Pages**.
2. Open your Worker.
3. Go to **Settings**.
4. Open **Bindings**.
5. Add a new binding.
6. Choose **KV namespace**.
7. Set the variable/binding name exactly as:

```txt
SUB_DB
```

8. Select the KV namespace you created, for example `edgesub_clients`.
9. Save/deploy the binding change.

The Worker code expects this exact binding name:

```js
env.SUB_DB
```

If you name the binding `KV`, `DB`, or anything else, the Worker will return:

```txt
Missing KV binding: SUB_DB
```

## 4. Add variables and secrets

Open your Worker settings and go to **Variables and Secrets**.

Add these values:

### ADMIN_USER

Type: plain text variable

```txt
ADMIN_USER=admin
```

You can change `admin` to any username.

### ADMIN_PASS

Type: secret

```txt
ADMIN_PASS=use-a-long-random-password-here
```

Use a secret, not a plain text variable, because this is the admin password.

### ADMIN_PATH

Optional.

Type: plain text variable

```txt
ADMIN_PATH=/admin
```

If omitted, the default admin path is `/admin`.

After adding or editing variables/secrets, deploy the updated Worker version.

## 5. Test the Worker

Open:

```txt
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/admin
```

Use the username/password you configured:

```txt
username: admin
password: your ADMIN_PASS value
```

If the panel opens, the Worker, KV binding, and admin credentials are working.

## 6. Add your first client

In the admin panel, add a client.

### Normal UUID-rewrite client

Use this when you want the Worker to replace every UUID inside the manual configs with the client's UUID.

```txt
Client name: Example Client
Client UUID: 6f6a2f6d-8e42-4ef3-bf21-3ef9e57b0a01
Upstream subscription URL: https://panel.example.net:2096/sub/example-token
Manual configs: paste one proxy link per line
```

### Storage-only client

Use this when you want the Worker to serve configs exactly as pasted.

```txt
Client name: Storage Client
Client UUID: leave empty
Upstream subscription URL: optional
Manual configs: paste configs exactly as you want them returned
```

Important rule:

```txt
UUID field filled   = replace UUIDs in manual configs.
UUID field empty    = do not touch UUIDs in manual configs.
Sub link filled     = still fetch traffic/expiry headers from that link.
```

## 7. Test subscription outputs

Replace `CLIENT_ID` with the link ID shown in the admin panel.

Raw subscription:

```txt
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/sub/CLIENT_ID
```

Base64:

```txt
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/sub/CLIENT_ID/ty
```

Mihomo YAML:

```txt
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/sub/CLIENT_ID/cl
```

sing-box JSON:

```txt
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/sub/CLIENT_ID/sb
```

Xray least-ping balancer JSON:

```txt
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/sub/CLIENT_ID/bl
```

Old raw alias:

```txt
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/client/CLIENT_ID
```

## 8. Test headers from a terminal, optional

If you have access to a terminal, check headers with:

```bash
curl -I "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/sub/CLIENT_ID"
```

Expected useful headers:

```http
Subscription-Userinfo: upload=...; download=...; total=...; expire=...
Profile-Update-Interval: 6
X-EdgeSub-Remaining-Traffic: ...
X-EdgeSub-Expire-Tehran: ...
X-EdgeSub-Remaining-Days: ...
```

## 9. Common dashboard deployment problems

### Missing KV binding

Error:

```txt
Missing KV binding: SUB_DB
```

Fix:

- Go to Worker settings.
- Add a KV namespace binding.
- The variable name must be exactly `SUB_DB`.

### Admin password does not work

Fix:

- Check `ADMIN_USER`.
- Check `ADMIN_PASS`.
- Make sure `ADMIN_PASS` is added as a secret.
- Deploy after changing variables/secrets.

### Admin panel path is wrong

Default path:

```txt
/admin
```

If you set `ADMIN_PATH`, use that path instead.

### Converted output says no supported proxy links

The current converter supports VLESS links. Make sure your manual configs contain valid `vless://` links.

### Dashboard editor says syntax error

Fix:

- Make sure you copied the whole `src/worker.js` file.
- Do not copy Markdown code fences such as ```js.
- Make sure the first line starts with JavaScript code, not README text.
- Make sure the Worker is using module syntax and includes `export default`.

## 10. Security checklist before sharing the Worker link

- Use a long random `ADMIN_PASS`.
- Do not use the example password.
- Do not publish real upstream subscription links.
- Do not publish real client UUIDs.
- Do not expose the admin path publicly in screenshots.
- Keep the KV namespace private.
- Rotate the admin password if you accidentally paste it anywhere.
