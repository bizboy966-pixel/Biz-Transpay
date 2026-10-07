"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const frontendRequire = createRequire(require("node:path").resolve(__dirname, "../frontend/package.json"));
const braces = frontendRequire("braces");
const micromatch = frontendRequire("micromatch");

test("all string parsing APIs reject deep brace, parenthesis and mixed ASTs", () => {
  const patterns = [
    "{".repeat(2000) + "a,b" + "}".repeat(2000),
    "(".repeat(2000) + "x" + ")".repeat(2000),
    "{(".repeat(2000) + "a,b" + ")}".repeat(2000),
    "{".repeat(2000),
    "(".repeat(2000),
  ];
  const operations = [braces, braces.create, braces.parse, braces.compile, braces.expand, braces.stringify];
  for (const operation of operations) {
    for (const pattern of patterns) {
      assert.throws(() => operation(pattern), {
        name: "SyntaxError",
        message: /nesting exceeds the security limit/,
      });
    }
  }
  assert.throws(() => braces(["{a,b}", patterns[0]]), /nesting exceeds/);
  // Caller options must not disable the hard security bound.
  assert.throws(() => braces.parse(patterns[0], { maxDepth: Infinity }), /nesting exceeds/);
});

test("normal glob compilation, expansion and matching preserve their behavior", () => {
  assert.deepEqual(braces.expand("src/{components,pages}/*.{js,jsx}"), [
    "src/components/*.js", "src/components/*.jsx", "src/pages/*.js", "src/pages/*.jsx",
  ]);
  assert.deepEqual(braces.expand("item-{01..03}"), ["item-01", "item-02", "item-03"]);
  assert.equal(braces.compile("a/{b,c}/d"), "a/(b|c)/d");
  assert.deepEqual(braces.expand("a/{b,{c,d}}/e"), ["a/b/e", "a/c/e", "a/d/e"]);
  assert.deepEqual(micromatch(["src/a.js", "src/b.jsx", "src/c.css"], "src/*.{js,jsx}"), [
    "src/a.js", "src/b.jsx",
  ]);
  assert.deepEqual(micromatch.braceExpand("src/{components,pages}/*.js"), [
    "src/components/*.js", "src/pages/*.js",
  ]);
  assert.equal(braces.stringify(braces.parse("{a,b}")), "{a,b}");
});

test("the depth boundary is enforced but literals do not consume AST nesting", () => {
  assert.doesNotThrow(() => braces.compile("(".repeat(64) + "x" + ")".repeat(64)));
  assert.throws(() => braces.compile("(".repeat(65) + "x" + ")".repeat(65)), /nesting exceeds/);
  assert.doesNotThrow(() => braces.parse("\\{".repeat(1000)));
  assert.doesNotThrow(() => braces.parse('"' + "{".repeat(1000) + '"'));
  assert.doesNotThrow(() => braces.parse("[" + "{".repeat(1000) + "]"));
});

test("updated legacy CLI parser retains the API used by older YAML tooling", () => {
  const { ArgumentParser } = frontendRequire("argparse");
  const parser = new ArgumentParser({ addHelp: false });
  parser.addArgument(["--output"], { defaultValue: "stdout" });
  assert.equal(parser.parseArgs(["--output", "file"]).output, "file");
  assert.equal(frontendRequire("js-yaml").load("payment:\n  amount: 100").payment.amount, 100);
});
