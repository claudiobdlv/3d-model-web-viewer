-- Supports the admin-visible audit/security log (org-scoped, most-recent-first).
CREATE INDEX IF NOT EXISTS audit_events_org_created_idx
  ON audit_events (organization_id, created_at DESC);
