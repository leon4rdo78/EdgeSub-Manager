# Security Policy

## Do not publish secrets

Never commit real values for:

- `ADMIN_PASS`
- upstream subscription URLs that reveal private access tokens
- real client UUIDs unless those users consented
- private panel domains
- KV namespace values that you consider sensitive

The example files use placeholder domains, placeholder IDs, and random-looking sample values.

## Reporting security issues

Open a private security advisory on GitHub, or contact the maintainer through the repository profile.

## Recommended deployment practices

- Use a strong admin password stored with `wrangler secret put ADMIN_PASS`.
- Use HTTPS only.
- Keep the admin path non-obvious if you want basic obscurity, for example `/control-panel-9x4kq`.
- Do not expose real user subscription URLs in screenshots or issues.
- Rotate upstream subscription links and client UUIDs if they were accidentally published.
