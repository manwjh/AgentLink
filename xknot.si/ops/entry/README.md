# Entry for issued subdomains (hub side)

Entry configuration is not distributed as files: `server/provision.mjs` and `ops/provision-worker.mjs` render a subdomain's placeholder page, static root, nginx conf, certificate, tunnel account and sshd `Match` block, write them on the entry host through `sudo`, and re-check them afterwards. Nothing on the instance side installs anything here.

This directory holds **what needs a human**: a conf that deviates from the generator, a connection runbook for one subdomain, an operator note that cannot be expressed as a step. A file belongs here only when it hardcodes one subdomain; anything reusable is code in `server/provision.mjs`. The one exception is `knot-realip.conf`: it is http-level and shared by every subdomain, so it cannot be rendered per subdomain.

| You want to know | See |
|--------|-----|
| Which steps run, in what order, with what artifact | [`../../docs/HANDOFF.md`](../../docs/HANDOFF.md) section 3 |
| What the rendered conf looks like, byte for byte | `server/fixtures/`, `server/provision.golden.test.mjs` |
| How subdomains are applied for and listed | [`../../docs/JOIN.md`](../../docs/JOIN.md) |
| What the instance side runs | [`../../../knot-platform/ops/README.md`](../../../knot-platform/ops/README.md) section 4 |

## Who writes `<subdomain>.conf`

- **The hub** writes it. Every conf carries `由 auto-connect 生成，请勿手改` on the first line and is verified and, when the generator changes, rewritten.
- **A human** writes it only when the subdomain needs something no generator does. Such a conf has no mark; the worker reads the file before touching it and steps aside (`MANAGED_MARK` in `server/provision.mjs`, covered by `provision.test.mjs`).

`node server/admin-cli.mjs entry-adopt <id>` takes over a hand-maintained conf for a listed instance: the original is kept as `<subdomain>.conf.adopted`, the hub version is written, and the worker checks it from then on.

## Existing entries

None. Every `<subdomain>.conf` under `/etc/nginx/conf.d/` is written by automatic provisioning; the repo keeps no per-subdomain override.

`knot-realip.conf` is the one file installed by hand, once per entry host: it restores the real client address from Cloudflare for every subdomain (see the header of the file for the install commands).

## Why it sits with the hub config

The hub host and the entry host run on the same machine today. These files are installed and changed by hub staff during issuance and connection, so they follow the hub repo; role ownership is unchanged — they are **config on the entry host**, not config for the hub site `xknot.si`. The easiest mistake on a shared machine is editing the hub site with an entry conf, or the reverse. Concepts in [`../../../docs/concepts.md`](../../../docs/concepts.md).
