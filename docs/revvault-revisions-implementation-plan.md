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
