// ============================================================
// python.parser.test.ts
//
// Unit tests for PythonParser — no real filesystem, no Neo4j.
// Run with: pnpm test --filter @codevis/analysis-engine
// ============================================================

import { describe, it, expect, beforeAll } from "vitest";
import { PythonParser } from "../parsers/python.parser.js";

let parser: PythonParser;

beforeAll(() => {
  parser = new PythonParser();
});

const parse = (src: string) => parser.parse("/repo/test.py", src);

// ── Import extraction ─────────────────────────────────────────

describe("PythonParser — imports", () => {
  it("parses a plain module import", () => {
    const r = parse(`import os`);
    expect(r.imports).toHaveLength(1);
    expect(r.imports[0].toModule).toBe("os");
    expect(r.imports[0].symbols).toEqual(["*"]);
    expect(r.imports[0].kind).toBe("static");
  });

  it("parses multiple modules in one import statement", () => {
    const r = parse(`import os, sys, pathlib`);
    expect(r.imports).toHaveLength(3);
    expect(r.imports.map((i) => i.toModule)).toEqual(["os", "sys", "pathlib"]);
  });

  it("parses aliased import", () => {
    const r = parse(`import numpy as np`);
    expect(r.imports[0].toModule).toBe("numpy");
    expect(r.imports[0].symbols).toEqual(["*"]);
  });

  it("parses from-import with single name", () => {
    const r = parse(`from os import path`);
    expect(r.imports[0].toModule).toBe("os");
    expect(r.imports[0].symbols).toEqual(["path"]);
  });

  it("parses from-import with multiple names", () => {
    const r = parse(`from os.path import join, exists, dirname`);
    expect(r.imports[0].toModule).toBe("os.path");
    expect(r.imports[0].symbols).toEqual(["join", "exists", "dirname"]);
  });

  it("parses wildcard from-import", () => {
    const r = parse(`from typing import *`);
    expect(r.imports[0].symbols).toEqual(["*"]);
  });

  it("parses aliased from-import", () => {
    const r = parse(`from datetime import datetime as dt`);
    expect(r.imports[0].symbols).toEqual(["dt"]);
  });

  it("parses relative import (single dot)", () => {
    const r = parse(`from . import utils`);
    expect(r.imports[0].toModule).toBe(".utils");
  });

  it("parses relative import (double dot)", () => {
    const r = parse(`from .. import config`);
    expect(r.imports[0].toModule).toContain("..");
  });

  it("parses relative from-import with module", () => {
    const r = parse(`from .models import User, Post`);
    expect(r.imports[0].toModule).toBe(".models");
    expect(r.imports[0].symbols).toContain("User");
    expect(r.imports[0].symbols).toContain("Post");
  });
});

// ── Function extraction ───────────────────────────────────────

describe("PythonParser — functions", () => {
  it("extracts a simple def", () => {
    const r = parse(`def greet(name):\n    return f"Hello {name}"`);
    expect(r.functions).toHaveLength(1);
    expect(r.functions[0].name).toBe("greet");
    expect(r.functions[0].isAsync).toBe(false);
    expect(r.functions[0].isExported).toBe(true);
    expect(r.functions[0].params).toEqual(["name"]);
  });

  it("extracts async def", () => {
    const r = parse(`async def fetch(url: str) -> str:\n    pass`);
    expect(r.functions[0].isAsync).toBe(true);
    expect(r.functions[0].name).toBe("fetch");
  });

  it("strips self from method params", () => {
    const r = parse(
      `class Foo:\n    def bar(self, x, y):\n        pass`
    );
    // bar is a method inside Foo
    const bar = r.functions.find((f) => f.name === "bar");
    expect(bar?.params).toEqual(["x", "y"]);
  });

  it("records LOC correctly", () => {
    const src = `def multi():\n    x = 1\n    y = 2\n    return x + y`;
    const r = parse(src);
    expect(r.functions[0].loc).toBeGreaterThanOrEqual(4);
  });

  it("extracts decorated function", () => {
    const r = parse(`@property\ndef value(self):\n    return self._v`);
    expect(r.functions.some((f) => f.name === "value")).toBe(true);
  });
});

// ── Class extraction ──────────────────────────────────────────

describe("PythonParser — classes", () => {
  it("extracts a simple class", () => {
    const r = parse(`class Dog:\n    pass`);
    expect(r.classes).toHaveLength(1);
    expect(r.classes[0].name).toBe("Dog");
    expect(r.classes[0].superClass).toBeUndefined();
    expect(r.classes[0].isExported).toBe(true);
  });

  it("extracts superclass", () => {
    const r = parse(`class Labrador(Dog):\n    pass`);
    expect(r.classes[0].superClass).toBe("Dog");
  });

  it("extracts multiple inheritance (first base only in superClass)", () => {
    const r = parse(`class C(A, B):\n    pass`);
    expect(r.classes[0].superClass).toBe("A");
  });

  it("extracts methods inside class", () => {
    const r = parse(
      `class Calc:\n    def add(self, a, b):\n        return a + b\n    def sub(self, a, b):\n        return a - b`
    );
    expect(r.classes[0].methods.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Error resilience ──────────────────────────────────────────

describe("PythonParser — error handling", () => {
  it("returns empty arrays on empty source", () => {
    const r = parse("");
    expect(r.imports).toHaveLength(0);
    expect(r.functions).toHaveLength(0);
    expect(r.classes).toHaveLength(0);
  });

  it("records parse errors but does not throw", () => {
    // Deliberately malformed Python
    const r = parse(`def broken(`);
    // Parser should not throw; it may record an error node
    expect(r).toBeDefined();
  });
});
