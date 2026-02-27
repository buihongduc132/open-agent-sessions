import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Config } from "./types";
import { validateConfig } from "./validate";

export function loadConfigFromFile(path: string): Config {
  if (!path || typeof path !== "string") {
    throw new Error("Config path must be a non-empty string");
  }

  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    throw new Error(`Config file not found or unreadable: ${path}`);
  }

  if (stat.isDirectory()) {
    throw new Error(`Config path is a directory: ${path}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Config path is not a file: ${path}`);
  }

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Config file unreadable: ${path}`);
  }

  return parseConfigText(contents, path);
}

export function parseConfigText(contents: string, sourcePath = "<config>"): Config {
  if (contents.trim().length === 0) {
    return { agents: [] };
  }

  let data: unknown;
  try {
    data = parseYamlWithPython(contents, sourcePath);
  } catch (error) {
    throw new Error(formatYamlError(error, sourcePath));
  }

  if (data === null) {
    return { agents: [] };
  }

  return validateConfig(data);
}

function parseYamlWithPython(contents: string, sourcePath: string): unknown {
  const script = String.raw`import sys
import json
import yaml
from yaml.loader import SafeLoader

class UniqueKeyLoader(SafeLoader):
    pass

def construct_mapping(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"duplicate key: {key}",
                key_node.start_mark,
            )
        value = loader.construct_object(value_node, deep=deep)
        mapping[key] = value
    return mapping

UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    construct_mapping,
)

text = sys.stdin.read()
try:
    data = yaml.load(text, Loader=UniqueKeyLoader)
    json.dump({"ok": True, "data": data}, sys.stdout)
except yaml.YAMLError as e:
    mark = getattr(e, "problem_mark", None)
    line = getattr(mark, "line", None)
    column = getattr(mark, "column", None)
    msg = str(e)
    json.dump({"ok": False, "message": msg, "line": line, "column": column}, sys.stdout)
`;

  const result = spawnSync("python3", ["-c", script], {
    input: contents,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`YAML parse error in ${sourcePath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    throw new Error(
      stderr ? `YAML parse error in ${sourcePath}: ${stderr}` : `YAML parse error in ${sourcePath}`
    );
  }

  let payload: { ok: boolean; data?: unknown; message?: string; line?: number | null; column?: number | null };
  try {
    payload = JSON.parse(result.stdout || "{}") as {
      ok: boolean;
      data?: unknown;
      message?: string;
      line?: number | null;
      column?: number | null;
    };
  } catch (error) {
    throw new Error(`YAML parse error in ${sourcePath}: unable to parse parser output`);
  }

  if (!payload.ok) {
    const err = new Error(payload.message ?? "YAML parse error");
    (err as any).line = payload.line ?? undefined;
    (err as any).column = payload.column ?? undefined;
    throw err;
  }

  return payload.data ?? null;
}

function formatYamlError(error: unknown, sourcePath: string): string {
  if (!error || typeof error !== "object") {
    return `YAML parse error in ${sourcePath}`;
  }

  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : String(error);
  const line = typeof record.line === "number" ? (record.line as number) + 1 : undefined;
  const column = typeof record.column === "number" ? (record.column as number) + 1 : undefined;

  if (line !== undefined && column !== undefined) {
    return `YAML parse error in ${sourcePath} at line ${line}, column ${column}: ${message}`;
  }

  return `YAML parse error in ${sourcePath}: ${message}`;
}
