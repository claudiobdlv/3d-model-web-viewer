# RevVault production rollout and rollback runbook

This runbook is a plan only. Phase 7 did not merge or deploy it.

Production safety rules:

- Deploy only the services listed by `docker compose -f deploy/docker-compose.elitedesk.yml config --services`.
- The expected production services are `server` and `worker`; because these are the only services in the file, the standard deploy script may run the full compose project.
- Do not run a global Docker restart, reboot the EliteDesk, change Cloudflare, expose router ports, or touch the Pi or unrelated services.
- Do not move, rename, overwrite, or delete legacy files under `data/uploads`, `data/models`, or `data/logs`.
- Do not deploy unless the DB backup, storage inventory, previous commit, and rollback operator are confirmed.

## 1. Pre-deploy checklist

Run locally:

```powershell
git switch feature/revvault-revisions
git status --short
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git diff --check origin/main...HEAD
```

Stop if the feature branch is not clean, checks are failing, Phase 7 is not signed off, or the intended commits are not all pushed.

Run read-only on the EliteDesk:

```bash
ssh elitedesk
cd /home/claudio/projects/3d-model-web-viewer
git status --short
git branch --show-current
git rev-parse HEAD
docker compose -f deploy/docker-compose.elitedesk.yml ps
docker compose -f deploy/docker-compose.elitedesk.yml config --services
docker inspect 3d-model-web-viewer-server-1 \
  --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
ls -lh data/db/app.sqlite*
df -h .
sudo -n true || echo "Interactive sudo will be required only if DB restore is needed."
```

Expected production layout:

- Host data root: `/home/claudio/projects/3d-model-web-viewer/data`
- Container data root: `/app/data`
- SQLite DB: `data/db/app.sqlite`
- Sources: `data/uploads/<slug>/original.<ext>`
- Displays/artifacts: `data/models/<slug>/`
- Logs: `data/logs/<slug>/`

Stop if the worktree is dirty, the mount differs, the app is unhealthy, disk space is inadequate, or no rollback operator is available.

## 2. Back up the production DB safely

The production DB uses WAL. Do not copy `app.sqlite` directly while the server is running. Use SQLite's online-backup API from the running server container:

If the merge occurs after this snapshot, repeat this section and the verification
section immediately before deployment. The rollback must use the newest verified
pre-deploy backup.

```bash
cd /home/claudio/projects/3d-model-web-viewer
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$PWD/backups/revvault-$STAMP"
mkdir -p "$BACKUP_DIR"

docker exec -i 3d-model-web-viewer-server-1 node --input-type=module <<'NODE'
import { DatabaseSync, backup } from "node:sqlite";
const source = new DatabaseSync("/app/data/db/app.sqlite", { readOnly: true });
await backup(source, "/tmp/revvault-predeploy.sqlite");
source.close();
NODE

docker cp \
  3d-model-web-viewer-server-1:/tmp/revvault-predeploy.sqlite \
  "$BACKUP_DIR/app.sqlite"
docker exec 3d-model-web-viewer-server-1 \
  rm -f /tmp/revvault-predeploy.sqlite
```

Create a storage metadata inventory. This does not alter model files:

```bash
find data/uploads data/models data/logs \
  -type f -printf '%P\t%s\t%T@\n' \
  | LC_ALL=C sort \
  > "$BACKUP_DIR/storage-files.tsv"

du -sb data/uploads data/models data/logs \
  > "$BACKUP_DIR/storage-totals.txt"

sha256sum \
  "$BACKUP_DIR/app.sqlite" \
  "$BACKUP_DIR/storage-files.tsv" \
  "$BACKUP_DIR/storage-totals.txt" \
  > "$BACKUP_DIR/SHA256SUMS"
```

If a full storage snapshot is required by the release owner and adequate backup capacity is confirmed, use the existing backup script before deployment:

```bash
./scripts/backup-elitedesk.sh
```

Do not start a multi-gigabyte archive without checking free space first.

## 3. Verify the backups before deploy

```bash
test -s "$BACKUP_DIR/app.sqlite"
test -s "$BACKUP_DIR/storage-files.tsv"
test -s "$BACKUP_DIR/storage-totals.txt"
(cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS)

docker cp "$BACKUP_DIR/app.sqlite" \
  3d-model-web-viewer-server-1:/tmp/revvault-verify.sqlite

docker exec -i 3d-model-web-viewer-server-1 node --input-type=module <<'NODE'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/tmp/revvault-verify.sqlite", { readOnly: true });
console.log(db.prepare("PRAGMA integrity_check").get());
console.log(db.prepare("SELECT COUNT(*) AS models FROM models").get());
console.log(db.prepare("SELECT COUNT(*) AS shares FROM public_shares").get());
db.close();
NODE

docker exec 3d-model-web-viewer-server-1 \
  rm -f /tmp/revvault-verify.sqlite
```

Expected: `integrity_check` is `ok`, and model/share counts are plausible. Record `BACKUP_DIR` in the deploy log.

## 4. Merge plan

Perform the merge from a clean local clone, not on the production host:

```powershell
git fetch origin
git switch feature/revvault-revisions
git pull --ff-only origin feature/revvault-revisions

# Run the complete Phase 7 check list again.

git switch main
git pull --ff-only origin main
git merge --no-ff feature/revvault-revisions
git push origin main
```

Record:

```powershell
git rev-parse HEAD
git rev-parse HEAD^1
```

The first value is `NEW_MAIN`; the second is `PREVIOUS_MAIN`.

Stop if the merge conflicts, checks change after the merge, or `main` moves unexpectedly.

## 5. Production deploy

Use a short announced maintenance window because server startup runs the additive migration:

```bash
ssh elitedesk
cd /home/claudio/projects/3d-model-web-viewer

PREVIOUS_MAIN="$(git rev-parse HEAD)"
printf '%s\n' "$PREVIOUS_MAIN" > "$BACKUP_DIR/previous-main.txt"

git fetch origin
git switch main
git pull --ff-only origin main
NEW_MAIN="$(git rev-parse HEAD)"
printf '%s\n' "$NEW_MAIN" > "$BACKUP_DIR/deployed-main.txt"

./scripts/deploy-elitedesk.sh
```

The standard deploy script validates that the Compose file contains exactly `server` and `worker`, then runs `docker compose -f deploy/docker-compose.elitedesk.yml up -d --build`. Do not run `docker restart`, `systemctl restart docker`, or a host reboot.

## 6. Post-deploy health and UI checks

```bash
docker compose -f deploy/docker-compose.elitedesk.yml ps server worker
docker compose -f deploy/docker-compose.elitedesk.yml logs \
  --since=10m --no-color server worker
curl -fsS http://127.0.0.1:3009/health
curl -fsS http://127.0.0.1:3009/api/health
```

Check in the admin UI:

- Existing model list loads and existing slugs open.
- Each migrated model shows Rev 1.
- Existing current GLB, original download, logs, and artifacts still resolve.
- Upload-new-revision, make-current, public-selectability, and replacement controls render.
- No internal storage paths appear in the UI.

Check at least two pre-recorded public QR/share links:

- One older issued-drawing link opens the same model and Rev 1 as before.
- No public revision selector appears by default.
- A locked link remains on Rev 1 after a newer revision exists.
- Do not change the link's settings merely to test it.

## 7. Verify the production migration

Run these read-only queries inside the server container:

```bash
docker exec -i 3d-model-web-viewer-server-1 node --input-type=module <<'NODE'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/app/data/db/app.sqlite", { readOnly: true });
const checks = {
  integrity: db.prepare("PRAGMA integrity_check").get(),
  models: db.prepare("SELECT COUNT(*) AS count FROM models").get(),
  revisions: db.prepare("SELECT COUNT(*) AS count FROM model_revisions").get(),
  badRevisionCounts: db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT m.id
      FROM models m
      LEFT JOIN model_revisions r ON r.model_id = m.id
      GROUP BY m.id
      HAVING COUNT(r.id) <> 1 OR MIN(r.revision_label) <> '1'
    )
  `).get(),
  missingCurrent: db.prepare(`
    SELECT COUNT(*) AS count
    FROM models
    WHERE current_revision_id IS NULL
  `).get(),
  unlinkedJobs: db.prepare(`
    SELECT COUNT(*) AS count FROM jobs WHERE revision_id IS NULL
  `).get(),
  unsafeShares: db.prepare(`
    SELECT COUNT(*) AS count
    FROM public_shares
    WHERE revision_id IS NULL
       OR link_mode <> 'locked_revision'
       OR allow_revision_switching <> 0
  `).get(),
  foreignKeys: db.prepare("PRAGMA foreign_key_check").all()
};
console.log(JSON.stringify(checks, null, 2));
db.close();
NODE
```

Expected immediately after the first rollout:

- `integrity_check = ok`
- revision count equals model count
- `badRevisionCounts = 0`
- `missingCurrent = 0`
- `unlinkedJobs = 0`
- `unsafeShares = 0`
- no foreign-key violations

Restart only the server once, then repeat the counts to prove idempotency:

```bash
docker compose -f deploy/docker-compose.elitedesk.yml restart server
docker compose -f deploy/docker-compose.elitedesk.yml ps server
```

Stop and roll back if a duplicate revision appears, a public link changes behavior, storage files change, or the server is unhealthy.

## 8. Rollback before migration

If deployment fails before the new server starts, restore only the previous code:

```bash
cd /home/claudio/projects/3d-model-web-viewer
PREVIOUS_MAIN="$(cat "$BACKUP_DIR/previous-main.txt")"
git checkout --detach "$PREVIOUS_MAIN"
docker compose -f deploy/docker-compose.elitedesk.yml up -d --build
```

The DB backup should not be restored if migration did not run.

## 9. Rollback after migration

The migration is additive, so the previous code is expected to tolerate the extra tables and nullable/defaulted columns. The lowest-risk first rollback is code-only:

```bash
cd /home/claudio/projects/3d-model-web-viewer
PREVIOUS_MAIN="$(cat "$BACKUP_DIR/previous-main.txt")"
git checkout --detach "$PREVIOUS_MAIN"
docker compose -f deploy/docker-compose.elitedesk.yml up -d --build
```

Recheck health, an existing model, and a known QR link. If they work, retain the migrated DB and investigate offline.

Restore the DB backup only if the migrated DB is corrupt or the old code cannot operate with it. Before restoring, confirm no model upload, share-setting change, or other required write occurred after deployment; restoring the backup discards post-backup DB changes.

```bash
cd /home/claudio/projects/3d-model-web-viewer
docker compose -f deploy/docker-compose.elitedesk.yml stop worker server

sudo cp data/db/app.sqlite \
  "$BACKUP_DIR/failed-migrated-app.sqlite"
sudo cp "$BACKUP_DIR/app.sqlite" data/db/app.sqlite
sudo rm -f data/db/app.sqlite-wal data/db/app.sqlite-shm
sudo chmod 0644 data/db/app.sqlite

PREVIOUS_MAIN="$(cat "$BACKUP_DIR/previous-main.txt")"
git checkout --detach "$PREVIOUS_MAIN"
docker compose -f deploy/docker-compose.elitedesk.yml up -d --build
```

Then run health checks and compare the restored model/share counts with the values recorded before deployment.

Do not restore or delete model storage during a normal RevVault rollback. Phase 7 proved the migration changes DB rows only. If a future release unexpectedly modifies storage, stop and reconcile it against `storage-files.tsv`; do not manually move or delete files.

## 10. Stop/go decisions

Go only when:

- feature and merged-main checks pass;
- online DB backup integrity is `ok`;
- backup hashes and storage inventory verify;
- production worktree and services are healthy;
- the rollback operator, `PREVIOUS_MAIN`, and `BACKUP_DIR` are recorded.

Stop immediately when:

- the DB cannot be backed up online;
- migration counts are inconsistent;
- SQLite reports locks, corruption, or foreign-key violations;
- existing slugs, downloads, or QR/share links regress;
- old links expose revision switching;
- any legacy file is moved, renamed, overwritten, or deleted;
- disk space is unexpectedly low.

## 11. Things not to do

- No global Docker restart.
- No EliteDesk reboot.
- No Cloudflare or router change.
- No Pi access.
- No manual file moves.
- No deletion of legacy storage.
- No direct copy of a live WAL database.
- No DB restore after new writes without an explicit reconciliation decision.
