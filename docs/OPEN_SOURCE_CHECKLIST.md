# Open Source Release Checklist

Before pushing this repository publicly:

- [ ] Search the whole repository for private domains.
- [ ] Search the whole repository for real UUIDs.
- [ ] Search the whole repository for real subscription URLs.
- [ ] Search the whole repository for passwords and tokens.
- [ ] Replace `Example Maintainers` in `LICENSE` if desired.
- [ ] Confirm `wrangler.toml` is not committed if it contains real IDs or private settings.
- [ ] Commit only `wrangler.example.toml` with placeholder values.
- [ ] Confirm `.dev.vars`, `.env`, and `.wrangler/` are ignored.
- [ ] Deploy with `wrangler secret put ADMIN_PASS` instead of putting passwords in code.
- [ ] Test every enabled output endpoint.

Useful search command:

```bash
grep -R -n -Ei 'password|secret|token|uuid|workers.dev|example.net|sub/' .
```

The command intentionally reports placeholders too. Review every result manually.
