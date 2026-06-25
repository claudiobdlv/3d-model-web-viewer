# RevVault Phase 6 local QA checklist

Use only a disposable local `DATA_DIR`. Do not point this workflow at the EliteDesk production database or production storage.

## Setup

- [ ] Confirm `git branch --show-current` is `feature/revvault-revisions`.
- [ ] Set a temporary local `DATA_DIR` and `ADMIN_PASSWORD`.
- [ ] Start the server and web app locally.
- [ ] Confirm no EliteDesk SSH session, deployment script, or production mount is involved.
- [ ] Keep browser developer tools open and verify each action has no uncaught console error.

## Model and migration coverage

- [ ] Open an existing legacy model. Confirm it still loads with its original slug and files.
- [ ] Open a migrated Rev 1 model. Confirm Rev 1 is current and the viewer loads.
- [ ] Upload a new model with no revision label. Confirm it receives the next automatic numeric label.
- [ ] Upload a new model with an explicit revision label. Confirm surrounding/repeated whitespace is normalized.
- [ ] Try the same label with different casing or whitespace. Confirm it is rejected as a duplicate.
- [ ] Confirm no upload, replacement, or revision action moves, renames, deletes, or overwrites an older source/GLB.

## Revision management

- [ ] Upload a new revision and leave “Make current” enabled.
- [ ] Upload another revision without making it current.
- [ ] Replace a revision with a file under 80 MB and confirm the revision label remains unchanged.
- [ ] Select a replacement file over 80 MB. Confirm the dialog explains that chunked replacement is deferred and blocks submission.
- [ ] Make a ready revision current.
- [ ] Confirm failed/processing revisions cannot be made current from the UI.
- [ ] Toggle “Public selectable” off and on.
- [ ] Confirm processing/failed revisions do not appear in a public revision dropdown even if marked selectable.

## Share settings and QR links

- [ ] Open “Share link and QR” for a model with one ready revision. Confirm the locked revision is selected and the selector is handled cleanly.
- [ ] Create a locked share. Confirm it defaults to the selected/current revision and public switching is off.
- [ ] Copy the link and download its QR code.
- [ ] Upload or make a newer revision current. Confirm the locked link still displays its selected revision.
- [ ] Reopen share settings. Confirm the token/link is unchanged.
- [ ] Change the share to latest/current. Confirm the same token now follows the model’s current revision.
- [ ] Change the current revision and confirm the latest/current link follows it.
- [ ] Remove the current revision in disposable test data and confirm latest/current cannot be saved or resolved.
- [ ] Change back to locked and choose a specific ready revision.
- [ ] Enable public revision switching. Confirm only ready, non-deleted, public-selectable revisions appear.
- [ ] Disable public revision switching. Confirm the dropdown disappears and guessed revision IDs fall back safely.
- [ ] Confirm revision labels, dates, and status are shown without exposing internal revision IDs.
- [ ] Confirm an old/legacy public link remains locked and has no revision dropdown by default.

## Downloads, logs, and artifacts

- [ ] In the admin viewer, select each revision and download its original/source file.
- [ ] In the admin viewer, select each ready revision and download its GLB.
- [ ] Confirm conversion logs load for the selected revision.
- [ ] Confirm `material-debug.json` and `xcaf-report.json` resolve only for the selected model revision.
- [ ] Try a malformed, missing, deleted, and foreign `revisionId` on admin download/log/artifact routes. Confirm a 404 and no fallback to another model.
- [ ] Try guessed revision IDs on public GLB/original/artifact/log URLs. Confirm hidden/foreign data is never returned.
- [ ] Verify existing public original/GLB download permission behaviour is unchanged.

## Viewer and responsive layout

- [ ] Open a model whose `currentRevision` is missing. Confirm the file manager and viewer do not crash.
- [ ] Open metadata with an empty `revisions` array. Confirm the viewer does not crash or render an empty dropdown.
- [ ] Confirm the public viewer has no Admin button, admin downloads, revision-management controls, or debug links.
- [ ] At 390 px width, confirm the viewer header, revision selector, share dialog, and bottom toolbar remain usable.
- [ ] Test touch rotate, pan, zoom, Home, theme toggle, and selection text on a phone-sized viewport.

## Replacement race and regression checks

- [ ] Start a STEP replacement job, then upload a newer replacement before the first finishes.
- [ ] Confirm the older job is cancelled/superseded.
- [ ] Attempt to publish the older job’s artifacts. Confirm the server returns 409 before writing them.
- [ ] Confirm the newest replacement remains the active source, GLB, log, and artifacts.
- [ ] Confirm all pre-existing public tokens still resolve according to their stored locked/latest settings.

## Sign-off evidence

- [ ] Record local URLs/models used, screenshots for desktop/mobile share settings, and any browser console output.
- [ ] Record all automated check results from the Phase 6 implementation plan.
- [ ] Confirm no deployment occurred and no production database, uploaded file, QR token, Pi, Cloudflare, or unrelated EliteDesk service was touched.
