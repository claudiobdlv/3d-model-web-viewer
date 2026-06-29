import assert from "node:assert/strict";
import test from "node:test";
import type express from "express";
import {
  authorizeModelForOrg,
  parseCookies,
  requireOrgMembership,
  requireRole
} from "./middleware.js";
import type { AuthContext, Membership, Organization, Role, User } from "./types.js";

function fakeContext(role: Role, status: Membership["status"] = "active"): AuthContext {
  const user = { id: "u1", primary_email: "a@b.com", status: "active" } as User;
  const organization = { id: "org1", name: "W", slug: "w", owner_user_id: "u1" } as Organization;
  const membership = { id: "m1", organization_id: "org1", user_id: "u1", role, status } as Membership;
  return { user, session: {} as AuthContext["session"], organization, membership };
}

interface MockRes {
  statusCode?: number;
  body?: unknown;
  redirected?: string;
  headersSent: boolean;
}

function mockReqRes(auth?: AuthContext, path = "/api/models") {
  const req = { auth, path, originalUrl: path, url: path, header: () => "" } as unknown as express.Request;
  const res: MockRes = { headersSent: false };
  const response = {
    status(code: number) {
      res.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      res.body = payload;
      res.headersSent = true;
      return this;
    },
    redirect(_code: number, url: string) {
      res.redirected = url;
      res.headersSent = true;
    }
  } as unknown as express.Response;
  let nextCalled = false;
  const next = (() => {
    nextCalled = true;
  }) as express.NextFunction;
  return { req, response, res, next, calledNext: () => nextCalled };
}

test("parseCookies parses a cookie header into a map", () => {
  assert.deepEqual(parseCookies("a=1; b=two; modelbase_session=tok"), { a: "1", b: "two", modelbase_session: "tok" });
  assert.deepEqual(parseCookies(undefined), {});
});

test("authorizeModelForOrg scopes models to the active workspace", () => {
  // No org context (accounts off) -> always allowed.
  assert.equal(authorizeModelForOrg({ organization_id: "org1" }, null), true);
  assert.equal(authorizeModelForOrg({ organization_id: null }, undefined), true);
  // With org context -> exact match required.
  assert.equal(authorizeModelForOrg({ organization_id: "org1" }, "org1"), true);
  assert.equal(authorizeModelForOrg({ organization_id: "org2" }, "org1"), false);
  assert.equal(authorizeModelForOrg({ organization_id: null }, "org1"), false);
});

test("requireRole enforces the role hierarchy", () => {
  const ownerGuard = requireRole("admin");

  // member is below admin -> 403
  {
    const { req, response, res, next, calledNext } = mockReqRes(fakeContext("member"));
    ownerGuard(req, response, next);
    assert.equal(calledNext(), false);
    assert.equal(res.statusCode, 403);
  }
  // admin meets the admin threshold -> next
  {
    const { req, response, res, next, calledNext } = mockReqRes(fakeContext("admin"));
    ownerGuard(req, response, next);
    assert.equal(calledNext(), true);
    assert.equal(res.statusCode, undefined);
  }
  // owner exceeds admin -> next
  {
    const { req, response, next, calledNext } = mockReqRes(fakeContext("owner"));
    ownerGuard(req, response, next);
    assert.equal(calledNext(), true);
  }
});

test("requireRole without a session returns 401 on API routes", () => {
  const guard = requireRole("viewer");
  const { req, response, res, next, calledNext } = mockReqRes(undefined, "/api/models");
  guard(req, response, next);
  assert.equal(calledNext(), false);
  assert.equal(res.statusCode, 401);
});

test("requireOrgMembership rejects inactive memberships", () => {
  {
    const { req, response, res, next, calledNext } = mockReqRes(fakeContext("member", "suspended"));
    requireOrgMembership(req, response, next);
    assert.equal(calledNext(), false);
    assert.equal(res.statusCode, 403);
  }
  {
    const { req, response, next, calledNext } = mockReqRes(fakeContext("member", "active"));
    requireOrgMembership(req, response, next);
    assert.equal(calledNext(), true);
  }
});
