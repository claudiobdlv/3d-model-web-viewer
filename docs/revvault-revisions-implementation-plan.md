# RevVault Revisions System Implementation Plan

This document outlines the design and implementation strategy for transitioning the RevVault 3D Model Web Viewer from a single-file-per-model structure to a multi-revision-per-model system.

## 1. Current Architecture Summary

The current application operates on a strict **one uploaded file = one model** model.
- **Database**:
  - `models`: Stores model meta, status, file sizes, and project/folder associations.
  - `jobs`: Stores converter worker jobs associated directly with models (`model_id`, `model_slug`).
  - `public_shares`: Manages tokenized public URLs for a model (`model_id`).
- **File Storage**:
  - Original Uploads: `storage/uploads/<model_slug>/original.<ext>`
  - Converted Artifacts: `storage/models/<model_slug>/display.glb`, `manifest.json`, `stats.json`, etc.
  - Conversion Logs: `storage/logs/<model_slug>/conversion.log`
- **Converter Worker**:
  - Polls `GET /api/worker/jobs/next`, downloads original file via `GET /api/worker/jobs/:id/source`, processes it, and uploads the artifacts back via `POST /api/worker/jobs/:id/complete`.

---

## 2. Proposed Database Changes

We introduce the `model_revisions` table to handle revisions per model, and link jobs, public shares, and files to specific revisions.

```sql
-- Create model_revisions table
CREATE TABLE IF NOT EXISTS model_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL,
  revision_label TEXT NOT NULL,
  date_issued TEXT NOT NULL,          -- YYYY-MM-DD format
  status TEXT NOT NULL,               -- 'uploaded', 'processing', 'ready', 'failed', 'cancelled'
  has_display_glb INTEGER NOT NULL DEFAULT 0,
  glb_size_bytes INTEGER,
  original_size_bytes INTEGER,
  quality TEXT NOT NULL,              -- 'low', 'medium', 'high'
  source_filename TEXT NOT NULL,
  source_ext TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1, -- 0 if replaced/superseded by a replacement upload
  replaced_by_id INTEGER,             -- self-reference to the replacement revision ID
  replacement_reason TEXT,            -- optional log of why this revision was replaced
  allowed_in_public_viewer INTEGER NOT NULL DEFAULT 0,
  is_current INTEGER NOT NULL DEFAULT 0, -- 1 if this is the active displaying revision for the model
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
  FOREIGN KEY (replaced_by_id) REFERENCES model_revisions(id) ON DELETE SET NULL
);

-- Indexes for model revisions
CREATE INDEX IF NOT EXISTS model_revisions_model_active_idx 
  ON model_revisions (model_id, is_active);

-- Link jobs to revisions
ALTER TABLE jobs ADD COLUMN revision_id INTEGER REFERENCES model_revisions(id) ON DELETE SET NULL;

-- Update public_shares for revision locking
ALTER TABLE public_shares ADD COLUMN revision_id INTEGER REFERENCES model_revisions(id) ON DELETE SET NULL;
ALTER TABLE public_shares ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 1;
```

---

## 3. Proposed Migration Strategy for Existing Models

When `initDb()` runs on server startup:
1. Initialize the new schema columns and tables.
2. If `model_revisions` is empty, run a backfill transaction:
   - For each model in `models`:
     - Retrieve its corresponding `quality` from its latest job (defaulting to `'medium'`).
     - Insert a new `model_revisions` record representing **Rev 1**:
       - `model_id` = model ID
       - `revision_label` = `'Rev 1'`
       - `date_issued` = model `created_at` date prefix (YYYY-MM-DD)
       - `status`, `has_display_glb`, `glb_size_bytes`, `original_size_bytes`, `source_filename`, `source_ext` copy the model's values.
       - `is_active` = 1, `is_current` = 1, `allowed_in_public_viewer` = 1
     - Update all `jobs` matching the `model_id` to reference this new revision ID.
     - Update all `public_shares` matching the `model_id` to reference this new revision ID, and set `is_locked = 1`.
3. This ensures that all existing data transitions cleanly to the new structure.

---

## 4. Backward-Compatibility Strategy for Existing Live QR/Share Links

- **Legacy Share Token Behavior**:
  - Existing share links are migrated so their `public_shares` record has `is_locked = 1` and `revision_id` pointing to the newly created **Rev 1** record.
  - This ensures that scanning an existing printed drawing always loads the original file (now labeled "Rev 1"), maintaining absolute stability for in-field drawings.
- **Legacy Files Directory Integration**:
  - The path resolution helpers will check if revision-specific subdirectories exist. If they do not, they fallback to the legacy root directory paths. No files are moved on the production server.

---

## 5. Proposed Storage Layout for Revision-Specific Files

To avoid file collisions and prevent touching existing files, new revisions are stored inside a `revisions/<revision_id>` subdirectory under each model slug.

- **Storage Directories**:
  - Original Uploads: `storage/uploads/<model_slug>/revisions/<revision_id>/original.<ext>`
  - Converted Artifacts: `storage/models/<model_slug>/revisions/<revision_id>/`
  - Conversion Logs: `storage/logs/<model_slug>/revisions/<revision_id>/conversion.log`

- **Fallback Resolution logic in `apps/server/src/storage.ts`**:
```typescript
export function getUploadDir(slug: string, revisionId?: number): string {
  if (!revisionId) return path.join(uploadsRoot, slug);
  const revisionPath = path.join(uploadsRoot, slug, "revisions", String(revisionId));
  return fs.existsSync(revisionPath) ? revisionPath : path.join(uploadsRoot, slug);
}

export function getModelDir(slug: string, revisionId?: number): string {
  if (!revisionId) return path.join(modelsRoot, slug);
  const revisionPath = path.join(modelsRoot, slug, "revisions", String(revisionId));
  return fs.existsSync(revisionPath) ? revisionPath : path.join(modelsRoot, slug);
}

export function getLogDir(slug: string, revisionId?: number): string {
  if (!revisionId) return path.join(logsRoot, slug);
  const revisionPath = path.join(logsRoot, slug, "revisions", String(revisionId));
  return fs.existsSync(revisionPath) ? revisionPath : path.join(logsRoot, slug);
}
```

---

## 6. Proposed API Changes

### Admin API Endpoints:
- `GET /api/models/:slug/revisions`: Retrieve active revisions for the model.
- `POST /api/models/:slug/revisions`: Upload/create a new revision.
  - Accept form/body options: `revision_label` (optional, defaults to auto-incremented e.g. "Rev 2"), `date_issued` (optional, defaults to today), `quality`, `file` or chunked upload parameters.
- `POST /api/models/:slug/revisions/:id/replace`: Replace an existing revision (non-design correction).
  - Accept `reason`, `quality`, and `file`. Marks the old revision as `is_active = 0` and links it to the new active replacement via `replaced_by_id`.
- `POST /api/models/:slug/revisions/:id/make-current`: Sets this revision as `is_current = 1` for the model and updates the main `models` table columns for backward compatibility.
- `POST /api/models/:slug/revisions/:id/toggle-public`: Toggle `allowed_in_public_viewer` status.

### Public API Endpoints:
- `GET /public/:token/revisions`: Returns a list of revisions allowed in the public viewer for this model.
- `GET /public/:token/model.json?revisionId=xxx`: Resolves the specific revision details. Validates that the revision belongs to the model and is allowed.
- `GET /public/:token/model.glb?revisionId=xxx`: Returns the GLB for the requested revision.

---

## 7. Proposed Worker/Job Changes

- The worker poll `GET /api/worker/jobs/next` returns the `revision_id` in the job payload.
- Worker source download `GET /api/worker/jobs/:jobId/source` serves the correct revision original file based on `revision_id`.
- Worker completion `POST /api/worker/jobs/:jobId/complete` writes uploaded artifacts to `getModelDir(slug, job.revision_id)`.
- No modification of conversion code or Docker containers is required; all changes are transparently handled at the API controller level.

---

## 8. Proposed Admin UI Changes

- **File Manager**:
  - Add a **Revision** column in the model row displaying the current revision label (e.g. `Rev B`).
  - Rows still display one row per model.
- **Upload Modal**:
  - Include optional fields: `Revision label` (text, e.g. "Rev A"), `Date issued` (date picker, defaults to today), `Quality` preset.
- **Row Menu Actions**:
  - **Upload new revision**: Opens modal to upload a new file, specify metadata, and check "Make current" or "Allow in public viewer".
  - **Replace existing revision**: Opens modal to replace an erroneous revision (retains replacement history).
  - **Manage Revisions**: View revision history, toggle public access, change current revision.

---

## 9. Proposed Viewer UI Changes

- **Header / Meta Panel**:
  - Top left, below model name: `Rev B · Issued 24 Jun 2026`.
- **Revision Dropdown**:
  - Rendered on the right side.
  - In Admin/Private mode: displays all active revisions.
  - In Public mode: displays only active revisions where `allowed_in_public_viewer = 1`.
  - Selecting a revision re-loads the viewer with the selected GLB.

---

## 10. Proposed Public Share/QR Behaviour

- **Locked Links**: Generating a share from the row menu creates a token tied to the current revision ID. Future uploads will not alter what this QR link serves.
- **Latest Links**: Implement support for an optional `is_locked = 0` share token that always resolves to whichever revision has `is_current = 1`.
- **Safety**: Public viewer routes check permissions on every request to prevent accessing hidden/un-allowed revisions.

---

## 11. Replace-Existing-Revision Behaviour

- When an admin selects "Replace existing revision":
  - The old revision row is updated: `is_active = 0`, `replaced_by_id = [new_revision_id]`, `replacement_reason = [reason]`.
  - A new revision row is created with `is_active = 1` and the exact same `revision_label` (e.g. "Rev B").
  - The old files are preserved in `storage/models/<slug>/revisions/<old_revision_id>` and never overwritten.
  - The public share link locked to "Rev B" now points to the new revision ID (or updates dynamically to serve the new active version of "Rev B").

---

## 12. Risks and Mitigations

| Risk | Mitigation |
| :--- | :--- |
| Existing QR codes break or show wrong models | Existing shares are migrated with `is_locked = 1` pointing to the backfilled "Rev 1" revision. Legacy files are left untouched. |
| Production filesystem out-of-space due to duplicate revisions | Admins can view quotas, and we can add revision deletion policies in later phases. |
| DB transaction locks SQLite during concurrent uploads | Wrap all critical multi-row updates in clean transactions and use WAL journal mode. |

---

## 13. Suggested Implementation Phases

1. **Phase 1: DB & Path Scaffolding** (This task): Setup branches, define database schemas, and create types.
2. **Phase 2: DB Migrations & API Foundation**: Implement DB migrations, path resolvers, and the worker API changes.
3. **Phase 3: Upload & Replacement logic**: Implement the new revision upload and replacement controllers, including file write directories.
4. **Phase 4: Admin Frontend integration**: Update the file explorer row, upload modals, and revision management panel.
5. **Phase 5: Viewer Integration**: Add the revision details display and dropdown selector to both admin and public viewers.
6. **Phase 6: Testing & QA**: Run comprehensive integration tests covering public/private routing and locked links.

---

## 14. Test Plan

- **Unit Tests**:
  - Test migration scripts on temporary SQLite instances.
  - Test path overrides for legacy vs revision-specific directories.
- **API Tests**:
  - Test uploading a revision, changing the current revision, and replacing a revision.
  - Test token resolution for locked links vs latest links.
- **Manual QA**:
  - Scan simulated QR codes and ensure they display the locked revision after uploading a subsequent revision.

---

## 15. Rollback Plan

- **Code Rollback**: `git checkout main` and redeploy.
- **DB Rollback**:
  - SQLite columns cannot be dropped easily in some versions.
  - However, because we only ADDED columns to `models`, `jobs`, and `public_shares` (making them nullable or defaulted), rolling back the code allows the old code to run seamlessly against the modified database.

---

## 16. Out of Scope

- **Geometric Diff / Change Highlighting**: Explicitly out of scope for now. The database schema and viewer UI will have room to support geometric comparisons in a future phase.

---

## 17. Phase 3: Revision Upload and Replacement Controllers

Phase 3 adds server-side upload and replacement behaviour without adding the admin revision modals or viewer revision selector.

### Endpoints and request fields

- `POST /api/models`
  - Existing multipart field: `modelFile`
  - New optional fields: `revisionLabel`, `issuedDate`, `quality`, `makeCurrent`, `allowPublicSelectable`
  - The first revision always becomes current. Blank labels default to `1`; blank dates default to the current UTC date.
- `POST /api/models/:slug/revisions`
  - Multipart file field: `modelFile` or `file`
  - Optional fields: `revisionLabel`, `issuedDate`, `quality`, `makeCurrent` (default `true`), `allowPublicSelectable` (default `true`)
  - Blank labels use the next positive numeric label for that model.
- `POST /api/models/:slug/revisions/:revisionId/replace`
  - Multipart file field: `modelFile` or `file`
  - Optional fields: `replacementReason`, `quality`
  - Keeps the existing public revision label and revision ID while creating a new immutable file-version row.
- `POST /api/uploads/chunked/init` and `POST /api/uploads/chunked/:uploadId/complete`
  - Accept the same revision metadata.
  - When `modelSlug` is omitted, completion creates a new model and first revision.
  - When `modelSlug` is supplied, completion adds a revision to the existing model.

### Validation

- Model slugs and revision IDs are validated and revision ownership is enforced.
- Missing files, unsupported extensions, existing size limits, invalid quality presets, invalid booleans, and invalid `YYYY-MM-DD` dates are rejected.
- New-revision labels are trimmed and must be unique within the model. Replacement uploads intentionally retain the existing label.
- `makeCurrent=false` leaves the model's current revision unchanged.

### Storage and replacement behaviour

- New revision source: `uploads/<slug>/revisions/<revision-id>/original.<ext>`
- New revision display: `models/<slug>/revisions/<revision-id>/display.glb`
- Replacement source: `uploads/<slug>/revisions/<revision-id>/versions/<file-version>/original.<ext>`
- Replacement display: `models/<slug>/revisions/<revision-id>/versions/<file-version>/display.glb`
- Database paths remain relative to the storage root.
- Replacements mark the prior `revision_file_versions` row inactive but never delete or overwrite its source, display artifact, or history.
- Existing locked public shares continue to reference the same revision ID. Once a replacement conversion completes, that revision resolves to its new active display path.

### Job and worker linkage

- Every new revision and replacement job stores `jobs.revision_id`.
- Worker payloads include additive `revisionId`.
- Worker source downloads resolve `model_revisions.source_path`.
- Worker completion writes to `model_revisions.display_glb_path`, including versioned replacement paths.
- Revision status and size metadata are updated independently; the legacy `models` summary changes only when the affected revision is current.
- Jobs with `revision_id = NULL` retain the legacy source and output behaviour.

### Compatibility and known limitations before Phase 4

- Existing model, download, model-file, public-share, and worker URLs remain unchanged; current-revision resolution happens server-side.
- Existing legacy root files are not moved, renamed, deleted, or overwritten.
- Chunked creation of new models and new revisions is complete for Phase 3. Chunked replacement of an existing revision is not exposed; the replacement endpoint currently uses the normal multipart upload path and existing upload limits.
- Admin controls for entering metadata, uploading/replacing revisions, making revisions current, and managing public selectability remain Phase 4 work.

---

## 18. Phase 4: Admin UI for Revisions

Phase 4 exposes the existing revision foundation through the production-style admin interface without changing public viewer or QR link behaviour.

### File manager and first upload

- The file manager remains one row per model and adds a **Revision** column showing the current label as `Rev <label>`.
- Models without revision summary data show the safe fallback `Legacy`; uploads still in progress show `Rev —`.
- The normal upload dialog adds optional **Revision**, **Date issued**, and **Allow public revision selection** fields alongside the existing quality selector.
- Revision labels may be left blank for backend auto-numbering. Date issued defaults to the administrator's local calendar date, and public selectability defaults to enabled.
- Both normal and chunked first uploads send the revision metadata. Ignoring the fields preserves the existing upload workflow and creates Rev 1.

### Upload new revision workflow

- The model action menu now opens an **Upload new revision** dialog.
- The dialog supports revision label, issued date, quality, file, make-current, and public-selectability controls.
- It submits to `POST /api/models/:slug/revisions`, displays multipart upload progress, reports backend validation errors, and refreshes the model list after success.
- A blank label uses the next numeric revision. Disabling **Make this the current revision after processing** preserves the existing current revision while retaining the new entry in revision history.

### Replace revision workflow

- **Replace existing revision** loads the model's revision list and lets the administrator choose the issued revision being corrected.
- The dialog includes the required warning that replacement is for a bad upload/export/conversion, not a design change.
- It submits the selected file, quality, and optional reason to `POST /api/models/:slug/revisions/:revisionId/replace`.
- The revision label and locked share reference remain unchanged. Phase 3's immutable file-version storage preserves the previous source and display files.
- Chunked replacement remains deferred. The UI gives a clear limitation message for replacement files over the normal multipart threshold rather than attempting an unreliable oversized request.

### Manage revisions workflow

- **Manage revisions** opens a history table with revision label, issued date, conversion status, current state, public-selectability state, source and GLB sizes, upload date, and actions.
- **Make current** calls the transactional current-revision helper through the new route below, then refreshes both revision history and the file manager.
- **Available in public revision dropdown** can be toggled independently for each revision.
- **Replace** opens the replacement dialog with that revision preselected.
- Opening a specific historical revision in the admin viewer remains deferred because no dedicated safe historical-viewer route is exposed yet.

### New admin routes

- `PATCH /api/models/:slug/revisions/:revisionId/current`
  - Validates model and revision ownership.
  - Calls `setCurrentRevision`, which transactionally clears the prior current flag, sets exactly one current revision, and updates the legacy model summary.
- `PATCH /api/models/:slug/revisions/:revisionId`
  - Accepts only `{ "isPubliclySelectable": boolean }`.
  - Rejects arbitrary revision-field updates.

### Frontend API and types

- Model detail types now expose `currentRevision` and `revisions`.
- Added helpers for uploading a new revision, replacing a revision, making a revision current, updating public selectability, and fetching model revisions.
- Existing upload and model-list calls remain backward-compatible.

### Deferred after Phase 4

- Public viewer revision dropdown.
- Public QR revision-switching UI.
- Admin historical-revision viewer route.
- Change highlighting and geometric diff.
- Chunked replacement uploads.
