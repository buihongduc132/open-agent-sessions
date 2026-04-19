import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { createCliRenderer } from "@opentui/core";
import { flushSync } from "@opentui/react/renderer";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

// Set OAS_DEBUG_PERF=1 in the environment to emit [PERF] timing lines to stderr.
const DEBUG_PERF = process.env["OAS_DEBUG_PERF"] === "1";
const LIST_TIMEOUT_MS = 8000;
import { Config } from "../config/types";
import { CloneRequest, CloneResult } from "../core/clone";
import { SessionListQuery, SessionListResult } from "../core/list";
import { SessionDetail, SessionSummary } from "../core/types";
import {
  DEFAULT_LIST_LIMIT,
  applyKey as applyListKey,
  applyListData,
  createListState,
  formatFooter,
  getEmptyState,
  getSelectedSession,
  setViewportHeight as setListViewportHeight,
  type KeyInput as ListKeyInput,
  type TuiListState,
  type TuiMode,
} from "./list-model";
import {
  applyDetailKey,
  createDetailState,
  setDetailViewportHeight,
  type KeyInput as DetailKeyInput,
  type TuiDetailState,
} from "./detail-model";
import {
  buildForest,
  renderForest,
  type TreeNode,
  type TreeRenderLine,
} from "./tree-model";
import {
  buildTimeline,
  moveDown,
  moveUp,
  renderTimeline,
  toggleTools,
  toggleReasoning,
  type TimelineState,
} from "./timeline-model";

export type ListService = (query?: SessionListQuery) => Promise<SessionListResult>;
export type DetailService = (query: {
  agent: SessionSummary["agent"];
  alias: string;
  id: string;
}) => Promise<SessionDetail | null>;
export type CloneService = (request: CloneRequest) => Promise<CloneResult>;

export type ExitReason = "quit" | "ctrl-c";

export type TuiView = "list" | "detail" | "tree" | "timeline";

export type TuiAppProps = {
  config: Config;
  list: ListService;
  getSession?: DetailService;
  cloneSession?: CloneService;
  onExit?: (reason: ExitReason) => void;
};

export function TuiApp({ config, list, getSession, cloneSession, onExit }: TuiAppProps): ReactNode {
  return (
    <TuiAppView
      config={config}
      list={list}
      getSession={getSession}
      cloneSession={cloneSession}
      onExit={onExit}
    />
  );
}

export function TuiAppView({
  config,
  list,
  getSession,
  cloneSession,
  onExit,
  viewportHeightOverride,
}: TuiAppProps & { viewportHeightOverride?: number }): ReactNode {
  const { height } = useTerminalDimensions();
  const effectiveHeight = viewportHeightOverride ?? height;
  const [listState, setListState] = useState<TuiListState>(() =>
    createListState(config.agents)
  );
  const [detailState, setDetailState] = useState<TuiDetailState | null>(null);
  const [view, setView] = useState<TuiView>("list");
  const [treeForests, setTreeForests] = useState<TreeNode[]>([]);
  const [treeCollapsed, setTreeCollapsed] = useState<Set<string>>(new Set());
  const [treeSelectionIndex, setTreeSelectionIndex] = useState(0);
  const [timelineState, setTimelineState] = useState<TimelineState | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [perfLog, setPerfLog] = useState<Array<{ label: string; durationMs: number; timestamp: Date }>>([]);
  const [showPerfOverlay, setShowPerfOverlay] = useState(false);

  const listViewportHeight = useMemo(() => {
    const header = 1;
    const footer = 1;
    const filter = listState.mode === "filter" ? 1 : 0;
    const clone = listState.mode === "clone" ? (listState.clonePrompt?.destinations.length ?? 0) + 2 : 0;
    return Math.max(1, effectiveHeight - header - footer - filter - clone);
  }, [effectiveHeight, listState.mode, listState.clonePrompt?.destinations.length]);

  const detailViewportHeight = useMemo(() => {
    const header = 1;
    const footer = 1;
    return Math.max(1, effectiveHeight - header - footer);
  }, [effectiveHeight]);

  // Build fork tree when switching to tree view
  const treeViewportHeight = useMemo(
    () => Math.max(1, effectiveHeight - 3),
    [effectiveHeight]
  );

  // ── Performance instrumentation ───────────────────────────────────────────────

  const timedList = useCallback(
    async (query: SessionListQuery) => {
      const t0 = Date.now();
      try {
        const result = await list(query);
        const ms = Date.now() - t0;
        console.log(`[PERF] list: ${ms}ms`);
        if (ms > 5000) {
          console.error(`[PERF SLOW] list took ${ms}ms (>5000ms threshold)`);
          setPerfLog((prev) => [
            ...prev.slice(-19),
            { label: `list(${JSON.stringify(query)})`, durationMs: ms, timestamp: new Date() },
          ]);
        }
        return result;
      } catch (err) {
        const ms = Date.now() - t0;
        console.error(`[PERF] list error after ${ms}ms:`, err);
        throw err;
      }
    },
    [list]
  );

  const timedGetSession = useCallback(
    async (query: { agent: SessionSummary["agent"]; alias: string; id: string }) => {
      if (!getSession) return null;
      const t0 = Date.now();
      try {
        const result = await getSession(query);
        const ms = Date.now() - t0;
        console.log(`[PERF] getSession: ${ms}ms`);
        if (ms > 5000) {
          console.error(`[PERF SLOW] getSession took ${ms}ms (>5000ms threshold)`);
          setPerfLog((prev) => [
            ...prev.slice(-19),
            { label: `getSession(${query.id})`, durationMs: ms, timestamp: new Date() },
          ]);
        }
        return result;
      } catch (err) {
        const ms = Date.now() - t0;
        console.error(`[PERF] getSession error after ${ms}ms:`, err);
        throw err;
      }
    },
    [getSession]
  );

  useEffect(() => {
    setListState((prev) => setListViewportHeight(prev, listViewportHeight));
  }, [listViewportHeight]);

  useEffect(() => {
    if (detailState) {
      setDetailState((prev) =>
        prev ? setDetailViewportHeight(prev, detailViewportHeight) : prev
      );
    }
  }, [detailState, detailViewportHeight]);

  useEffect(() => {
    let cancelled = false;
    timedList({ limit: DEFAULT_LIST_LIMIT })
      .then((result) => {
        if (cancelled) return;
        setListState((prev) => applyListData(prev, result));
      })
      .catch((error) => {
        if (cancelled) return;
        setFatalError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [timedList]);

  // Build fork tree whenever we have sessions loaded
  useEffect(() => {
    if (view === "tree") {
      const forests = buildForest(listState.filteredSessions);
      setTreeForests(forests);
      setTreeSelectionIndex(0);
    }
  }, [view, listState.filteredSessions]);

  // Build timeline when switching to detail+timeline
  useEffect(() => {
    if (view === "timeline" && detailState) {
        setTimelineState(buildTimeline(detailState.detail));
    }
  }, [view, detailState]);

  const handleExit = useCallback(
    (reason: ExitReason) => {
      if (onExit) {
        onExit(reason);
      }
    },
    [onExit]
  );

  const openDetail = useCallback(
    async (session: SessionSummary) => {
      if (!getSession) {
        const fallback = session as SessionDetail;
        setDetailState(createDetailState({ ...fallback, clone: fallback.clone }));
        setView("detail");
        return;
      }

      try {
        const detail = await timedGetSession({
          agent: session.agent,
          alias: session.alias,
          id: session.id,
        });
        if (!detail) {
          setListState((prev) => ({
            ...prev,
            statusMessage: withLabel(session, `Session not found: ${session.id}`),
          }));
          return;
        }
        setDetailState(createDetailState(detail));
        setView("detail");
        // Build timeline from the loaded detail
        setTimelineState(buildTimeline(detail));
      } catch (error) {
        setListState((prev) => ({
          ...prev,
          statusMessage: withLabel(session, errorMessage(error)),
        }));
      }
    },
    [getSession, timedGetSession]
  );

  const handleClone = useCallback(
    async (source: SessionSummary, destination: string) => {
      if (!cloneSession) {
        setListState((prev) => ({
          ...prev,
          mode: "list",
          statusMessage: "Clone service not available.",
        }));
        return;
      }

      try {
        const request: CloneRequest = {
          source: {
            agent: source.agent,
            alias: source.alias,
            session_id: source.id,
          },
          destination: {
            agent: "opencode",
            alias: destination,
          },
        };
        const result = await cloneSession(request);
        
        // Refresh the list to show the new session
        const listResult = await timedList({ limit: DEFAULT_LIST_LIMIT });
        setListState((prev) => {
          const next = applyListData({ ...prev, mode: "list" }, listResult);
          return {
            ...next,
            statusMessage: `Session cloned to [opencode:${destination}] (id: ${result.destinationId})`,
          };
        });
      } catch (error) {
        setListState((prev) => ({
          ...prev,
          mode: "list",
          statusMessage: `Clone failed: ${errorMessage(error)}`,
        }));
      }
    },
    [cloneSession, timedList]
  );

  const handleListKey = useCallback(
    (key: ListKeyInput) => {
      // P (Shift+p): toggle performance log overlay in list view
      if (key.name === "P") {
        setShowPerfOverlay((prev) => !prev);
        return;
      }

      setListState((prev) => {
        const { state, effects } = applyListKey(prev, key);
        for (const effect of effects) {
          if (effect.type === "exit") {
            handleExit(effect.reason);
          }
          if (effect.type === "open-detail") {
            void openDetail(effect.session);
          }
          if (effect.type === "clone") {
            void handleClone(effect.source, effect.destination);
          }
          if (effect.type === "switch-view") {
            setView(effect.view);
            return { ...state, mode: effect.view as TuiMode };
          }
        }
        return state;
      });
    },
    [handleExit, openDetail, handleClone, setView]
  );

  const handleDetailKey = useCallback(
    (key: DetailKeyInput) => {
      if (key.name === "t") {
        setView("timeline");
        return;
      }
      setDetailState((prev) => {
        if (!prev) return prev;
        const { state, effect } = applyDetailKey(prev, key);
        if (effect?.type === "exit") {
          handleExit(effect.reason);
          return state;
        }
        if (effect?.type === "back") {
          setView("list");
          return state;
        }
        return state;
      });
    },
    [handleExit]
  );

  // ── Tree key handler ─────────────────────────────────────────────────────────
  const handleTreeKey = useCallback(
    (key: { name: string; ctrl?: boolean }) => {
      const allLines = renderForest(treeForests, {
        collapsed: treeCollapsed,
        selectedKey: undefined,
      });

      if (key.name === "j" || key.name === "down") {
        setTreeSelectionIndex((i) => Math.min(i + 1, allLines.length - 1));
        return;
      }
      if (key.name === "k" || key.name === "up") {
        setTreeSelectionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (key.name === "g") {
        setTreeSelectionIndex(0);
        return;
      }
      if (key.name === "G") {
        setTreeSelectionIndex(allLines.length - 1);
        return;
      }
      if (key.name === "enter" || key.name === "right") {
        // Open detail for the selected tree node
        const selected = allLines[treeSelectionIndex];
        if (selected) {
          const keyParts = selected.key.split(":");
          const agent = keyParts[0] ?? "opencode";
          const alias = keyParts[1] ?? "default";
          void openDetail({
            id: keyParts[2] ?? selected.key,
            agent: agent as SessionSummary["agent"],
            alias,
            title: "",
          } as SessionSummary);
        }
        return;
      }
      if (key.name === "left" || key.name === "h") {
        // Toggle collapse on the selected node (left/h collapses)
        const selected = allLines[treeSelectionIndex];
        if (selected && selected.hasChildren) {
          setTreeCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(selected.key)) {
              next.delete(selected.key);
            } else {
              next.add(selected.key);
            }
            return next;
          });
        }
        return;
      }
      if (key.name === "t") {
        // Open the selected session detail first — must populate detailState and
        // timelineState before switching to timeline view.
        const selected = allLines[treeSelectionIndex];
        if (selected) {
          const keyParts = selected.key.split(":");
          const agent = keyParts[0] ?? "opencode";
          const alias = keyParts[1] ?? "default";
          void openDetail({
            id: keyParts[2] ?? selected.key,
            agent: agent as SessionSummary["agent"],
            alias,
            title: "",
          } as SessionSummary);
        }
        return;
      }
      if (key.name === "escape" || key.name === "q") {
        setView("list");
        return;
      }
    },
    [treeForests, treeCollapsed, treeSelectionIndex, openDetail]
  );

  // ── Timeline key handler ──────────────────────────────────────────────────────
  const handleTimelineKey = useCallback(
    (key: { name: string; ctrl?: boolean }) => {
      if (!timelineState) return;

      // P: toggle perf overlay
      if (key.name === "P") {
        setShowPerfOverlay((prev) => !prev);
        return;
      }

      // Esc/P while perf overlay is open: close it
      if (showPerfOverlay && (key.name === "escape" || key.name === "P")) {
        setShowPerfOverlay(false);
        return;
      }

      if (key.name === "j" || key.name === "down") {
        setTimelineState((prev) => prev ? moveDown(prev, treeViewportHeight) : prev);
        return;
      }
      if (key.name === "k" || key.name === "up") {
        setTimelineState((prev) => prev ? moveUp(prev) : prev);
        return;
      }
      if (key.name === "m") {
        setTimelineState((prev) => prev ? toggleTools(prev) : prev);
        return;
      }
      if (key.name === "r") {
        setTimelineState((prev) => prev ? toggleReasoning(prev) : prev);
        return;
      }
      if (key.name === "escape" || key.name === "t") {
        setView("detail");
        return;
      }
      if (key.name === "h") {
        setView("detail");
        return;
      }
      if (key.name === "q") {
        setView("list");
        return;
      }
    },
    [timelineState, treeViewportHeight, showPerfOverlay]
  );

  useKeyboard(
    useCallback(
      (key) => {
        if (fatalError) {
          if (key.ctrl && key.name === "c") {
            handleExit("ctrl-c");
          }
          if (key.name === "q") {
            handleExit("quit");
          }
          return;
        }
        if (view === "tree") {
          handleTreeKey(key);
          return;
        }
        if (view === "timeline") {
          handleTimelineKey(key);
          return;
        }
        if (view === "detail") {
          handleDetailKey(key);
          return;
        }
        // view === "list"
        handleListKey(key);
      },
      [fatalError, handleDetailKey, handleExit, handleListKey, handleTreeKey, handleTimelineKey, view, setView]
    )
  );

  if (fatalError) {
    return (
      <box style={{ flexDirection: "column", padding: 1 }}>
        <text fg="#ff6b6b">Error: {fatalError}</text>
        <text fg="#999999">Press q or Ctrl+C to exit.</text>
      </box>
    );
  }

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <Header
        title={
          view === "tree"
            ? "Fork Tree"
            : view === "timeline"
            ? "Timeline"
            : view === "detail"
            ? "Session Detail"
            : "Sessions"
        }
        agents={config.agents}
      />
      {view === "tree" ? (
        <TreeView
          forests={treeForests}
          collapsed={treeCollapsed}
          selectionIndex={treeSelectionIndex}
          height={treeViewportHeight}
        />
      ) : view === "timeline" && timelineState ? (
        <TimelineView state={timelineState} height={detailViewportHeight} />
      ) : view === "detail" && detailState ? (
        <DetailView state={detailState} height={detailViewportHeight} />
      ) : (
        <ListView state={listState} height={listViewportHeight} />
      )}
      {view === "tree" ? (
        <Footer text="j/k: move  Enter/→/l: open  ←/h: collapse  t: timeline  Tab: list  q: quit" />
      ) : view === "timeline" ? (
        <Footer
          text={
            timelineState
              ? `Models: ${timelineState.subAgentSummary.models.join(", ") || "—"} | ` +
                `Tools: ${timelineState.subAgentSummary.toolCallCount} | ` +
                `m: tools ${timelineState.filter.showTools ? "on" : "off"} ` +
                `r: reasoning ${timelineState.filter.showReasoning ? "on" : "off"} | ` +
                "Esc/t: detail  Tab: list  q: quit"
              : ""
          }
        />
      ) : view === "detail" && detailState ? (
        <Footer text="h/Esc/q: back  j/k: scroll  g/G: top/bottom  t: timeline  ?: help  P: perf" />
      ) : listState.mode === "clone" ? (
        <Footer text="j/k: select  Enter: confirm  Esc: cancel  Ctrl+C: exit" />
      ) : (
        <Footer text={formatFooter(listState) + "  h: agent  a: alias  /: filter  P: perf  t→timeline  Tab→tree  q/Ctrl+C: exit"} />
      )}
      {view === "detail" && detailState ? (
        <HelpOverlay visible={detailState.mode === "help"} view="detail" />
      ) : (
        <HelpOverlay visible={listState.mode === "help"} view="list" />
      )}
      {showPerfOverlay && view === "list" && (
        <PerfOverlay logs={perfLog} onClose={() => setShowPerfOverlay(false)} />
      )}
    </box>
  );
}

export async function runTuiApp(options: {
  config: Config;
  list: ListService;
  getSession?: DetailService;
  cloneSession?: CloneService;
}): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, testing: false });
  const root = createRoot(renderer);

  await new Promise<void>((resolve) => {
    const handleExit = () => {
      renderer.destroy();
      resolve();
    };
    // Wrap render in flushSync so all useEffect-triggered re-renders commit synchronously
    flushSync(() => {
      root.render(
        <TuiApp
          config={options.config}
          list={options.list}
          getSession={options.getSession}
          cloneSession={options.cloneSession}
          onExit={handleExit}
        />
      );
    });
  });
}

function Header({ title, agents }: { title: string; agents?: Config["agents"] }): ReactNode {
  const agentLabel =
    agents
      ?.filter((a) => a.enabled)
      .map((a) => `[${a.agent}:${a.alias}]`)
      .join(" ") ?? "";

  return (
    <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
      <text fg="#9fd3ff">{title}</text>
      {agentLabel ? (
        <text fg="#7ab8d4">  {agentLabel}</text>
      ) : null}
    </box>
  );
}

function Footer({ text }: { text: string }): ReactNode {
  return (
    <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
      <text fg="#aaaaaa">{text}</text>
    </box>
  );
}

function PerfOverlay({
  logs,
  onClose,
}: {
  logs: Array<{ label: string; durationMs: number; timestamp: Date }>;
  onClose: () => void;
}): ReactNode {
  if (logs.length === 0) {
    return (
      <box
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          backgroundColor: "#000000B3",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <box
          border
          style={{
            flexDirection: "column",
            padding: 1,
            minWidth: 40,
            backgroundColor: "#1b1f2a",
            borderColor: "#ffcc00",
          }}
        >
          <text fg="#ffcc00">Performance Log (empty)</text>
          <text fg="#888888">No slow operations recorded yet.</text>
          <text fg="#888888">Press P or Esc to close.</text>
        </box>
      </box>
    );
  }

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        backgroundColor: "#000000B3",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <box
        border
        style={{
          flexDirection: "column",
          padding: 1,
          minWidth: 60,
          maxHeight: 20,
          backgroundColor: "#1b1f2a",
          borderColor: "#ffcc00",
        }}
      >
        <text fg="#ffcc00">Performance Log — Slow Operations (&gt;5000ms)</text>
        {logs.map((entry, i) => (
          <text key={i} fg="#cccccc">
            [{entry.timestamp.toISOString()}] {entry.durationMs}ms — {entry.label}
          </text>
        ))}
        <text fg="#888888">Press P or Esc to close.</text>
      </box>
    </box>
  );
}

function TreeView({
  forests,
  collapsed,
  selectionIndex,
  height,
}: {
  forests: TreeNode[];
  collapsed: Set<string>;
  selectionIndex: number;
  height: number;
}): ReactNode {
  const allLines = renderForest(forests, { collapsed });
  const visible = allLines.slice(selectionIndex, selectionIndex + height);

  if (allLines.length === 0) {
    return (
      <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1 }}>
        <text fg="#999999">No sessions to display. Run `oas list` first.</text>
      </box>
    );
  }

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1 }}>
      {visible.map((line, i) => {
        const isSelected = allLines.indexOf(line) === selectionIndex;
        const agent = line.key.split(":")[0] ?? "opencode";
        const baseFg = isSelected ? "#ffffff" : agentColor(agent);
        return (
          <text
            key={`${line.key}-${i}`}
            fg={baseFg}
          >
            {(isSelected ? "> " : "  ") + line.text}
          </text>
        );
      })}
    </box>
  );
}

function TimelineView({
  state,
  height,
}: {
  state: TimelineState;
  height: number;
}): ReactNode {
  const lines = renderTimeline(state, height);
  const sub = state.subAgentSummary;

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1 }}>
      {/* Sub-agent summary header */}
      <box style={{ paddingBottom: 0, flexDirection: "column" }}>
        <text fg="#4aa3ff">Sub-agents</text>
        <text fg="#999999">
          Models:{" "}
          {sub.models.length > 0 ? sub.models.join(", ") : "—"}
          {"  |  "}
          Tools: {sub.toolCallCount} calls across {sub.tools.length} types
          {"  |  "}
          Reasoning: {sub.reasoningUsed ? "yes" : "no"}
        </text>
        {sub.tools.length > 0 && (
          <text fg="#888888">
            Top tools:{" "}
            {sub.tools.slice(0, 5).map((t) => `${t.name}(${t.callCount})`).join(", ")}
          </text>
        )}
      </box>
      <text fg="#555555">{"─".repeat(60)}</text>
      {lines.map((line, i) => (
        <text key={`${line.index}-${line.subIndex}-${i}`} fg="#cccccc">
          {line.text}
        </text>
      ))}
    </box>
  );
}

function ListView({ state, height }: { state: TuiListState; height: number }): ReactNode {
  const emptyState = getEmptyState(state);
  const rows = state.filteredSessions.slice(
    state.scrollOffset,
    state.scrollOffset + height
  );

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1 }}>
      {emptyState.kind === "loading" ? (
        <text fg="#4aa3ff">Loading sessions…</text>
      ) : emptyState.kind !== "none" ? (
        <text fg="#999999">{emptyState.message}</text>
      ) : (
        rows.map((session, index) => {
          const actualIndex = state.scrollOffset + index;
          const selected = actualIndex === state.selectionIndex;
          const label = `[${session.agent}:${session.alias}]`;
          const title = session.title.trim().length > 0 ? session.title : session.id;
          const row =
            title === session.id
              ? `${label} ${session.id}`
              : `${label} ${title} (${session.id})`;
          return (
            <text key={`${session.id}-${session.alias}`} fg={selected ? "#ffffff" : "#cccccc"}>
              {selected ? "> " : "  "}
              {row}
            </text>
          );
        })
      )}
    </box>
  );
}

function DetailView({
  state,
  height,
}: {
  state: TuiDetailState;
  height: number;
}): ReactNode {
  const lines = state.lines;
  const start = state.scrollOffset;
  const end = Math.min(lines.length, start + height);
  const visible = lines.slice(start, end);

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1 }}>
      {visible.map((line, index) => (
        <text key={`${start + index}-${line}`} fg="#cccccc">
          {line}
        </text>
      ))}
    </box>
  );
}

function HelpOverlay({
  visible,
  view,
}: {
  visible: boolean;
  view: "list" | "detail";
}): ReactNode {
  if (!visible) return null;
  const isDetail = view === "detail";
  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        backgroundColor: "#000000B3",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <box
        border
        style={{
          flexDirection: "column",
          padding: 1,
          minWidth: 44,
          backgroundColor: "#1b1f2a",
          borderColor: "#4aa3ff",
        }}
      >
        <text fg="#4aa3ff">Shortcuts</text>
        <text fg="#cccccc">j/k or ↑/↓: move</text>
        <text fg="#cccccc">g/G: top/bottom</text>
        {isDetail ? null : <text fg="#cccccc">h: agent drill-in</text>}
        {isDetail ? null : <text fg="#cccccc">a: alias drill-in</text>}
        {isDetail ? null : <text fg="#cccccc">H/L: back out agent/alias filter</text>}
        {isDetail ? null : <text fg="#cccccc">/: filter</text>}
        {isDetail ? null : <text fg="#cccccc">Enter/l: open detail</text>}
        {isDetail ? null : <text fg="#cccccc">0: clear toggles</text>}
        {isDetail ? null : <text fg="#cccccc">c: clone (codex only)</text>}
        {isDetail ? <text fg="#cccccc">h: back</text> : null}
        <text fg="#cccccc">{isDetail ? "Esc/q: back" : "Esc: close"}</text>
        {isDetail ? null : <text fg="#cccccc">t: timeline  Tab: cycle</text>}
        {isDetail ? null : <text fg="#cccccc">P: perf log</text>}
        <text fg="#cccccc">{isDetail ? "?: help  t: timeline" : "?: help  q: quit"}</text>
        <text fg="#888888">Press ? or Esc to close</text>
      </box>
    </box>
  );
}

function ClonePrompt({
  destinations,
  selectedIndex,
}: {
  destinations: string[];
  selectedIndex: number;
}): ReactNode {
  return (
    <box style={{ flexDirection: "column", paddingLeft: 1 }}>
      <text fg="#4aa3ff">Clone to opencode:</text>
      {destinations.map((dest, index) => (
        <text key={dest} fg={index === selectedIndex ? "#ffffff" : "#cccccc"}>
          {index === selectedIndex ? "> " : "  "}
          {dest}
        </text>
      ))}
    </box>
  );
}

function FilterInput({ value }: { value: string }): ReactNode {
  return (
    <box style={{ height: 1, paddingLeft: 1 }}>
      <text fg="#cccccc">Filter: {value}</text>
    </box>
  );
}

const AGENT_COLORS: Record<string, string> = {
  opencode: "#4dd9ff",
  codex: "#ffcc00",
  claude: "#cc99ff",
  acpx: "#99ff99",
};
function agentColor(agent: string): string {
  return AGENT_COLORS[agent] ?? "#cccccc";
}
function withLabel(session: SessionSummary, message: string): string {
  const label = `[${session.agent}:${session.alias}]`;
  if (message.includes(label)) {
    return message;
  }
  return `${label} ${message}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}
