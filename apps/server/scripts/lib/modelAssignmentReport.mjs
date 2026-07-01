// Read-only SQLite helpers shared by assign-models-to-default-org.mjs and its
// tests. None of these functions write to the database — they only report on
// its current state so the dry-run/apply paths can share one source of truth.

export function getAssignmentCounts(db) {
  const totalModels = db.prepare("SELECT COUNT(*) AS n FROM models").get().n;
  const unassigned = db.prepare("SELECT COUNT(*) AS n FROM models WHERE organization_id IS NULL").get().n;
  return { totalModels, unassigned, alreadyAssigned: totalModels - unassigned };
}

// Heuristics to flag rows worth a human look before/while stamping them.
// Reporting only — never changes which rows get updated.
export function findSuspiciousModels(db) {
  const suspicious = [];

  const softDeletedUnassigned = db
    .prepare("SELECT id, slug FROM models WHERE organization_id IS NULL AND deleted_at IS NOT NULL")
    .all();
  for (const m of softDeletedUnassigned) {
    suspicious.push(`model ${m.id} (slug=${m.slug}) is soft-deleted (in Recycling) but would still be stamped`);
  }

  const missingIdentity = db
    .prepare(
      "SELECT id, slug FROM models WHERE organization_id IS NULL AND (slug IS NULL OR trim(slug) = '' OR name IS NULL OR trim(name) = '')"
    )
    .all();
  for (const m of missingIdentity) {
    suspicious.push(`model ${m.id} (slug=${m.slug ?? "(none)"}) is missing a slug or name`);
  }

  return suspicious;
}
