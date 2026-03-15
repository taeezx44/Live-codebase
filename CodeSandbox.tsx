"use client";

// ============================================================
// CodeSandbox.tsx
//
// Browser-based code runner. Select language → write code →
// click Run → output streams back from the Docker sandbox.
//
// UX:
//   - Language selector (JS / TS / Python)
//   - Code editor (Monaco via CDN, falls back to <textarea>)
//   - Stdin input (optional test case)
//   - Run button with loading state
//   - Output panel: stdout (green), stderr (red), exit code, timing
//   - Timeout indicator
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";

type Language = "javascript" | "typescript" | "python";

interface RunResult {
  stdout:     string;
  stderr:     string;
  exitCode:   number;
  durationMs: number;
  timedOut:   boolean;
  error?:     string;
}

// ── Default starter code per language ────────────────────────

const STARTERS: Record<Language, string> = {
  javascript: `// JavaScript — Node 20
function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

console.log("Fibonacci sequence:");
for (let i = 0; i <= 10; i++) {
  console.log(\`fib(\${i}) = \${fibonacci(i)}\`);
}
`,
  typescript: `// TypeScript — Node 20 + tsx
function greet(name: string): string {
  return \`Hello, \${name}! The time is \${new Date().toISOString()}\`;
}

const names = ["Alice", "Bob", "Carol"];
names.forEach(name => console.log(greet(name)));
`,
  python: `# Python 3.12
def is_prime(n: int) -> bool:
    if n < 2:
        return False
    return all(n % i != 0 for i in range(2, int(n**0.5) + 1))

primes = [n for n in range(2, 50) if is_prime(n)]
print(f"Primes under 50: {primes}")
print(f"Count: {len(primes)}")
`,
};

const LANG_LABELS: Record<Language, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python:     "Python",
};

const LANG_COLORS: Record<Language, string> = {
  javascript: "#f59e0b",
  typescript: "#3b82f6",
  python:     "#10b981",
};

// ── Output line component ─────────────────────────────────────

function OutputLine({ text, type }: { text: string; type: "stdout" | "stderr" | "info" }) {
  const color = type === "stderr" ? "#f85149" : type === "info" ? "#8b949e" : "#3fb950";
  return (
    <div style={{
      fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
      fontSize: 12,
      color,
      padding: "1px 0",
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
    }}>
      {text}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────

interface CodeSandboxProps {
  apiBase?: string;
  initialCode?: string;
  initialLanguage?: Language;
  filename?: string;    // when opened from a graph node
}

export function CodeSandbox({
  apiBase = "",
  initialCode,
  initialLanguage = "javascript",
  filename,
}: CodeSandboxProps) {
  const [lang, setLang]         = useState<Language>(initialLanguage);
  const [code, setCode]         = useState(initialCode ?? STARTERS[initialLanguage]);
  const [stdin, setStdin]       = useState("");
  const [running, setRunning]   = useState(false);
  const [result, setResult]     = useState<RunResult | null>(null);
  const [showStdin, setShowStdin] = useState(false);
  const textareaRef             = useRef<HTMLTextAreaElement>(null);

  // Update starter code when language changes (only if using starter)
  useEffect(() => {
    if (!initialCode) setCode(STARTERS[lang]);
  }, [lang, initialCode]);

  const run = useCallback(async () => {
    setRunning(true);
    setResult(null);

    try {
      const res = await fetch(`${apiBase}/api/sandbox/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: lang, code, stdin: stdin || undefined }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as RunResult;
      setResult(data);
    } catch (err) {
      setResult({
        stdout: "",
        stderr: "",
        exitCode: -1,
        durationMs: 0,
        timedOut: false,
        error: (err as Error).message,
      });
    } finally {
      setRunning(false);
    }
  }, [apiBase, lang, code, stdin]);

  // Cmd/Ctrl+Enter to run
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [run]);

  const langColor = LANG_COLORS[lang];

  return (
    <div style={{
      background: "#0d1117",
      color: "#e6edf3",
      fontFamily: "var(--font-sans, system-ui, sans-serif)",
      borderRadius: 12,
      overflow: "hidden",
      border: "1px solid #21262d",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* Header bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        background: "#161b22",
        borderBottom: "1px solid #21262d",
      }}>
        {filename && (
          <span style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 12,
            color: langColor,
            fontWeight: 600,
          }}>
            {filename}
          </span>
        )}

        {/* Language selector */}
        <div style={{ display: "flex", gap: 4 }}>
          {(Object.keys(LANG_LABELS) as Language[]).map(l => (
            <button
              key={l}
              onClick={() => setLang(l)}
              style={{
                padding: "3px 9px",
                borderRadius: 6,
                border: `1px solid ${l === lang ? LANG_COLORS[l] : "#30363d"}`,
                background: l === lang ? `${LANG_COLORS[l]}22` : "transparent",
                color: l === lang ? LANG_COLORS[l] : "#8b949e",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 500,
                transition: "all .15s",
              }}
            >
              {LANG_LABELS[l]}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <button
          onClick={() => setShowStdin(s => !s)}
          style={{
            padding: "4px 9px",
            borderRadius: 6,
            border: "1px solid #30363d",
            background: "transparent",
            color: "#8b949e",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          {showStdin ? "Hide stdin" : "Add stdin"}
        </button>

        <button
          onClick={run}
          disabled={running}
          style={{
            padding: "5px 14px",
            borderRadius: 6,
            border: "none",
            background: running ? "#21262d" : "#238636",
            color: running ? "#8b949e" : "#fff",
            cursor: running ? "not-allowed" : "pointer",
            fontSize: 12,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 6,
            transition: "all .15s",
          }}
        >
          {running ? (
            <>
              <span style={{ display: "inline-block", animation: "spin .7s linear infinite" }}>◌</span>
              Running…
            </>
          ) : (
            "▶  Run"
          )}
        </button>
      </div>

      {/* Stdin input (collapsible) */}
      {showStdin && (
        <div style={{ padding: "8px 14px", background: "#0d1117", borderBottom: "1px solid #21262d" }}>
          <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>stdin (test case input)</div>
          <textarea
            value={stdin}
            onChange={e => setStdin(e.target.value)}
            placeholder="Enter input here…"
            rows={3}
            style={{
              width: "100%",
              background: "#161b22",
              border: "1px solid #30363d",
              borderRadius: 5,
              color: "#e6edf3",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 12,
              padding: "6px 8px",
              resize: "vertical",
              outline: "none",
            }}
          />
        </div>
      )}

      {/* Code editor */}
      <div style={{ position: "relative" }}>
        <textarea
          ref={textareaRef}
          value={code}
          onChange={e => setCode(e.target.value)}
          spellCheck={false}
          rows={14}
          style={{
            width: "100%",
            background: "#0d1117",
            border: "none",
            color: "#e6edf3",
            fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
            fontSize: 13,
            lineHeight: 1.7,
            padding: "14px 16px",
            resize: "none",
            outline: "none",
            tabSize: 2,
          }}
          onKeyDown={e => {
            // Tab → insert 2 spaces
            if (e.key === "Tab") {
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart;
              const end   = el.selectionEnd;
              const next  = code.slice(0, start) + "  " + code.slice(end);
              setCode(next);
              requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = start + 2;
              });
            }
          }}
        />
        <div style={{
          position: "absolute",
          bottom: 8,
          right: 12,
          fontSize: 10,
          color: "#6e7681",
        }}>
          ⌘↵ to run
        </div>
      </div>

      {/* Output panel */}
      <div style={{
        background: "#010409",
        borderTop: "1px solid #21262d",
        minHeight: 120,
        maxHeight: 300,
        overflowY: "auto",
        padding: "10px 14px",
      }}>
        {!result && !running && (
          <OutputLine type="info" text="// Output will appear here after you click Run" />
        )}

        {running && (
          <OutputLine type="info" text="// Executing in sandbox…" />
        )}

        {result && (
          <>
            {/* Header line */}
            <OutputLine
              type="info"
              text={`// Exited ${result.exitCode === 0 ? "✓" : "✗"} in ${result.durationMs}ms${result.timedOut ? " [TIMEOUT]" : ""}`}
            />

            {result.error && (
              <OutputLine type="stderr" text={`Executor error: ${result.error}`} />
            )}

            {result.timedOut && (
              <OutputLine type="stderr" text="Execution timed out (10s limit)" />
            )}

            {result.stdout && result.stdout.split("\n").map((line, i) => (
              <OutputLine key={`out-${i}`} type="stdout" text={line} />
            ))}

            {result.stderr && (
              <>
                <OutputLine type="info" text="--- stderr ---" />
                {result.stderr.split("\n").map((line, i) => (
                  <OutputLine key={`err-${i}`} type="stderr" text={line} />
                ))}
              </>
            )}
          </>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
