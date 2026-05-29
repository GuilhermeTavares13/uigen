// @vitest-environment node
import { describe, test, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Must mock before importing the module under test
vi.mock("server-only", () => ({}));

const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
};

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}));

// Import after mocks are registered
const { createSession, getSession, deleteSession, verifySession } =
  await import("@/lib/auth");

const COOKIE_NAME = "auth-token";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createSession", () => {
  test("sets an httpOnly cookie with the auth token", async () => {
    await createSession("user-1", "user@example.com");

    expect(mockCookieStore.set).toHaveBeenCalledOnce();
    const [name, , options] = mockCookieStore.set.mock.calls[0];
    expect(name).toBe(COOKIE_NAME);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
  });

  test("sets cookie expiry approximately 7 days in the future", async () => {
    const before = Date.now();
    await createSession("user-1", "user@example.com");
    const after = Date.now();

    const [, , options] = mockCookieStore.set.mock.calls[0];
    const expires: Date = options.expires;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    expect(expires.getTime()).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
    expect(expires.getTime()).toBeLessThanOrEqual(after + sevenDaysMs + 1000);
  });

  test("token is a valid signed JWT containing userId and email", async () => {
    await createSession("user-42", "test@example.com");

    const [, token] = mockCookieStore.set.mock.calls[0];
    // A JWT has three base64url parts separated by dots
    expect(token.split(".")).toHaveLength(3);

    // Decode the payload (second segment) without verifying signature
    const payloadJson = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString()
    );
    expect(payloadJson.userId).toBe("user-42");
    expect(payloadJson.email).toBe("test@example.com");
  });
});

describe("getSession", () => {
  test("returns null when no cookie is present", async () => {
    mockCookieStore.get.mockReturnValue(undefined);

    const session = await getSession();

    expect(session).toBeNull();
  });

  test("returns the session payload for a valid token", async () => {
    // Create a real token first
    await createSession("user-99", "valid@example.com");
    const [, token] = mockCookieStore.set.mock.calls[0];

    vi.clearAllMocks();
    mockCookieStore.get.mockReturnValue({ value: token });

    const session = await getSession();

    expect(session).not.toBeNull();
    expect(session?.userId).toBe("user-99");
    expect(session?.email).toBe("valid@example.com");
  });

  test("returns null for a tampered token", async () => {
    mockCookieStore.get.mockReturnValue({ value: "invalid.jwt.token" });

    const session = await getSession();

    expect(session).toBeNull();
  });

  test("returns null for a malformed token string", async () => {
    mockCookieStore.get.mockReturnValue({ value: "not-a-jwt" });

    const session = await getSession();

    expect(session).toBeNull();
  });
});

describe("deleteSession", () => {
  test("deletes the auth-token cookie", async () => {
    await deleteSession();

    expect(mockCookieStore.delete).toHaveBeenCalledOnce();
    expect(mockCookieStore.delete).toHaveBeenCalledWith(COOKIE_NAME);
  });
});

describe("verifySession", () => {
  function makeRequest(token?: string): NextRequest {
    const req = new NextRequest("http://localhost/");
    if (token) {
      req.cookies.set(COOKIE_NAME, token);
    }
    return req;
  }

  test("returns null when request has no auth cookie", async () => {
    const req = makeRequest();

    const session = await verifySession(req);

    expect(session).toBeNull();
  });

  test("returns the session payload for a valid token in the request", async () => {
    await createSession("user-7", "req@example.com");
    const [, token] = mockCookieStore.set.mock.calls[0];
    vi.clearAllMocks();

    const req = makeRequest(token);
    const session = await verifySession(req);

    expect(session).not.toBeNull();
    expect(session?.userId).toBe("user-7");
    expect(session?.email).toBe("req@example.com");
  });

  test("returns null for an invalid token in the request", async () => {
    const req = makeRequest("bad.token.here");

    const session = await verifySession(req);

    expect(session).toBeNull();
  });

  test("returns null for a token signed with a different secret", async () => {
    const { SignJWT } = await import("jose");
    const wrongSecret = new TextEncoder().encode("wrong-secret");
    const fakeToken = await new SignJWT({ userId: "evil", email: "evil@evil.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("7d")
      .setIssuedAt()
      .sign(wrongSecret);

    const req = makeRequest(fakeToken);
    const session = await verifySession(req);

    expect(session).toBeNull();
  });
});
