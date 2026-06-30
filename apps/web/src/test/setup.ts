import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Fail loudly if any client code touches web storage during a test: account
// auth relies solely on the httpOnly session cookie, never localStorage/
// sessionStorage tokens. Individual tests assert this explicitly; this is a
// belt-and-braces global guard that storage spies start clean each test.
beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});
