// Route discovery uses the TypeScript AST, never a second table of URLs. Conditions
// are expanded together so optional regex suffixes keep their original method guards.
import ts from "typescript";

export type Route = {
  method: string;
  path: string;
  node: ts.Node;
  source: ts.SourceFile;
  public: boolean;
};
type Term = {
  method?: string;
  path?: string;
  regex?: ts.VariableDeclaration;
  group?: number;
  truthy?: boolean;
};
type Variant = { path: string; groups: Record<number, boolean> };
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const clean = (node: ts.Node) => node.getText().replace(/\?\./gu, ".");

function regexDeclaration(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.VariableDeclaration | undefined {
  const expression = ts.isElementAccessExpression(node) ? node.expression : node;
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }
  const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return undefined;
  }
  const init = declaration.initializer;
  if (
    ts.isCallExpression(init) &&
    ts.isPropertyAccessExpression(init.expression) &&
    init.expression.name.text === "exec" &&
    ts.isRegularExpressionLiteral(init.expression.expression) &&
    init.arguments[0]?.getText() === "url.pathname"
  ) {
    return declaration;
  }
  return undefined;
}

function terms(checker: ts.TypeChecker, node: ts.Expression): Term[][] {
  if (ts.isParenthesizedExpression(node)) {
    return terms(checker, node.expression);
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return terms(checker, node.left).flatMap((left) =>
        terms(checker, node.right).map((right) => left.concat(right)),
      );
    }
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return [...terms(checker, node.left), ...terms(checker, node.right)];
    }
    if (
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
        node.operatorToken.kind,
      )
    ) {
      for (const [left, right] of [
        [node.left, node.right],
        [node.right, node.left],
      ]) {
        if (!ts.isStringLiteral(right)) {
          continue;
        }
        if (clean(left) === "req.method" && METHODS.has(right.text)) {
          return [[{ method: right.text }]];
        }
        if (clean(left) === "url.pathname") {
          return [[{ path: right.text }]];
        }
      }
    }
  }
  const negated =
    ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken;
  const target = negated ? node.operand : node;
  const regex = regexDeclaration(checker, target);
  if (regex) {
    return [
      [
        {
          regex,
          ...(ts.isElementAccessExpression(target) && ts.isNumericLiteral(target.argumentExpression)
            ? { group: Number(target.argumentExpression.text) }
            : {}),
          truthy: !negated,
        },
      ],
    ];
  }
  return [[]];
}

export function regexPaths(text: string): Variant[] {
  const last = text.lastIndexOf("/");
  let pattern = text.slice(1, last);
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
    throw new Error(`Unanchored route regex: ${text}`);
  }
  pattern = pattern.slice(1, -1).replace(/\\\//gu, "/");
  let variants: Variant[] = [{ path: "", groups: {} }];
  let group = 0;
  for (let offset = 0; offset < pattern.length; ) {
    if (pattern.startsWith("([^/]+)", offset)) {
      group++;
      variants.forEach((variant) => {
        variant.path += `{param${group}}`;
        variant.groups[group] = true;
      });
      offset += "([^/]+)".length;
    } else if (pattern[offset] === "(") {
      const end = pattern.indexOf(")", offset);
      const literal = pattern.slice(offset + 1, end);
      if (end < 0 || pattern[end + 1] !== "?" || !/^\/[\w/-]+$/u.test(literal)) {
        throw new Error(`Unsupported route regex: ${text}`);
      }
      group++;
      variants = variants.flatMap((variant) => [
        { path: variant.path, groups: { ...variant.groups, [group]: false } },
        { path: variant.path + literal, groups: { ...variant.groups, [group]: true } },
      ]);
      offset = end + 2;
    } else {
      if (!/[\w/.-]/u.test(pattern[offset])) {
        throw new Error(`Unsupported route regex: ${text}`);
      }
      variants.forEach((variant) => {
        variant.path += pattern[offset];
      });
      offset++;
    }
  }
  // Name opaque captures by their containing collection, keeping IDs stable if a
  // later segment is added. Repeated collection names get a numeric suffix.
  return variants.map((variant) => {
    const segments = variant.path.split("/");
    const used = new Set<string>();
    variant.path = segments
      .map((segment, index) => {
        if (!segment.startsWith("{param")) {
          return segment;
        }
        const base = `${(segments[index - 1] || "resource").replaceAll("-", "_")}_id`;
        let name = base;
        for (let suffix = 2; used.has(name); suffix++) {
          name = `${base}_${suffix}`;
        }
        used.add(name);
        return `{${name}}`;
      })
      .join("/");
    return variant;
  });
}

function candidates(branchTerms: Term[]): { method: string; path: string }[] {
  const methods = [...new Set(branchTerms.flatMap((term) => (term.method ? [term.method] : [])))];
  if (methods.length !== 1) {
    return [];
  }
  const paths = branchTerms.flatMap((term) => (term.path ? [term.path] : []));
  if (paths.length) {
    return [...new Set(paths)].map((path) => ({ method: methods[0], path }));
  }
  const declarations = [
    ...new Set(branchTerms.flatMap((term) => (term.regex ? [term.regex] : []))),
  ];
  if (!declarations.length) {
    return [];
  }
  if (declarations.length > 1) {
    throw new Error("A route combines multiple regex matchers");
  }
  const declaration = declarations[0];
  const expression = (declaration.initializer as ts.CallExpression)
    .expression as ts.PropertyAccessExpression;
  return regexPaths(expression.expression.getText())
    .filter((variant) =>
      branchTerms
        .filter((term) => term.regex === declaration)
        .every(
          (term) =>
            term.group === undefined || (variant.groups[term.group] ?? false) === term.truthy,
        ),
    )
    .map((variant) => ({ method: methods[0], path: variant.path }));
}

export function discoverRoutes(checker: ts.TypeChecker, sources: ts.SourceFile[]): Route[] {
  const routes = new Map<string, Route>();
  for (const source of sources) {
    const walk = (node: ts.Node, context: Term[][] = [[]]) => {
      if (ts.isBlock(node) || ts.isSourceFile(node)) {
        let flow = context;
        for (const statement of node.statements) {
          walk(statement, flow);
          if (
            ts.isIfStatement(statement) &&
            /return[;\s]/u.test(statement.thenStatement.getText())
          ) {
            const allowed: string[] = [];
            const deniedOthers = (expression: ts.Expression): boolean => {
              if (ts.isParenthesizedExpression(expression)) {
                return deniedOthers(expression.expression);
              }
              if (!ts.isBinaryExpression(expression)) {
                return false;
              }
              if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
                return deniedOthers(expression.left) && deniedOthers(expression.right);
              }
              if (
                expression.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken ||
                clean(expression.left) !== "req.method" ||
                !ts.isStringLiteral(expression.right) ||
                !METHODS.has(expression.right.text)
              ) {
                return false;
              }
              allowed.push(expression.right.text);
              return true;
            };
            if (deniedOthers(statement.expression) && allowed.length) {
              flow = flow.flatMap((branch) => allowed.map((method) => branch.concat({ method })));
              for (const branch of flow) {
                for (const candidate of candidates(branch)) {
                  const key = `${candidate.method} ${candidate.path}`;
                  if (!routes.has(key)) {
                    routes.set(key, { ...candidate, node, source, public: false });
                  }
                }
              }
            }
          }
        }
        return;
      }
      if (ts.isIfStatement(node)) {
        const own = terms(checker, node.expression);
        const next = context.flatMap((left) => own.map((right) => left.concat(right)));
        for (const branch of next) {
          for (const candidate of candidates(branch)) {
            const key = `${candidate.method} ${candidate.path}`;
            if (!routes.has(key)) {
              let parent: ts.Node | undefined = node;
              while (parent && !ts.isFunctionDeclaration(parent)) {
                parent = parent.parent;
              }
              const functionName =
                parent && ts.isFunctionDeclaration(parent) ? parent.name?.text : undefined;
              const publicRoute =
                functionName === "routeRequest" ||
                (functionName === "handleAuthRoute" &&
                  !node.thenStatement.getText().includes("resolvePrincipal(") &&
                  !node.thenStatement.getText().includes("requirePrivileged("));
              routes.set(key, {
                ...candidate,
                node: node.thenStatement,
                source,
                public: publicRoute,
              });
            }
          }
        }
        walk(node.thenStatement, next);
        if (node.elseStatement) {
          walk(node.elseStatement, context);
        }
        return;
      }
      ts.forEachChild(node, (child) => walk(child, context));
    };
    walk(source);
  }
  // An unrecognized selector must fail regeneration, rather than silently hiding a
  // newly added endpoint from the published contract and CLI.
  for (const source of sources) {
    const audit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node)) {
        const method =
          [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
            node.operatorToken.kind,
          ) &&
          [
            [node.left, node.right],
            [node.right, node.left],
          ].some(
            ([left, right]) =>
              clean(left) === "req.method" && ts.isStringLiteral(right) && METHODS.has(right.text),
          );
        if (method) {
          let guard: ts.Node | undefined = node.parent;
          while (guard && !ts.isIfStatement(guard)) {
            guard = guard.parent;
          }
          if (
            guard &&
            ts.isIfStatement(guard) &&
            ![...routes.values()].some(
              (route) =>
                route.source === source &&
                ((route.node.pos >= guard.pos && route.node.end <= guard.end) ||
                  (guard.pos >= route.node.pos && guard.end <= route.node.end)),
            )
          ) {
            throw new Error(
              `Uncovered route selector in ${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
            );
          }
        }
      }
      ts.forEachChild(node, audit);
    };
    audit(source);
  }
  return [...routes.values()].toSorted((a, b) =>
    `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`),
  );
}
