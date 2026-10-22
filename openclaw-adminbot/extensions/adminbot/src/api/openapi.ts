// The same generated schemas drive CLI input validation and typed HTTP reads.
// Dynamic records keep their existing semantic validators; generation marks them
// explicitly instead of inventing constraints for an untyped handler.
import type { IncomingMessage } from "node:http";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import document from "../../openapi.generated.json" with { type: "json" };

type Operation = {
  requestBody?: { content?: { "application/json"?: { schema?: Record<string, unknown> } } };
};
const routes = Object.entries(document.paths)
  .map(([path, methods]) => ({
    pattern: new RegExp(
      `^${path
        .split(/(\{[^}]+\})/u)
        .map((part) =>
          part.startsWith("{") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
        )
        .join("")}$`,
      "u",
    ),
    specificity: path.replace(/\{[^}]+\}/gu, "").length,
    methods: methods as Record<string, Operation>,
  }))
  .toSorted((left, right) => right.specificity - left.specificity);

export class OpenApiInputError extends Error {
  constructor() {
    super("request body does not match the API contract");
    this.name = "OpenApiInputError";
  }
}
export function assertOpenApiBody(req: IncomingMessage, body: unknown): void {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const operation = routes.find(
    (route) => route.pattern.test(path) && route.methods[req.method?.toLowerCase() ?? ""],
  )?.methods[req.method?.toLowerCase() ?? ""];
  const schema = operation?.requestBody?.content?.["application/json"]?.schema;
  if (!schema || schema["x-schema-coverage"]) {
    return;
  }
  if (!Value.Check({ ...schema, components: document.components } as TSchema, body)) {
    throw new OpenApiInputError();
  }
}
