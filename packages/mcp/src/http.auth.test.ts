import assert from "node:assert/strict";
import test from "node:test";
import { createAuthMiddleware } from "./http.js";

// Minimal mock for Express req/res
function mockReq(authHeader?: string): any {
    return {
        headers: {
            authorization: authHeader
        }
    };
}

function mockRes(): any {
    const res: any = {
        statusCode: 200,
        body: null,
        status(code: number) {
            res.statusCode = code;
            return res;
        },
        json(data: any) {
            res.body = data;
            return res;
        }
    };
    return res;
}

test("auth middleware: allows request with valid token", () => {
    const middleware = createAuthMiddleware("my-secret-token");
    const req = mockReq("Bearer my-secret-token");
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
});

test("auth middleware: rejects request with invalid token", () => {
    const middleware = createAuthMiddleware("my-secret-token");
    const req = mockReq("Bearer wrong-token");
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error.code, -32000);
    assert.equal(res.body.error.message, "Unauthorized");
});

test("auth middleware: rejects request without Authorization header", () => {
    const middleware = createAuthMiddleware("my-secret-token");
    const req = mockReq(undefined);
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
});

test("auth middleware: rejects request with non-Bearer scheme", () => {
    const middleware = createAuthMiddleware("my-secret-token");
    const req = mockReq("Basic my-secret-token");
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
});
