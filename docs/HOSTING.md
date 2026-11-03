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

## Choose how people sign in

Elytra has two sign-in modes. Pick one with `ELYTRA_ACCOUNTS` in `.env`.

- `local` is the default. People create an account with a username and password on your Elytra.
- `oidc` adds a "Continue with CrystlCloud" button. It works with CrystlCloud Accounts or any OpenID Connect provider that supports the authorization code flow with PKCE and a client secret.

### Local accounts

Leave `ELYTRA_ACCOUNTS` unset, or set it to `local`. Nothing else is needed.

### CrystlCloud Accounts or another OIDC provider

1. Register Elytra with the provider. Its redirect URI is your public origin followed by `/api/oidc/callback`. For CrystlCloud Accounts, run this in the accounts server's directory:

   ```sh
   npm run client -- add Elytra https://twitter.somedomain.org/api/oidc/callback --owner you@example.com --uri https://twitter.somedomain.org
   ```

   With Docker, replace `npm run client --` with `docker compose exec accounts node src/clients.ts`. The command prints the client ID and a secret. It shows the secret only once.

2. Add these lines to `.env`:

   ```dotenv
   ELYTRA_ACCOUNTS=oidc
   ELYTRA_OIDC_ISSUER=https://accounts.crystlcloud.org/api/auth
   ELYTRA_OIDC_CLIENT_ID=the-client-id
   ELYTRA_OIDC_CLIENT_SECRET=the-client-secret
   ```

   The issuer must match the provider's `issuer` value exactly. For CrystlCloud Accounts it ends in `/api/auth`. Elytra reads `<issuer>/.well-known/openid-configuration` to find the other endpoints. `ELYTRA_PUBLIC_ORIGIN` is required in this mode, because Elytra builds the redirect URI from it.

3. Optionally set `ELYTRA_OIDC_NAME` to change the name on the button. It defaults to `CrystlCloud`.

4. Run `docker compose up -d` to apply the change.

Password sign-in stays on. Set `ELYTRA_PASSWORD_LOGIN=false` to allow only the provider. That hides the password form and the sign-up page, and the `/auth/login` and `/auth/register` API calls return 403. Accounts without a connected provider account can't sign in in that mode, so have existing users connect first.

How accounts connect:

- Someone who signs in through the provider for the first time picks an Elytra username. Elytra never takes the username from their email. The display name starts as their provider name, and they can choose to use their provider photo as the avatar.
- Someone who already has an Elytra account signs in with their password, opens Settings, and selects Connect next to "CrystlCloud account". After that, either sign-in method opens the same account.
- Elytra never connects two accounts because their email addresses match.
- User IDs don't change, so posts, follows, and encrypted messages stay with the account. A new device still needs the messaging recovery code.
- Signing out of Elytra doesn't sign you out of the provider.

If the provider is unreachable, the sign-in page shows an error and password sign-in, when enabled, keeps working.

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

- `ELYTRA_PUBLIC_ORIGIN` controls the REST API's origin checks for cookie-authenticated writes. Server Actions also verify the forwarded host. It is also the origin in the image and oEmbed URLs of post link previews.
- `ELYTRA_SEED_DEMO=false` turns off demo seeding and the demo login hint. Set it for both the build and the start command.

Post links (`/<username>/status/<id>`) render previews in Discord, Slack, and similar apps. The page serves OpenGraph tags with the author, text, and images, and `/api/oembed` adds the author line and the reply, repost, and like counts. Both are readable without signing in, so the crawler needs to reach them.

Production session cookies require HTTPS, and encrypted messaging needs the browser's secure context. Sign in through the public HTTPS URL. Don't add Cloudflare rules that cache authenticated pages or `/api/*`, such as "Cache Everything".

Elytra needs a Node server with writable, persistent storage. Cloudflare acts only as the tunnel or proxy, and Node runs SQLite on your server.

## Troubleshooting

- **502.** Check `docker compose ps` and the logs. The tunnel service must route to `http://app:3000`. Inside the tunnel container, `localhost:3000` points at the tunnel itself.
- **403 on posts or uploads.** `ELYTRA_PUBLIC_ORIGIN` must match the browser URL exactly. After you fix it, run `docker compose up -d` to apply the change.
- **Server Action host mismatch.** Clear any HTTP Host Header override on the tunnel route, or make your proxy forward the public hostname.
- **Tunnel disconnected.** Check the token and the host's outbound connection to Cloudflare. The Cloudflare guide linked above lists the firewall requirements.

## Optional local moderation sidecar

The base deployment does not require a model server. To opt in, follow
[MODERATION.md](MODERATION.md) for the extra Compose overlay, CPU/CUDA/ROCm/Vulkan
profiles, read-only GGUF mount, loopback-only server port, and failure fallback.
Include moderation audit/outbox tables in the existing database backup.
