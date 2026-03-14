// ============================================================
// JavaScriptParser — unit tests
//
// Run with: bun test  (or: npx vitest)
// No mocking needed — tree-sitter is fast enough to run real
// ============================================================

import { describe, it, expect } from "vitest";
import { JavaScriptParser } from "../src/parsers/javascript.parser.js";

const parser = new JavaScriptParser();
const FILE = "/fake/src/app.js";

function parse(source: string) {
  return parser.parse(FILE, source.trim());
}

// ── Import extraction ────────────────────────────────────────

describe("imports", () => {
  it("extracts named ESM imports", () => {
    const r = parse(`import { useState, useEffect } from "react"`);
    expect(r.imports).toHaveLength(1);
    expect(r.imports[0]).toMatchObject({
      toModule: "react",
      kind: "static",
      symbols: ["useState", "useEffect"],
    });
  });

  it("extracts default import", () => {
    const r = parse(`import React from "react"`);
    expect(r.imports[0].symbols).toContain("React");
  });

  it("extracts namespace import", () => {
    const r = parse(`import * as utils from "./utils"`);
    expect(r.imports[0].symbols).toContain("*");
    expect(r.imports[0].toModule).toBe("./utils");
  });

  it("marks side-effect imports", () => {
    const r = parse(`import "./styles.css"`);
    expect(r.imports[0].kind).toBe("side-effect");
    expect(r.imports[0].symbols).toHaveLength(0);
  });

  it("extracts require()", () => {
    const r = parse(`const path = require("node:path")`);
    expect(r.imports[0].kind).toBe("require");
    expect(r.imports[0].toModule).toBe("node:path");
  });

  it("extracts dynamic import()", () => {
    const r = parse(`const mod = await import("./heavy-module")`);
    expect(r.imports[0].kind).toBe("dynamic");
    expect(r.imports[0].toModule).toBe("./heavy-module");
  });

  it("handles multiple imports in one file", () => {
    const r = parse(`
      import React from "react"
      import { db } from "./db"
      const fs = require("fs")
    `);
    expect(r.imports).toHaveLength(3);
  });
});

// ── Function extraction ──────────────────────────────────────

describe("functions", () => {
  it("extracts named function declaration", () => {
    const r = parse(`function greet(name, age) { return name }`);
    expect(r.functions).toHaveLength(1);
    expect(r.functions[0]).toMatchObject({
      name: "greet",
      params: ["name", "age"],
      isAsync: false,
      isExported: false,
    });
  });

  it("extracts async arrow function", () => {
    const r = parse(`const fetchData = async (url) => { return fetch(url) }`);
    expect(r.functions[0]).toMatchObject({
      name: "fetchData",
      isAsync: true,
      params: ["url"],
    });
  });

  it("marks exported functions", () => {
    const r = parse(`export function add(a, b) { return a + b }`);
    expect(r.functions[0].isExported).toBe(true);
  });

  it("captures function calls", () => {
    const r = parse(`
      function processUser(id) {
        validateId(id)
        const user = db.findUser(id)
        return formatUser(user)
      }
    `);
    const calls = r.functions[0].calls;
    expect(calls).toContain("validateId");
    expect(calls).toContain("formatUser");
    expect(calls).toContain("db.findUser");
  });

  it("calculates LOC correctly", () => {
    const r = parse(`
function multiLine(a, b) {
  const x = a + b
  const y = x * 2
  return y
}
    `);
    expect(r.functions[0].loc).toBe(5);
  });
});

// ── Complexity ───────────────────────────────────────────────

describe("cyclomatic complexity", () => {
  it("scores simple function as 1", () => {
    const r = parse(`function simple(x) { return x * 2 }`);
    expect(r.functions[0].complexity).toBe(1);
  });

  it("adds 1 per if branch", () => {
    const r = parse(`
      function check(x) {
        if (x > 0) {
          if (x > 10) return "big"
          return "small"
        }
        return "negative"
      }
    `);
    // base 1 + 2 if statements = 3
    expect(r.functions[0].complexity).toBe(3);
  });

  it("counts logical operators", () => {
    const r = parse(`
      function validate(x, y, z) {
        return x > 0 && y > 0 && z > 0
      }
    `);
    // base 1 + 2 && operators = 3
    expect(r.functions[0].complexity).toBe(3);
  });
});

// ── Class extraction ─────────────────────────────────────────

describe("classes", () => {
  it("extracts class with superclass", () => {
    const r = parse(`
      class Animal {}
      class Dog extends Animal {
        bark() { return "woof" }
      }
    `);
    expect(r.classes).toHaveLength(2);
    const dog = r.classes.find((c) => c.name === "Dog")!;
    expect(dog.superClass).toBe("Animal");
    expect(dog.methods).toHaveLength(1);
    expect(dog.methods[0].name).toBe("bark");
  });

  it("marks exported classes", () => {
    const r = parse(`export class Service { run() {} }`);
    expect(r.classes[0].isExported).toBe(true);
  });
});

// ── Export extraction ────────────────────────────────────────

describe("exports", () => {
  it("extracts named exports", () => {
    const r = parse(`export { foo, bar }`);
    expect(r.exports).toContain("foo");
    expect(r.exports).toContain("bar");
  });

  it("extracts default export", () => {
    const r = parse(`export default function App() {}`);
    expect(r.exports).toContain("default");
  });
});

// ── Parse errors ─────────────────────────────────────────────

describe("error handling", () => {
  it("reports parse errors but still returns partial result", () => {
    const r = parse(`
      function good() { return 1 }
      function broken( { // syntax error
    `);
    expect(r.parseErrors.length).toBeGreaterThan(0);
    expect(r.functions.length).toBeGreaterThan(0); // partial extraction
  });

  it("records file LOC correctly", () => {
    const source = "const a = 1\nconst b = 2\nconst c = 3";
    const r = parse(source);
    expect(r.loc).toBe(3);
  });
});
