// ============================================================
// go.parser.test.ts
//
// Unit tests for GoParser — no real filesystem, no Neo4j.
// Run with: pnpm test --filter @codevis/analysis-engine
// ============================================================

import { describe, it, expect, beforeAll } from "vitest";
import { GoParser } from "../parsers/go.parser.js";

let parser: GoParser;

beforeAll(() => {
  parser = new GoParser();
});

const parse = (src: string) => parser.parse("/repo/main.go", src);

// ── Import extraction ─────────────────────────────────────────

describe("GoParser — imports", () => {
  it("parses a single quoted import", () => {
    const r = parse(`package main\nimport "fmt"`);
    expect(r.imports).toHaveLength(1);
    expect(r.imports[0].toModule).toBe("fmt");
    expect(r.imports[0].kind).toBe("static");
    expect(r.imports[0].symbols).toEqual(["*"]);
  });

  it("parses grouped import block", () => {
    const src = `package main\nimport (\n  "fmt"\n  "os"\n  "net/http"\n)`;
    const r = parse(src);
    expect(r.imports).toHaveLength(3);
    const modules = r.imports.map((i) => i.toModule);
    expect(modules).toContain("fmt");
    expect(modules).toContain("os");
    expect(modules).toContain("net/http");
  });

  it("parses aliased import", () => {
    const r = parse(`package main\nimport myhttp "net/http"`);
    expect(r.imports[0].toModule).toBe("net/http");
    expect(r.imports[0].symbols).toEqual(["myhttp"]);
  });

  it("parses blank identifier import (side-effect)", () => {
    const r = parse(`package main\nimport _ "net/http/pprof"`);
    expect(r.imports[0].kind).toBe("side-effect");
    expect(r.imports[0].toModule).toBe("net/http/pprof");
  });

  it("parses dot import", () => {
    const r = parse(`package main\nimport . "fmt"`);
    expect(r.imports[0].symbols).toEqual(["*"]);
  });

  it("strips quotes from module path", () => {
    const r = parse(`package main\nimport "github.com/user/repo"`);
    expect(r.imports[0].toModule).toBe("github.com/user/repo");
    expect(r.imports[0].toModule).not.toContain('"');
  });

  it("parses mixed grouped imports with aliases and blanks", () => {
    const src = `package main\nimport (\n  "fmt"\n  log "log/slog"\n  _ "embed"\n)`;
    const r = parse(src);
    expect(r.imports).toHaveLength(3);
    const kinds = r.imports.map((i) => i.kind);
    expect(kinds).toContain("side-effect");
  });
});

// ── Function extraction ───────────────────────────────────────

describe("GoParser — functions", () => {
  it("extracts a top-level func declaration", () => {
    const r = parse(`package main\nfunc Hello() string {\n  return "hi"\n}`);
    expect(r.functions).toHaveLength(1);
    expect(r.functions[0].name).toBe("Hello");
    expect(r.functions[0].isAsync).toBe(false);
    expect(r.functions[0].isExported).toBe(true);
  });

  it("marks unexported functions correctly", () => {
    const r = parse(`package main\nfunc helper() {}`);
    expect(r.functions[0].isExported).toBe(false);
  });

  it("extracts method with receiver", () => {
    const r = parse(`package main\nfunc (s *Server) Start() error {\n  return nil\n}`);
    expect(r.functions[0].name).toContain("Start");
    expect(r.functions[0].isExported).toBe(true);
  });

  it("extracts function parameters", () => {
    const r = parse(`package main\nfunc Add(a int, b int) int {\n  return a + b\n}`);
    expect(r.functions[0].params).toContain("a");
    expect(r.functions[0].params).toContain("b");
  });

  it("extracts variadic parameter", () => {
    const r = parse(`package main\nfunc Sum(nums ...int) int {\n  return 0\n}`);
    expect(r.functions[0].params.length).toBeGreaterThan(0);
  });

  it("records positive LOC", () => {
    const src = `package main\nfunc Long() {\n  a := 1\n  b := 2\n  c := a + b\n  _ = c\n}`;
    const r = parse(src);
    expect(r.functions[0].loc).toBeGreaterThanOrEqual(5);
  });
});

// ── Type extraction (struct + interface) ─────────────────────

describe("GoParser — types (classes)", () => {
  it("extracts a struct type as ClassNode", () => {
    const r = parse(`package main\ntype Server struct {\n  port int\n}`);
    expect(r.classes).toHaveLength(1);
    expect(r.classes[0].name).toBe("Server");
    expect(r.classes[0].isExported).toBe(true);
  });

  it("marks unexported struct as not exported", () => {
    const r = parse(`package main\ntype config struct {\n  debug bool\n}`);
    expect(r.classes[0].isExported).toBe(false);
  });

  it("extracts an interface type as ClassNode", () => {
    const r = parse(`package main\ntype Writer interface {\n  Write(p []byte) (n int, err error)\n}`);
    expect(r.classes).toHaveLength(1);
    expect(r.classes[0].name).toBe("Writer");
  });

  it("extracts multiple type declarations", () => {
    const src = `package main
type Foo struct {}
type Bar interface {}
type baz struct {}`;
    const r = parse(src);
    expect(r.classes.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Export detection ──────────────────────────────────────────

describe("GoParser — exports", () => {
  it("includes exported top-level func", () => {
    const r = parse(`package main\nfunc Public() {}\nfunc private() {}`);
    expect(r.exports).toContain("Public");
    expect(r.exports).not.toContain("private");
  });
});

// ── Error resilience ──────────────────────────────────────────

describe("GoParser — error handling", () => {
  it("returns empty arrays on empty source", () => {
    const r = parse("");
    expect(r.imports).toHaveLength(0);
    expect(r.functions).toHaveLength(0);
    expect(r.classes).toHaveLength(0);
  });

  it("does not throw on malformed Go", () => {
    const r = parse(`func broken(`);
    expect(r).toBeDefined();
  });
});
