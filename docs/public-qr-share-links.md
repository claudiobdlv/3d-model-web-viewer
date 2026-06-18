# Public QR share links

ModelBase can issue a read-only public link for a viewer-ready model. The admin file explorer's **Generate QR code** action creates a new 256-bit random token and downloads a 1200 px JPEG named `modelbase-qr-<slug>.jpg`. The QR is black on white, has a four-module quiet zone, and uses error-correction level H.

## Routes and data flow

- `POST /api/models/:id/share` is a Basic-Auth-protected admin action. It returns the raw token and absolute public URL once.
- `DELETE /api/models/:id/share` is protected and revokes the active link.
- `GET /public/:token` returns only the public viewer shell.
- `GET /public/:token/model.json` returns only `name`, `slug`, and the token-scoped GLB URL.
- `GET /public/:token/model.glb` serves only that share's `display.glb`.

The `public_shares` SQLite table stores the model ID, a SHA-256 token hash, an eight-character diagnostic prefix, timestamps, and an access count. The raw token is never stored. Generating another QR for the same model revokes the old active link and rotates to a new token because a hash-only token cannot be recovered safely for reuse.

The public viewer retains orbit, pan, zoom, Rotate X/Y 90 degrees, and object picking. It has no admin navigation, upload, source/GLB download, logs, rename, delete, folders, or file explorer.

Admin APIs (apart from the existing health check), `/3dviewer/*`, `/model-files/*`, `/downloads/*`, logs, uploads, and worker routes remain protected by their existing Basic Auth or worker-token controls. Public requests cannot select a path or model ID; the token resolves to one ready database model, and the server verifies that `display.glb` still exists.

## Revocation

Choose **Revoke public QR link** in the ready model's row menu. Revocation is immediate. The viewer page, metadata endpoint, and GLB endpoint then return a safe 404 response. Generating a replacement QR also revokes the prior link.

## Required manual Cloudflare Access change

Cloudflare configuration is not changed by this feature. To allow scans without a Cloudflare login, manually add a path-scoped Access application or Bypass policy for exactly:

`modelbase.parametricstandards.com/public/*`

Keep `modelbase.parametricstandards.com/*` protected by the existing Google login policy. Cloudflare **Bypass disables Access enforcement for the matched path**, so never broaden the bypass beyond `/public/*`. ModelBase still validates the token and enforces the read-only route after the bypass.

The public viewer deliberately loads its built JS/CSS from `/public/assets/*`; this keeps all resources needed by the viewer inside the same narrow bypass path.

## Configuration and limitations

`PUBLIC_BASE_URL` controls the absolute QR origin and defaults to `https://modelbase.parametricstandards.com`. Do not set it to a LAN address. Tokens are bearer credentials: anyone who obtains a QR or URL can view that model until revocation. URLs may appear in reverse-proxy access logs, so logs should be access-controlled and retained only as needed. Tokens do not expire automatically in this version; use revocation when a drawing or link is superseded.

The app sends `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and `X-Robots-Tag: noindex, nofollow` on public viewer responses where applicable. These controls reduce accidental leakage but do not replace careful QR distribution.

## Printing guidance

- Print the generated JPEG without cropping or covering its white quiet zone.
- Prefer at least 30-40 mm square on clean, high-contrast drawings; test the actual print size and site lighting before distribution.
- Avoid scaling with interpolation that blurs module edges.
- Scan one printed proof from typical working distance before issuing drawings.
- Revoke and regenerate the link when a drawing becomes obsolete.
