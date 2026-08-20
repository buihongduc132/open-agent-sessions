/**
 * src/tui/tree-model.ts
 *
 * Fork tree builder for visualising session genealogy.
 *
 * A fork tree shows all sessions that share a common ancestor
 * (identified via parentSessionId on SessionDetail).
 *
 * Usage:
 *   const forest = buildForest(sessions);
 *   const lines = renderTree(forest, { expanded: new Set() });
 *
 * @file src/tui/tree-model.ts
 */

import type { SessionSummary } from "../core/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TreeNode {
  /** Unique per agent:sessionId */
  key: string;
  sessionId: string;
  title: string;
  agent: string;
  alias: string;
  forkedAt?: string;
  updatedAt: string;
  /** Direct children (sessions forked FROM this one) */
  children: TreeNode[];
}

export interface TreeRenderOptions {
  /** Keys that are collapsed (children hidden). Defaults to empty set. */
  collapsed?: Set<string>;
  /** Currently selected key (for highlighting) */
  selectedKey?: string;
  /** Max depth to render (0 = unlimited) */
  maxDepth?: number;
  /** Session ID prefix for rendering a subtree */
  rootKey?: string;
  /** Max character width for each label; labels longer than this are truncated with `…` */
  maxLabelWidth?: number;
}

export interface TreeRenderLine {
  text: string;
  key: string;
  depth: number;
  isSelected: boolean;
  isCollapsed: boolean;
  hasChildren: boolean;
}

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------

/**
 * Build a forest of fork trees from a flat list of sessions.
 * Sessions without a parentSessionId become root nodes.
 */
export function buildForest(sessions: SessionSummary[]): TreeNode[] {
  // Map: sessionId → node (partial, children=[])
  const nodeMap = new Map<string, TreeNode>();
  const parentMap = new Map<string, string>(); // child → parent

  // Phase 1: create all nodes
  for (const s of sessions) {
    const key = `${s.agent}:${s.alias}:${s.id}`;
    nodeMap.set(key, {
      key,
      sessionId: s.id,
      title: s.title ?? s.id,
      agent: s.agent,
      alias: s.alias,
      forkedAt: undefined,
      updatedAt: s.updated_at,
      children: [],
    });
    // parentSessionId may be in agent-specific data; we store parentId separately
    if ("parentSessionId" in s && (s as unknown as Record<string, unknown>).parentSessionId) {
      const parentId = String((s as unknown as Record<string, unknown>).parentSessionId);
      parentMap.set(s.id, parentId);
    }
  }

  // Phase 2: wire parent→child relationships
  const roots: TreeNode[] = [];

  for (const [childId, parentId] of parentMap.entries()) {
    // Find parent node: parent must be in same agent+alias
    // (fork within the same agent entry)
    let parentNode: TreeNode | undefined;
    for (const node of nodeMap.values()) {
      if (node.sessionId === parentId) {
        parentNode = node;
        break;
      }
    }

    // If parent is in a different agent+alias, it won't be in this map.
    // The fork targets a different agent — still attach under the source node.
    if (!parentNode) {
      // Look for the parent in sessions (may be different agent)
      const parentSession = sessions.find(
        (s) => s.id === parentId
      );
      if (parentSession) {
        const parentKey = `${parentSession.agent}:${parentSession.alias}:${parentId}`;
        if (!nodeMap.has(parentKey)) {
          nodeMap.set(parentKey, {
            key: parentKey,
            sessionId: parentId,
            title: parentSession.title ?? parentId,
            agent: parentSession.agent,
            alias: parentSession.alias,
            updatedAt: parentSession.updated_at,
            children: [],
          });
        }
        parentNode = nodeMap.get(parentKey)!;
      }
    }

    if (parentNode) {
      // Wire child under parent
      const childKey = Array.from(nodeMap.entries()).find(
        ([, n]) => n.sessionId === childId
      )?.[0];
      if (childKey) {
        const child = nodeMap.get(childKey)!;
        parentNode.children.push(child);
      }
    } else {
      // No parent found — treat as root
      const childKey = Array.from(nodeMap.entries()).find(
        ([, n]) => n.sessionId === childId
      )?.[0];
      if (childKey) {
        roots.push(nodeMap.get(childKey)!);
      }
    }
  }

  // Phase 3: nodes with no parent → roots
  const childKeys = new Set(parentMap.keys());
  for (const node of nodeMap.values()) {
    if (!childKeys.has(node.sessionId)) {
      // Check it doesn't have a parent
      if (!parentMap.has(node.sessionId)) {
        // Also check it's not already in roots
        if (!roots.includes(node)) {
          roots.push(node);
        }
      }
    }
  }

  // Sort each root's children by updatedAt descending (newest first)
  sortChildrenRecursive(roots);

  return roots;
}

/** Sort children of each node by updatedAt descending, recurse. */
function sortChildrenRecursive(nodes: TreeNode[]): void {
  nodes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const n of nodes) {
    sortChildrenRecursive(n.children);
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const INDENT_STR = "  ";
const PIPE = "│   ";
const BRANCH = "├── ";
const LAST = "└── ";

/**
 * Render a forest of trees to a flat list of render lines.
 */
export function renderForest(
  forest: TreeNode[],
  options: TreeRenderOptions = {}
): TreeRenderLine[] {
  const lines: TreeRenderLine[] = [];
  for (const root of forest) {
    renderNode(root, "", true, lines, options);
  }
  return lines;
}

/** Recursive node renderer. */
function renderNode(
  node: TreeNode,
  prefix: string,
  isLast: boolean,
  lines: TreeRenderLine[],
  options: TreeRenderOptions
): void {
  const connector = isLast ? LAST : BRANCH;
  const childPrefix = prefix + (isLast ? INDENT_STR : PIPE);
  const isCollapsed = (options.collapsed ?? new Set()).has(node.key);
  const isSelected = node.key === options.selectedKey;
  const childCount = node.children.length;

  // Build the label — plain text; color applied via fg prop in TreeView, not embedded ANSI.
  // When multiple sessions share the same agent:alias they are visually identical without a
  // distinguisher; append the first 8 chars of the sessionId so each row is identifiable.
  const shortId = node.sessionId.slice(0, 8);
  const forkedLabel = node.forkedAt
    ? ` [${node.forkedAt.slice(0, 16).replace("T", " ")}]`
    : "";
  const collapsedLabel = isCollapsed && childCount > 0
    ? ` (+${childCount} more)`
    : "";

  const label = `${node.agent}/${node.alias}~${shortId}${forkedLabel}${collapsedLabel}`;
  const truncatedLabel = truncateLabel(label, options.maxLabelWidth);
  const text = prefix + connector + truncatedLabel;

  lines.push({
    text,
    key: node.key,
    depth: prefix.split(PIPE).filter(Boolean).length,
    isSelected,
    isCollapsed,
    hasChildren: childCount > 0,
  });

  if (!isCollapsed) {
    const sortedChildren = [...node.children].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt)
    );
    sortedChildren.forEach((child, i) => {
      renderNode(child, childPrefix, i === sortedChildren.length - 1, lines, options);
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate `text` to `maxWidth` characters, appending `…` if truncated.
 * If maxWidth is undefined, 0, or <= the text length, returns text unchanged.
 */
export function truncateLabel(text: string, maxWidth?: number): string {
  if (!maxWidth || maxWidth <= 0) return text;
  if (text.length <= maxWidth) return text;
  if (maxWidth < 3) return text.slice(0, maxWidth);
  return text.slice(0, maxWidth - 1) + "…";
}

/** Hex color for agent type. Used for both text fg and tree label color. */
export function colorForAgent(agent: string): string {
  switch (agent) {
    case "opencode": return "#4dd9ff"; // cyan
    case "codex":    return "#ffcc00";  // yellow
    case "claude":   return "#cc99ff";  // magenta
    case "acpx":     return "#99ff99";  // green
    case "grok":     return "#ff8c42";  // orange
    default:         return "#999999";  // dim gray
  }
}

/** Strip ANSI codes for non-TTY rendering. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Count total nodes (including collapsed) in a forest. */
export function countNodes(forest: TreeNode[]): number {
  let total = 0;
  function count(nodes: TreeNode[]): void {
    for (const n of nodes) {
      total++;
      count(n.children);
    }
  }
  count(forest);
  return total;
}

/** Find a node by key in a forest. */
export function findNode(forest: TreeNode[], key: string): TreeNode | undefined {
  for (const node of forest) {
    if (node.key === key) return node;
    const found = findNode(node.children, key);
    if (found) return found;
  }
  return undefined;
}

/** Get all node keys (including children of collapsed nodes). */
export function allKeys(forest: TreeNode[]): string[] {
  const keys: string[] = [];
  function collect(nodes: TreeNode[]): void {
    for (const n of nodes) {
      keys.push(n.key);
      collect(n.children);
    }
  }
  collect(forest);
  return keys;
}