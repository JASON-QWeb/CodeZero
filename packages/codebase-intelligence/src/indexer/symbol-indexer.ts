import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type { FileIndexEntry } from "./file-indexer.js";

export type SymbolIndexEntry = {
  name: string;
  kind: "function" | "class" | "component" | "route" | "type" | "unknown";
  path: string;
  line: number;
};

const routeMethods = new Set(["get", "post", "put", "patch", "delete"]);

export async function indexSymbols(
  repoDir: string,
  files: FileIndexEntry[],
  limit = 5000,
): Promise<SymbolIndexEntry[]> {
  const symbols: SymbolIndexEntry[] = [];
  const codeFiles = files.filter(
    (file) =>
      [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(file.extension) &&
      file.sizeBytes < 300_000,
  );

  for (const file of codeFiles) {
    if (symbols.length >= limit) {
      break;
    }

    const absolutePath = path.join(repoDir, file.path);
    const content = await readFile(absolutePath, "utf8").catch(() => "");

    if (!content) {
      continue;
    }

    const source = ts.createSourceFile(
      file.path,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file.extension),
    );
    collectSymbols(source, file.path, symbols, limit);
  }

  return symbols;
}

function collectSymbols(
  source: ts.SourceFile,
  filePath: string,
  symbols: SymbolIndexEntry[],
  limit: number,
): void {
  const push = (
    name: string,
    kind: SymbolIndexEntry["kind"],
    node: ts.Node,
  ): void => {
    if (symbols.length >= limit) {
      return;
    }

    symbols.push({
      name,
      kind,
      path: filePath,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (symbols.length >= limit) {
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      push(node.name.text, "function", node);
    } else if (ts.isClassDeclaration(node) && node.name) {
      push(node.name.text, "class", node);
    } else if (
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.name
    ) {
      push(node.name.text, "type", node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isComponentName(node.name.text)
    ) {
      push(node.name.text, "component", node);
    } else if (ts.isCallExpression(node) && isRouteCall(node)) {
      push(routeMethodName(node) ?? "route", "route", node);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
}

function isComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(name);
}

function isRouteCall(node: ts.CallExpression): boolean {
  const expression = node.expression;

  if (!ts.isPropertyAccessExpression(expression)) {
    return false;
  }

  const method = expression.name.text;
  if (!routeMethods.has(method)) {
    return false;
  }

  const receiver = expression.expression;
  return (
    ts.isIdentifier(receiver) &&
    (receiver.text === "app" || receiver.text === "router")
  );
}

function routeMethodName(node: ts.CallExpression): string | undefined {
  const expression = node.expression;
  return ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : undefined;
}

function scriptKind(extension: string): ts.ScriptKind {
  switch (extension) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}
