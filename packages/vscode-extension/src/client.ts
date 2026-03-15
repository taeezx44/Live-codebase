// ============================================================
// client.ts  —  HTTP client for the CodeVis API
//
// Wraps all API calls made from the extension.
// Uses the built-in Node https module (no external deps needed
// beyond axios which VS Code bundles).
// ============================================================

import axios, { type AxiosInstance } from "axios";

export interface FileNode {
  id:          string;
  language:    string;
  loc:         number;
  complexity:  number;
  exportCount: number;
}

export interface FileEdge {
  source:  string;
  target:  string;
  kind:    string;
  symbols: string[];
}

export interface GraphData {
  repoId: string;
  nodes:  FileNode[];
  edges:  FileEdge[];
}

export interface ImpactData {
  path:          string;
  affectedFiles: Array<{ path: string; depth: number }>;
  depth:         number;
}

export interface FileStats {
  path:       string;
  language:   string;
  loc:        number;
  complexity: number;
  fanIn:      number;
  fanOut:     number;
}

export class CodeVisClient {
  private http: AxiosInstance;

  constructor(baseUrl: string) {
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 10_000,
    });
  }

  setBaseUrl(url: string): void {
    this.http.defaults.baseURL = url;
  }

  /** Returns true if the API is reachable */
  async health(): Promise<boolean> {
    try {
      await this.http.get("/health");
      return true;
    } catch {
      return false;
    }
  }

  /** Fetch the full dependency graph for a repo */
  async getGraph(repoId: string): Promise<GraphData | null> {
    try {
      const res = await this.http.get<GraphData>(
        `/api/repos/${repoId}/graph`
      );
      return res.data;
    } catch {
      return null;
    }
  }

  /** Run impact analysis for a file path */
  async getImpact(repoId: string, filePath: string, depth = 3): Promise<ImpactData | null> {
    try {
      const res = await this.http.get<ImpactData>(
        `/api/repos/${repoId}/impact`,
        { params: { path: filePath, depth } }
      );
      return res.data;
    } catch {
      return null;
    }
  }

  /** Get stats for a specific file */
  async getFileStats(repoId: string, filePath: string): Promise<FileStats | null> {
    try {
      const res = await this.http.get<FileStats>(
        `/api/repos/${repoId}/files/stats`,
        { params: { path: filePath } }
      );
      return res.data;
    } catch {
      return null;
    }
  }

  /** List all analyzed repos */
  async listRepos(): Promise<Array<{ repoId: string; url: string; status: string }>> {
    try {
      const res = await this.http.get("/api/repos");
      return res.data?.repos ?? [];
    } catch {
      return [];
    }
  }
}
