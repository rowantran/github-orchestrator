/** Purpose: prevent inline worker-authored prompt metadata and error prose. Audience: maintainers. Injection: none. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const metadataKeys = new Set(["description", "label", "promptSnippet", "promptGuidelines", "parameters", "text", "reason", "systemPrompt", "system_prompt"]);
const roots = new Set(["definition", "resources", "strings", "tool", "options", "event"]);
function rootName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return rootName(node.expression);
  return ts.isIdentifier(node) ? node.text : undefined;
}
function resourceExpression(node: ts.Expression): boolean {
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return resourceExpression(node.expression);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return roots.has(rootName(node) ?? "");
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["structuredClone", "jsonCopy"].includes(node.expression.text)) {
    return node.arguments.every(resourceExpression);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return resourceExpression(node.left) && ts.isArrayLiteralExpression(node.right) && node.right.elements.length === 0;
  }
  return false;
}
function lint(code: string): string[] {
  const file = ts.createSourceFile("worker.ts", code, ts.ScriptTarget.Latest, true);
  const problems: string[] = [];
  const report = (node: ts.Node, message: string) => problems.push(`${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${message}`);
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
      if (key && metadataKeys.has(key) && !resourceExpression(node.initializer)) report(node, `${key} must come from a resource or recorded upstream value`);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && /Error$/.test(node.expression.text)) {
      if (!node.arguments?.[0] || !resourceExpression(node.arguments[0]) || !["strings", "resources"].includes(rootName(node.arguments[0]) ?? "")) {
        report(node, "authored errors must come from strings.json");
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      if (["sendUserMessage", "sendMessage"].includes(name)) report(node, "new message injection requires an explicit reviewed lint contract");
      if (name === "registerTool") {
        const argument = node.arguments[0];
        if (!argument || (!ts.isObjectLiteralExpression(argument) && (!ts.isIdentifier(argument) || argument.text !== "tool"))) {
          report(node, "opaque tool registration bypasses the reviewed tool loader");
        }
      }
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
        /[A-Za-z]/.test(node.text) && /\s/.test(node.text)) {
      report(node, "inline prose belongs in agent-context");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return problems;
}
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "test"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("all runtime TypeScript keeps registration metadata, schemas, and authored messages in resources", () => {
  const root = new URL("../", import.meta.url).pathname;
  const problems = sources(root).flatMap((path) => lint(readFileSync(path, "utf8")).map((message) => `${path}:${message}`));
  assert.deepEqual(problems, []);
});

test("lint rejects direct metadata, schema descriptions, constants, opaque factories, and inline errors", () => {
  for (const source of [
    'pi.registerTool({ description: "inline" });',
    'const schema = { properties: { path: { description: "inline" } } };',
    'const BAD = "inline"; pi.registerTool({ description: BAD });',
    'pi.registerFlag("x", { description: "inline" });',
    'const x = { promptSnippet: "inline", promptGuidelines: ["inline"] };',
    'const x = { parameters: {} };',
    'const x = { type: "text", text: "inline" };',
    'const x = { block: true, reason: "inline" };',
    'throw new Error("inline");',
    'const indirect = "inline prose";',
    'pi.registerTool(makeTool());',
    'pi.sendUserMessage(strings.someMessage);',
  ]) assert.ok(lint(source).length, source);
  assert.deepEqual(lint('pi.registerFlag("x", { description: resources.strings.flags.context }); throw new Error(strings.errors.audit_failed);'), []);
});
