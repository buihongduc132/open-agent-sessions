/**
 * RED tests for src/cmd-usage/classify.ts
 *
 * Shell command classifier: tokenize, split compound, strip prefixes,
 * build signatures, normalize args.
 */
import { describe, expect, test } from "bun:test";
import {
  tokenize,
  splitCompound,
  stripPrefix,
  stripEnvAssign,
  basename,
  buildSignature,
  normalizeArgs,
  classify,
} from "../../src/cmd-usage/classify";

// ── tokenize ──────────────────────────────────────────────────────────────

describe("tokenize", () => {
  test("simple command", () => {
    expect(tokenize("git fetch --all")).toEqual(["git", "fetch", "--all"]);
  });

  test("single word", () => {
    expect(tokenize("ls")).toEqual(["ls"]);
  });

  test("empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  test("whitespace only", () => {
    expect(tokenize("   ")).toEqual([]);
  });

  test("double-quoted arg with spaces", () => {
    const tokens = tokenize('echo "hello world"');
    expect(tokens).toEqual(["echo", "hello world"]);
  });

  test("single-quoted arg with spaces", () => {
    const tokens = tokenize("echo 'hello world'");
    expect(tokens).toEqual(["echo", "hello world"]);
  });

  test("escaped space", () => {
    const tokens = tokenize("echo hello\\ world");
    expect(tokens).toEqual(["echo", "hello world"]);
  });

  test("multiple flags", () => {
    expect(tokenize("git diff --stat --name-only HEAD")).toEqual([
      "git", "diff", "--stat", "--name-only", "HEAD",
    ]);
  });

  test("command with pipe (kept as-is, splitCompound handles pipes)", () => {
    // tokenize just splits on whitespace; pipes are handled by splitCompound
    const tokens = tokenize("cat file.txt | grep foo");
    expect(tokens).toContain("cat");
    expect(tokens.length).toBeGreaterThan(1);
  });

  test("mixed quotes and flags", () => {
    const tokens = tokenize('npm test --reporter="dot" --ci');
    expect(tokens).toEqual(["npm", "test", "--reporter=dot", "--ci"]);
  });
});

// ── splitCompound ─────────────────────────────────────────────────────────

describe("splitCompound", () => {
  test("&& separator", () => {
    const segments = splitCompound("a && b");
    expect(segments).toEqual(["a ", " b"]);
  });

  test("|| separator", () => {
    const segments = splitCompound("a || b");
    expect(segments).toEqual(["a ", " b"]);
  });

  test("| pipe separator", () => {
    const segments = splitCompound("a | b");
    expect(segments).toEqual(["a ", " b"]);
  });

  test("; separator", () => {
    const segments = splitCompound("a ; b");
    expect(segments).toEqual(["a ", " b"]);
  });

  test("mixed separators", () => {
    const segments = splitCompound("a && b | c ; d");
    expect(segments.length).toBe(4);
  });

  test("single command (no separator)", () => {
    const segments = splitCompound("git fetch --all");
    expect(segments).toEqual(["git fetch --all"]);
  });

  test("empty string", () => {
    const segments = splitCompound("");
    expect(segments).toEqual([""]);
  });
});

// ── stripPrefix ───────────────────────────────────────────────────────────

describe("stripPrefix", () => {
  test("strips sudo", () => {
    expect(stripPrefix(["sudo", "git", "diff"])).toEqual(["git", "diff"]);
  });

  test("strips env", () => {
    expect(stripPrefix(["env", "FOO=bar", "npm", "test"])).toEqual(["FOO=bar", "npm", "test"]);
  });

  test("strips nohup", () => {
    expect(stripPrefix(["nohup", "./serve.sh"])).toEqual(["./serve.sh"]);
  });

  test("strips time", () => {
    expect(stripPrefix(["time", "npm", "test"])).toEqual(["npm", "test"]);
  });

  test("strips chained prefixes: sudo + env", () => {
    expect(stripPrefix(["sudo", "env", "FOO=bar", "git", "commit"])).toEqual([
      "FOO=bar", "git", "commit",
    ]);
  });

  test("no prefix to strip", () => {
    expect(stripPrefix(["git", "fetch"])).toEqual(["git", "fetch"]);
  });

  test("empty tokens", () => {
    expect(stripPrefix([])).toEqual([]);
  });

  test("only prefix (nothing after)", () => {
    expect(stripPrefix(["sudo"])).toEqual([]);
  });
});

// ── stripEnvAssign ────────────────────────────────────────────────────────

describe("stripEnvAssign", () => {
  test("single env assignment", () => {
    expect(stripEnvAssign(["FOO=bar", "git", "commit"])).toEqual(["git", "commit"]);
  });

  test("multiple env assignments", () => {
    expect(stripEnvAssign(["FOO=bar", "BAZ=qux", "npm", "test"])).toEqual(["npm", "test"]);
  });

  test("no env assignments", () => {
    expect(stripEnvAssign(["git", "fetch"])).toEqual(["git", "fetch"]);
  });

  test("env assignment with complex value", () => {
    expect(stripEnvAssign(["GIT_AUTHOR=John <john@example.com>", "git", "commit"])).toEqual([
      "git", "commit",
    ]);
  });

  test("empty tokens", () => {
    expect(stripEnvAssign([])).toEqual([]);
  });

  test("stops at first non-env token", () => {
    // "git" is not an env assignment, so stop
    expect(stripEnvAssign(["git", "FOO=bar"])).toEqual(["git", "FOO=bar"]);
  });
});

// ── basename ──────────────────────────────────────────────────────────────

describe("basename", () => {
  test("absolute path", () => {
    expect(basename("/usr/bin/git")).toBe("git");
  });

  test("relative path", () => {
    expect(basename("./scripts/build.sh")).toBe("build.sh");
  });

  test("tilde path", () => {
    expect(basename("~/bin/fd")).toBe("fd");
  });

  test("no path (just command)", () => {
    expect(basename("git")).toBe("git");
  });

  test("trailing slash", () => {
    expect(basename("/usr/bin/")).toBe("bin");
  });

  test("empty string", () => {
    expect(basename("")).toBe("");
  });
});

// ── buildSignature ────────────────────────────────────────────────────────

describe("buildSignature", () => {
  test("MULTI_VERB: git with sub", () => {
    const result = buildSignature(["git", "fetch", "--all"]);
    expect(result.sig).toBe("git.fetch");
    expect(result.base).toBe("git");
    expect(result.sub).toBe("fetch");
  });

  test("MULTI_VERB: npm with sub", () => {
    const result = buildSignature(["npm", "test", "--ci"]);
    expect(result.sig).toBe("npm.test");
    expect(result.base).toBe("npm");
    expect(result.sub).toBe("test");
  });

  test("MULTI_VERB: mise with sub", () => {
    const result = buildSignature(["mise", "run", "deploy-prod"]);
    expect(result.sig).toBe("mise.run");
    expect(result.base).toBe("mise");
    expect(result.sub).toBe("run");
  });

  test("MULTI_VERB: docker with sub", () => {
    const result = buildSignature(["docker", "ps", "-a"]);
    expect(result.sig).toBe("docker.ps");
    expect(result.base).toBe("docker");
    expect(result.sub).toBe("ps");
  });

  test("MULTI_VERB: kubectl with sub", () => {
    const result = buildSignature(["kubectl", "get", "pods", "-n", "kube-system"]);
    expect(result.sig).toBe("kubectl.get");
    expect(result.base).toBe("kubectl");
    expect(result.sub).toBe("get");
  });

  test("non-MULTI_VERB: ls (no sub)", () => {
    const result = buildSignature(["ls", "-la"]);
    expect(result.sig).toBe("ls");
    expect(result.base).toBe("ls");
    expect(result.sub).toBeUndefined();
  });

  test("non-MULTI_VERB: cat (no sub)", () => {
    const result = buildSignature(["cat", "file.txt"]);
    expect(result.sig).toBe("cat");
    expect(result.base).toBe("cat");
    expect(result.sub).toBeUndefined();
  });

  test("MULTI_VERB with no sub (just base)", () => {
    const result = buildSignature(["git"]);
    expect(result.sig).toBe("git");
    expect(result.base).toBe("git");
    expect(result.sub).toBeUndefined();
  });

  test("MULTI_VERB with flag as second token (no sub)", () => {
    // If second token starts with -, it's a flag, not a sub
    const result = buildSignature(["npm", "--version"]);
    expect(result.sig).toBe("npm");
    expect(result.base).toBe("npm");
    expect(result.sub).toBeUndefined();
  });

  test("MULTI_VERB with path as second token (no sub)", () => {
    // If second token starts with / or ., it's not a sub
    const result = buildSignature(["npm", "./package.json"]);
    expect(result.sig).toBe("npm");
    expect(result.base).toBe("npm");
    expect(result.sub).toBeUndefined();
  });

  test("empty tokens", () => {
    const result = buildSignature([]);
    expect(result.sig).toBe("");
    expect(result.base).toBe("");
    expect(result.sub).toBeUndefined();
  });
});

// ── normalizeArgs ─────────────────────────────────────────────────────────

describe("normalizeArgs", () => {
  test("separates flags from args", () => {
    const result = normalizeArgs(["git", "diff", "--stat", "HEAD", "--name-only"]);
    expect(result.flags).toContain("--stat");
    expect(result.flags).toContain("--name-only");
    expect(result.args).toContain("HEAD");
  });

  test("normalizes paths", () => {
    const result = normalizeArgs(["cat", "/home/user/file.txt"]);
    expect(result.args).toContain("<path>");
  });

  test("normalizes relative paths", () => {
    const result = normalizeArgs(["cat", "./src/index.ts"]);
    expect(result.args).toContain("<path>");
  });

  test("normalizes hex hashes (7+ chars)", () => {
    const result = normalizeArgs(["git", "show", "abc1234"]);
    expect(result.args).toContain("<hash>");
  });

  test("normalizes version strings", () => {
    const result = normalizeArgs(["node", "v18.17.0"]);
    expect(result.args).toContain("<ver>");
  });

  test("empty tokens", () => {
    const result = normalizeArgs([]);
    expect(result.flags).toEqual([]);
    expect(result.args).toEqual([]);
  });

  test("all flags, no args", () => {
    const result = normalizeArgs(["ls", "-la", "--color"]);
    expect(result.flags.length).toBe(2);
    expect(result.args.length).toBe(0);
  });
});

// ── classify (end-to-end) ────────────────────────────────────────────────

describe("classify", () => {
  test("simple git command", () => {
    const result = classify("git fetch --all");
    expect(result.sig).toBe("git.fetch");
    expect(result.base).toBe("git");
    expect(result.sub).toBe("fetch");
    expect(result.raw).toBe("git fetch --all");
  });

  test("sudo prefix stripped", () => {
    const result = classify("sudo npm test --ci");
    expect(result.sig).toBe("npm.test");
    expect(result.base).toBe("npm");
    expect(result.sub).toBe("test");
  });

  test("env prefix stripped", () => {
    const result = classify("env FOO=bar mise run deploy-prod");
    expect(result.sig).toBe("mise.run");
    expect(result.base).toBe("mise");
    expect(result.sub).toBe("run");
  });

  test("absolute path basename", () => {
    const result = classify("/usr/bin/git diff --stat");
    expect(result.sig).toBe("git.diff");
  });

  test("non-MULTI_VERB command", () => {
    const result = classify("ls -la");
    expect(result.sig).toBe("ls");
    expect(result.base).toBe("ls");
    expect(result.sub).toBeUndefined();
  });

  test("compound command: first segment", () => {
    // classify returns the first segment's classification
    const result = classify("git diff --stat && npm test");
    expect(result.sig).toBe("git.diff");
  });

  test("empty command", () => {
    const result = classify("");
    expect(result.sig).toBe("");
  });

  test("command with env assignment inline", () => {
    const result = classify("GIT_AUTHOR=John git commit -m 'test'");
    expect(result.sig).toBe("git.commit");
  });
});
