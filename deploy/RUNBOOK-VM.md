# 🚀 VM Deploy Runbook — observability module on real infra

> **HISTORICAL — superseded by [RUNBOOK-AWS.md](RUNBOOK-AWS.md)** for
> production (decision 140). Kept as the record of the retired Hetzner PoC;
> do not onboard new tenants with this flow. Paths and env names below are
> frozen as they were (e.g. `usage-billing-component`, pre-rename).

One client of this component on a single cloud VM: the same compose stack
and deploy scripts as a workstation, plus **caddy** on the host giving the
two public surfaces TLS. Everything else stays loopback-bound — that, not
the firewall, is what keeps the auth-less API and the databases private.

```
                      VM (docker host)
   audience ── https://obs.<host> ───────► caddy ──► 127.0.0.1:UI_PORT (module UI)
   operator ── https://langwatch.<host> ─► caddy ──► 127.0.0.1:LANGWATCH_PORT
   agent    ── https://langwatch.<host>/api/otel/v1/traces (OTLP in)
                                  api/mongo/clickhouse/postgres/redis: loopback only
```

## 0 · Provision the VM

- **8 GB RAM / 4 vCPU / 40 GB disk minimum** (LangWatch 2g + ClickHouse 2g
  are the heavy containers; the three module images also build on this box).
  Hetzner CPX31, DO 8 GB, EC2 t3.large all fit. x86_64 — confirm arm64
  manifests for `langwatch/langwatch` before picking ARM.
- Ubuntu 22.04+/Debian 12. Firewall: allow **22, 80, 443** only.
- Two DNS names pointing at the VM: `obs.<host>` and `langwatch.<host>`.
  No domain? Use sslip.io names (`obs.<ip-with-dashes>.sslip.io`) — zero
  DNS setup, Let's Encrypt still works.

## 1 · Install docker + caddy

```bash
curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER
sudo apt-get install -y caddy
```

(Re-login after usermod so `docker` works without sudo.)

## 2 · Clone + build the images

```bash
git clone git@github.com:khal-os/usage-component.git && cd usage-component && make build
```

> **Redeploys via rsync — the clobber rule.** If you ship code updates by
> rsyncing a working tree instead of git-pulling, you MUST exclude the
> VM's deploy state, or the sync silently reverts it to your laptop's
> stale copy (this happened in production: an agent redeploy overwrote
> `ENVIRONMENT=prod` + the minted `API_KEY` back to open dev mode):
>
> ```bash
> rsync -az --exclude .git --exclude node_modules --exclude clients/ \
>   ./ root@<vm>:/opt/usage-billing-component/
> ```
>
> Authoritative ON THE VM, never to be overwritten by a deploy:
> `clients/<name>.env` (public URLs, Atlas creds, project id, knobs,
> COMPOSE_PROFILES), `/etc/caddy/Caddyfile` (written from deploy/Caddyfile
> — hotfixes must flow back to the repo), and the agent's
> `/opt/martino-agent/.env` (`ENVIRONMENT=prod`, minted `API_KEY`) — the
> agent rsync needs `--exclude .env`.

## 3 · Caddy BEFORE the deploy

The onboarding script talks to LangWatch at `LANGWATCH_PUBLIC_URL`, so the
proxy must answer first. Copy [Caddyfile](Caddyfile) to
`/etc/caddy/Caddyfile`, set the two hostnames and the two ports you will
pin in step 4 (the shipped file uses `8081`/`5561`), then:

```bash
sudo systemctl reload caddy
```

## 4 · Deploy the client

Pin the ports (so they match the Caddyfile) and set the public LangWatch
URL at creation — `--env` writes it into `clients/<name>.env`, where you
can also edit it by hand later:

```bash
./deploy-demo-client.sh <name> \
  --api-port 3001 --ui-port 8081 --langwatch-port 5561 \
  --env LANGWATCH_PUBLIC_URL=https://langwatch.<host> \
  --env MODULE_PUBLIC_URL=https://obs.<host> \
  --no-demo-traces --no-demo-prices
```

Drop the two `--no-demo-*` flags if you want the stack pre-populated with
demo traffic instead of real agent traces. The summary prints the public
URLs and the LangWatch admin login (also kept in `clients/<name>.env`).

> Production-form deploys (registry images, no dev overlay) follow README
> §Production deployment instead — same env file, `make migrate-up` order.

## 5 · Verify

```bash
./scripts/5-verify-client.sh <name>
```

Then from YOUR machine: `https://obs.<host>` loads the UI,
`https://langwatch.<host>` accepts the admin login from the summary.

## 6 · Point an agent at it (traces from anywhere)

In the LangWatch UI (public URL), project settings → copy the **API key**,
then register the connector with the public OTLP endpoint — from the
machine running the connector-register (see the root RUNBOOK.md, steps
4–5, for the vault seeding):

```bash
TENANT=<tenant> CONNECTOR_ID=langwatch-<name> \
  OTLP_ENDPOINT=https://langwatch.<host>/api/otel/v1/traces \
  ./scripts/connector/register.sh
```

Ingestion is continuous: traces appear in the module UI after the quiet
period (`TRACE_INGESTION_QUIET_PERIOD_SECONDS` — the demo env writes 5 s).

## 7 · Prices

Same as local (loopback API, run on the VM):

```bash
make price CLIENT=<name> ARGS='--model <id> --token-type input --price-brl 16.50 --effective-from 2026-07-01'
```

## Day-2

```bash
make logs CLIENT=<name>      # trace-ingestion-worker: 'Sync: batch' lines
make backup CLIENT=<name>    # mongodump -> backups/ — run before ANY down -v
make down CLIENT=<name>      # stop, volumes preserved
```

## 🛠 Troubleshooting

| Symptom | Cause → fix |
|---|---|
| LangWatch login "Unauthorized: Invalid credentials" | `LANGWATCH_PUBLIC_URL` ≠ the URL in the browser → fix it in `clients/<name>.env`, `make up CLIENT=<name>` |
| Onboarding dies "LangWatch não responde em https://…" | caddy not up / wrong port in Caddyfile → step 3, then re-run `./scripts/3-onboard-langwatch.sh <name>` |
| Caddy serves a self-signed/staging cert | DNS name not resolving to this VM yet, or 80/443 blocked |
| UI up but `/api` calls fail | UI proxies the API over the compose network — `make logs CLIENT=<name>`, check the `api` container |
| Agent traces never arrive | OTLP endpoint must be the **public** URL (step 6); check the API key; quiet period delays ingestion |
| Anyone can sign up on LangWatch | By design (`NEXTAUTH_PROVIDER=email`) — add `basic_auth` or IP allowlist on the `langwatch.` site in the Caddyfile |
