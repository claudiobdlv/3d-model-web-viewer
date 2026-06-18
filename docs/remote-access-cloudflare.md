# ModelBase remote access with Cloudflare Tunnel

ModelBase is intended to be available remotely at:

- Public hostname: `modelbase.parametricstandards.com`
- Tunnel: `modelbase-elitedesk`
- Connector host: EliteDesk (`192.168.1.200`)
- Origin service: `http://localhost:3009`

The tunnel must be dashboard-managed and protected by Cloudflare Access. No
router port forwarding is required. Cloudflare Access is the outer login layer;
ModelBase's existing `ADMIN_PASSWORD` HTTP Basic authentication remains enabled
as a second layer for `/admin` and must not be removed.

## Current handoff state

As of 2026-06-18, `cloudflared` 2026.6.0 is installed on the EliteDesk from
Cloudflare's official stable apt repository. It is deliberately not configured,
running, or enabled yet because no dashboard tunnel token has been supplied.
The public hostname also has no DNS record yet.

## Dashboard setup

Use the following order so the connector is not started until Access protection
is in place.

### 1. Create the dashboard-managed tunnel

1. Open Cloudflare Zero Trust for the account containing
   `parametricstandards.com`.
2. Go to **Networks > Connectors > Cloudflare Tunnels** (the dashboard may show
   this as **Networks > Tunnels**) and choose **Create a tunnel**.
3. Select **Cloudflared**, name the tunnel `modelbase-elitedesk`, and save it.
4. Select the Debian/Ubuntu connector instructions and keep the generated
   `sudo cloudflared service install <TOKEN>` command private. Do not paste the
   token into this repository, chat logs, shell history, or documentation.
5. Add a **Published application** / **Public hostname** route:
   - Subdomain: `modelbase`
   - Domain: `parametricstandards.com`
   - Path: leave empty
   - Service type: `HTTP`
   - URL: `localhost:3009`
6. Save the route, but do not install/start the connector until the Access app
   below has been created.

Cloudflare should create the proxied DNS route as part of the public-hostname
configuration. Do not add router port forwarding.

### 2. Configure Google as an identity provider

If Google is already present under **Zero Trust > Integrations > Identity
providers** (sometimes labelled **Settings > Authentication > Login methods**),
use and test the existing integration. Otherwise:

1. In Cloudflare Zero Trust, open **Integrations > Identity providers**, choose
   **Add new**, and select **Google**.
2. In Google Cloud Console, select or create the project that will own the OAuth
   credentials and configure its OAuth consent screen.
3. Create an OAuth client ID with application type **Web application**.
4. Copy the exact callback/redirect URL shown by Cloudflare into Google's
   **Authorized redirect URIs**. Do not construct or guess this URL.
5. Copy the Google Client ID and Client Secret into Cloudflare, save the
   identity provider, and use Cloudflare's **Test** action.
6. Keep the client secret only in the Cloudflare dashboard/Google credential
   store; never place it on the EliteDesk or in this repository.

### 3. Create the Access application

1. Go to **Zero Trust > Access > Applications** and choose **Add an
   application**.
2. Select **Self-hosted**.
3. Set the application name to `ModelBase` and the public hostname to
   `modelbase.parametricstandards.com` with no path restriction.
4. Add one policy:
   - Name: `Allow approved ModelBase users`
   - Action: **Allow**
   - Include rule: **Emails** containing only the explicitly approved Google
     email address(es)
5. Select the Google identity provider for the application and save it.
6. Confirm there is no **Bypass**, **Service Auth**, broad email-domain, or
   `Everyone` allow policy.

### 4. Install and start the connector

After the Access application and allow policy are saved, SSH to the EliteDesk
and run the one-time command copied from the tunnel's connector setup page:

```bash
ssh elitedesk
sudo cloudflared service install <TOKEN_FROM_CLOUDFLARE_DASHBOARD>
```

Do not save that command in a script or the repository. After installation,
verify:

```bash
sudo systemctl status cloudflared --no-pager
sudo systemctl is-enabled cloudflared
sudo systemctl is-active cloudflared
cloudflared --version
curl -I http://localhost:3009/health
```

The expected systemd results are `enabled` and `active`, and local health should
return HTTP 200.

## Verification

Use a browser that is not already authenticated first:

1. Open `https://modelbase.parametricstandards.com` in an incognito/private
   window. It must show Cloudflare Access login, not ModelBase.
2. Attempt login with a non-approved account. Access must deny it.
3. Log in with an approved Google email. ModelBase should load.
4. Open `/admin`. Cloudflare Access should already be satisfied, and ModelBase
   should still request its own Basic Auth password.
5. Verify a viewer URL, a STEP upload/conversion, and original/GLB downloads.
6. Test a representative large upload. Cloudflare's maximum request-body size
   depends on the zone plan and can reject oversized uploads with HTTP 413;
   check the current account limit before relying on large remote uploads.

From a terminal outside the LAN, an unauthenticated request should redirect to
Cloudflare Access rather than return ModelBase content directly:

```bash
curl -I https://modelbase.parametricstandards.com
```

## Safe operation

Check or restart only the connector service:

```bash
sudo systemctl status cloudflared --no-pager
sudo journalctl -u cloudflared -n 100 --no-pager
sudo systemctl restart cloudflared
```

Do not restart Docker globally or reboot the host for tunnel troubleshooting.
Do not modify the Raspberry Pi/OpenSprinkler tunnels, router ports, Plex,
Immich, Homepage, Portainer, Dozzle, Uptime Kuma, backups, or ModelBase data.

## Troubleshooting

- **Hostname does not resolve:** confirm the tunnel's published application
  route exists and Cloudflare created the proxied DNS record.
- **Cloudflare 1033 / tunnel unavailable:** check `systemctl status cloudflared`
  and the tunnel connector status in Zero Trust.
- **502 Bad Gateway:** verify `curl -I http://localhost:3009/health` on the
  EliteDesk and confirm the route targets `http://localhost:3009`.
- **App opens without login:** immediately stop `cloudflared`, then correct the
  Access application/policy before restarting it.
- **Approved user is denied:** test the Google identity provider and confirm the
  exact signed-in email is present in the Allow policy.
- **`/admin` does not request Basic Auth:** confirm `ADMIN_PASSWORD` remains set
  in the EliteDesk project `.env`; do not print its value.
- **Upload returns HTTP 413:** the file exceeds the Cloudflare plan's current
  request-body limit. Keep the LAN upload path for larger files or change the
  product/upload architecture deliberately; do not weaken Access.

Official references:

- [Create a dashboard-managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- [Publish a self-hosted application with Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [Configure Google as an identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/)
- [Cloudflare connection and request limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)
