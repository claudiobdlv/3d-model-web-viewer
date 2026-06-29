-- Phase 1 accounts schema. PostgreSQL is the production app database for the
-- auth/account layer only; models/jobs/revisions/shares remain in SQLite for now.
-- All ids are application-generated UUIDs (crypto.randomUUID) so no pgcrypto
-- extension is required. Emails are normalized to lowercase by the app.

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY,
  primary_email   TEXT NOT NULL,
  display_name    TEXT,
  avatar_url      TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ
);

-- One account per normalized email (provider account-linking is Phase 2).
CREATE UNIQUE INDEX IF NOT EXISTS users_primary_email_key
  ON users (lower(primary_email));

CREATE TABLE IF NOT EXISTS auth_identities (
  id                       UUID PRIMARY KEY,
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                 TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  issuer                   TEXT NOT NULL,
  subject                  TEXT NOT NULL,
  provider_email           TEXT,
  provider_email_verified  BOOLEAN NOT NULL DEFAULT false,
  display_name             TEXT,
  avatar_url               TEXT,
  linked_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at             TIMESTAMPTZ
);

-- Provider identity is authoritative, not email alone.
CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_provider_issuer_subject_key
  ON auth_identities (provider, issuer, subject);
CREATE INDEX IF NOT EXISTS auth_identities_user_idx ON auth_identities (user_id);

CREATE TABLE IF NOT EXISTS organizations (
  id             UUID PRIMARY KEY,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  owner_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan           TEXT NOT NULL DEFAULT 'free',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS organizations_owner_idx ON organizations (owner_user_id);

CREATE TABLE IF NOT EXISTS organization_memberships (
  id               UUID PRIMARY KEY,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS organization_memberships_user_idx ON organization_memberships (user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id                      UUID PRIMARY KEY,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash              TEXT NOT NULL UNIQUE,
  active_organization_id  UUID REFERENCES organizations(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ NOT NULL,
  revoked_at              TIMESTAMPTZ,
  last_used_at            TIMESTAMPTZ,
  ip_address              TEXT,
  user_agent              TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id               UUID PRIMARY KEY,
  event_type       TEXT NOT NULL,
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  organization_id  UUID REFERENCES organizations(id) ON DELETE SET NULL,
  metadata         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_user_idx ON audit_events (user_id);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events (created_at);
