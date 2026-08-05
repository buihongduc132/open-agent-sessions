/**
 * Shared filesystem utilities for adapter implementations.
 *
 * DRY consolidation of path resolution, directory walking, JSONL collection,
 * file content search, and ISO timestamp comparison — previously duplicated
 * between claude.ts and codex.ts.
 */
import { statSync } from "node:fs";
export declare function resolvePath(pathValue: string, baseDir?: string): string;
export declare function expandTilde(pathValue: string): string;
export declare function safeStat(pathValue: string): ReturnType<typeof statSync> | null;
export declare function collectJsonlFiles(rootPath: string): string[];
export declare function walkDir(dir: string, files: string[]): void;
export declare function splitJsonlLines(content: string): string[];
export declare function contentContains(filePath: string, needle: string): boolean;
export declare function listJsonFiles(dir: string): string[];
export declare function containsIgnoreCase(text: string, needle: string): boolean;
export declare function minIso(a: string, b: string): string;
export declare function maxIso(a: string, b: string): string;
export declare function sortByIsoDesc<T>(arr: T[], key: keyof T): T[];
export declare function readTextFile(path: string): string | null;
