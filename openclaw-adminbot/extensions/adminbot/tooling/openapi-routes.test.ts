import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { buildOpenApi } from "./generate-openapi.js";
import { regexPaths } from "./openapi-routes.js";

function fixture(source: string) {
  const root = mkdtempSync(join(tmpdir(), "adminbot-openapi-"));
  mkdirSync(join(root, "src/api"), { recursive: true });
  writeFileSync(join(root, "src/api/server.ts"), source);
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("generation follows new handlers and TypeScript fields without a route/schema table", () => {
  const source = `
    declare const req: {method: string}; declare const url: URL; declare const res: unknown;
    declare function readJson(req: unknown): Promise<unknown>;
    declare function sendJson(res: unknown, status: number, body: unknown): void;
    type Progress = {current_step: 'writing' | 'submitted'; done?: boolean};
    async function handleAuthenticatedRoute() {
      const paper = /^\\/papers\\/([^/]+)\\/progress$/u.exec(url.pathname);
      if (req.method === 'PATCH' && paper?.[1]) {
        const body = await readJson(req) as Progress;
        sendJson(res, 200, {saved: body.current_step}); return;
      }
    }`;
  const example = fixture(source);
  try {
    const first = buildOpenApi(example.root);
    const operation = first.paths["/papers/{papers_id}/progress"].patch as {
      requestBody: {
        content: {
          "application/json": { schema: { properties: { current_step: { enum: string[] } } } };
        };
      };
    };
    assert.deepEqual(
      operation.requestBody.content["application/json"].schema.properties.current_step.enum,
      ["writing", "submitted"],
    );
    assert.deepEqual(buildOpenApi(example.root), first);
    writeFileSync(
      join(example.root, "src/api/server.ts"),
      source.replace("'submitted'", "'submitted' | 'accepted'").replace("/progress$", "/stage$"),
    );
    const updated = buildOpenApi(example.root);
    assert.ok(updated.paths["/papers/{papers_id}/stage"]);
    assert.notEqual(updated["x-source-sha256"], first["x-source-sha256"]);
  } finally {
    example.close();
  }
});

test("optional suffixes keep GET/POST guards instead of inventing route combinations", () => {
  const example = fixture(`
    declare const req: {method: string}; declare const url: URL;
    function handleAuthenticatedRoute() {
      const request = /^\\/requests\\/([^/]+)(\\/close)?$/u.exec(url.pathname);
      if (request && ((req.method === 'PUT' && !request[2]) || (req.method === 'POST' && request[2]))) { return; }
    }`);
  try {
    const paths = buildOpenApi(example.root).paths;
    assert.deepEqual(Object.keys(paths["/requests/{requests_id}"]), ["put"]);
    assert.deepEqual(Object.keys(paths["/requests/{requests_id}/close"]), ["post"]);
  } finally {
    example.close();
  }
});

test("unrecognized route selectors fail generation rather than silently losing coverage", () => {
  assert.throws(() => regexPaths("/^\\/items\\/(\\d+)$/u"), /Unsupported route regex/u);
  const example = fixture(
    `declare const req: {method: string}; declare const url: URL; function routeRequest() { if (req.method === 'GET' && url.pathname.endsWith('/future')) { return; } }`,
  );
  try {
    assert.throws(() => buildOpenApi(example.root), /Uncovered route selector/u);
  } finally {
    example.close();
  }
});
