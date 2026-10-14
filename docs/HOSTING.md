# Host Elytra on your own domain

The included Docker Compose setup runs Elytra and a Cloudflare Tunnel together.
You can use `https://twitter.somedomain.org`, or any other subdomain you control.
Cloudflare handles public HTTPS; the app and its SQLite database stay on your
computer or server. That machine must stay running for the site to remain online.
No router port forwarding or public app port is required.

## Cloudflare Tunnel (recommended)

You need Docker with Compose and a domain managed by Cloudflare.

1. Copy the configuration template:

   ```sh
   cp .env.example .env
   ```

2. In the [Cloudflare dashboard](https://dash.cloudflare.com/), open
   **Networking → Tunnels** and create a tunnel. Select the Docker connector
   instructions and copy the token (the long `eyJ…` value after `--token`).
   Some accounts expose tunnels under **Zero Trust → Networks → Connectors**.

3. Edit `.env`:

   ```dotenv
   ELYTRA_PUBLIC_ORIGIN=https://twitter.somedomain.org
   CLOUDFLARE_TUNNEL_TOKEN=your-tunnel-token
   ```

   Use the exact HTTPS URL, with no trailing slash or path. Keep `.env` private;
   it is ignored by Git and excluded from the Docker image.

4. Start the services:

   ```sh
   docker compose up -d --build
   ```

5. In your tunnel's **Routes**, add a **Published application** (also called
   **Public hostname**). Choose subdomain `twitter` and domain `somedomain.org`.
   Set the service type to **HTTP** and URL to **app:3000**
   (`http://app:3000` if the field expects a full URL). Leave **HTTP Host Header**
   unset so requests keep the public hostname. Save the route; Cloudflare creates
   the tunnel DNS record. Remove an existing conflicting record for that exact
   subdomain if Cloudflare asks you to.

6. Open `https://twitter.somedomain.org` and create your account.

The Docker setup starts with an empty database and disables automatic demo
seeding. Local development still seeds demo accounts. Disabling seeding does
not remove accounts from an existing database, so start with a fresh volume for
a public installation. The Docker volume is separate from the local `data/`
directory; the image does not contain your local database or uploads.

See Cloudflare's [tunnel setup guide](https://developers.cloudflare.com/tunnel/get-started/)
for the dashboard flow and [token documentation](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)
for token management.

## Manage the server

```sh
docker compose logs -f app tunnel
docker compose up -d --build       # Rebuild after updating app code
docker compose pull tunnel        # Download a newer tunnel connector
docker compose up -d              # Apply the downloaded connector
docker compose down               # Stop; keep database and uploads
```

Both services restart automatically when Docker starts again. Accounts, posts,
sessions, and uploads live in the `elytra-data` named volume. Do not run
`docker compose down -v` unless you intend to erase that volume.
Run a single app instance because SQLite and uploads are local to this volume.

For a consistent backup, stop the app while copying its entire data directory:

```sh
mkdir -p backups
docker compose stop app
docker compose cp app:/app/data ./backups/data
docker compose start app
```

Use a fresh backup destination each time and retain the database together with
its uploads and any SQLite WAL files.

## Use an existing Node server or reverse proxy

Docker is optional. With Node 24 or newer, install dependencies and build:

```sh
npm ci
ELYTRA_SEED_DEMO=false npm run build
ELYTRA_PUBLIC_ORIGIN=https://twitter.somedomain.org ELYTRA_SEED_DEMO=false npm start -- --hostname 127.0.0.1
```

Keep the Node process running using your service manager. Run `cloudflared` on
the same machine using Cloudflare's installation instructions, and point its
published route to `http://localhost:3000`. You can instead use an HTTPS reverse
proxy with Cloudflare-proxied DNS; preserve the public `Host`/`X-Forwarded-Host`
and forward `X-Forwarded-Proto: https`. `ELYTRA_PUBLIC_ORIGIN` controls the REST
API's cookie mutation checks; Server Actions also verify the forwarded host.
These variables must be present when the app starts. Set `ELYTRA_SEED_DEMO=false`
for both build and start to disable demo seeding and the demo login hint.

Production session cookies require HTTPS, and encrypted messaging uses browser
cryptography that requires a secure context. Use the public HTTPS URL to sign in.
Avoid Cloudflare rules that cache authenticated pages or `/api/*` (such as
"Cache Everything"); leave dynamic requests uncached.

Elytra needs a Node server with writable persistent storage. This setup uses
Cloudflare as a tunnel/proxy, while Node runs SQLite on your server.

## Troubleshooting

- **502:** Check `docker compose ps` and logs. The Compose tunnel service must
  route to `http://app:3000`, not `localhost:3000` (which is the tunnel container).
- **403 on posts or uploads:** Ensure `ELYTRA_PUBLIC_ORIGIN` exactly matches
  the browser URL, then run `docker compose up -d` to apply the change.
- **Server Action host mismatch:** Clear any tunnel HTTP Host Header override,
  or fix your proxy to forward the public hostname.
- **Tunnel disconnected:** Verify the token and the host's outbound connection
  to Cloudflare; see the linked Cloudflare guide for firewall requirements.
