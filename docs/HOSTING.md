# Host Elytra on your own domain

The included Docker Compose setup runs Elytra and a Cloudflare Tunnel together. You can serve the site at `https://twitter.somedomain.org` or at any other subdomain you control.

Cloudflare provides public HTTPS. The app and its SQLite database stay on your own computer or server, and that machine must keep running for the site to stay online. You don't need router port forwarding or a public app port.

## Cloudflare Tunnel (recommended)

You need Docker with Compose and a domain managed by Cloudflare.

1. Copy the configuration template:

   ```sh
   cp .env.example .env
   ```

2. In the [Cloudflare dashboard](https://dash.cloudflare.com/), open **Networking**, then **Tunnels**, and create a tunnel. Pick the Docker connector instructions and copy the token, which is the long `eyJ...` value after `--token`. Some accounts list tunnels under **Zero Trust**, then **Networks**, then **Connectors**.

3. Edit `.env`:

   ```dotenv
   ELYTRA_PUBLIC_ORIGIN=https://twitter.somedomain.org
   CLOUDFLARE_TUNNEL_TOKEN=your-tunnel-token
   ```

   Use the exact HTTPS URL, with no trailing slash and no path. Keep `.env` private. Git ignores it, and the Docker image excludes it.

4. Start the services:

   ```sh
   docker compose up -d --build
   ```

5. In your tunnel's **Routes**, add a **Published application** (some accounts call it a **Public hostname**) with these settings:

   - Subdomain `twitter` and domain `somedomain.org`.
   - Service type **HTTP** and URL `app:3000`. Use `http://app:3000` if the field wants a full URL.
   - **HTTP Host Header** left unset, so requests keep the public hostname.

   Save the route. Cloudflare creates the DNS record for the tunnel. If it reports a conflicting record for that exact subdomain, remove the old record.

6. Open `https://twitter.somedomain.org` and create your account.

The Docker setup starts with an empty database and turns off demo seeding. Local development still seeds demo accounts. Turning off seeding does not remove accounts that already exist, so use a fresh volume for a public installation. The Docker volume is separate from the local `data/` directory, and the image contains neither your local database nor your uploads.

For the dashboard flow and token management, see Cloudflare's [tunnel setup guide](https://developers.cloudflare.com/tunnel/get-started/) and [token documentation](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/).

## Manage the server

```sh
docker compose logs -f app tunnel  # Follow the logs
docker compose up -d --build       # Rebuild after updating app code
docker compose pull tunnel         # Download a newer tunnel connector
docker compose up -d               # Apply the downloaded connector
docker compose down                # Stop, keeping the database and uploads
```

Both services restart when Docker starts. Accounts, posts, sessions, and uploads live in the `elytra-data` named volume. Don't run `docker compose down -v` unless you want to erase that volume.

Run only one app instance. SQLite and the uploads are local to the volume. The [backend operations guide](BACKEND.md) covers request budgets, rate-limit proxy identity, migrations, health checks, and isolated load testing. The Compose app trusts Cloudflare's `CF-Connecting-IP` header; keep its port reachable only through the tunnel.

### Back up

Stop the app while you copy its whole data directory, so the copy is consistent:

```sh
mkdir -p backups
docker compose stop app
docker compose cp app:/app/data ./backups/data
docker compose start app
```

Use a new destination for each backup. Keep the database, its uploads, and any SQLite WAL files together.

## Use an existing Node server or reverse proxy

Docker is optional. With Node 24 or newer, install the dependencies and build:

```sh
npm ci
ELYTRA_SEED_DEMO=false npm run build
ELYTRA_PUBLIC_ORIGIN=https://twitter.somedomain.org ELYTRA_SEED_DEMO=false npm start -- --hostname 127.0.0.1
```

Keep the Node process running with your service manager. Then choose one of these ways to reach it:

- Run `cloudflared` on the same machine, following Cloudflare's installation instructions, and point its published route at `http://localhost:3000`.
- Put an HTTPS reverse proxy in front, with Cloudflare-proxied DNS. The proxy must preserve the public `Host` or `X-Forwarded-Host` header and send `X-Forwarded-Proto: https`.

Set these variables before the app starts:

- `ELYTRA_PUBLIC_ORIGIN` controls the REST API's origin checks for cookie-authenticated writes. Server Actions also verify the forwarded host.
- `ELYTRA_SEED_DEMO=false` turns off demo seeding and the demo login hint. Set it for both the build and the start command.

Production session cookies require HTTPS, and encrypted messaging needs the browser's secure context. Sign in through the public HTTPS URL. Don't add Cloudflare rules that cache authenticated pages or `/api/*`, such as "Cache Everything".

Elytra needs a Node server with writable, persistent storage. Cloudflare acts only as the tunnel or proxy, and Node runs SQLite on your server.

## Troubleshooting

- **502.** Check `docker compose ps` and the logs. The tunnel service must route to `http://app:3000`. Inside the tunnel container, `localhost:3000` points at the tunnel itself.
- **403 on posts or uploads.** `ELYTRA_PUBLIC_ORIGIN` must match the browser URL exactly. After you fix it, run `docker compose up -d` to apply the change.
- **Server Action host mismatch.** Clear any HTTP Host Header override on the tunnel route, or make your proxy forward the public hostname.
- **Tunnel disconnected.** Check the token and the host's outbound connection to Cloudflare. The Cloudflare guide linked above lists the firewall requirements.
