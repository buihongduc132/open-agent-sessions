import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { createCliRenderer } from "@opentui/core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Config } from "../config/types";
import { SessionListQuery, SessionListResult } from "../core/list";
import { SessionDetail, SessionSummary } from "../core/types";
import {
  applyKey as applyListKey,
  applyListData,
  createListState,
  formatFooter,
  getEmptyState,
  getSelectedSession,
  setViewportHeight as setListViewportHeight,
  type KeyInput as ListKeyInput,
  type TuiListState,
} from "./list-model";
import {
  applyDetailKey,
  createDetailState,
  setDetailViewportHeight,
  type KeyInput as DetailKeyInput,
  type TuiDetailState,
} from "./detail-model";

export type ListService = (query?: SessionListQuery) => Promise<SessionListResult>;
export type DetailService = (query: {
  agent: SessionSummary["agent"];
  alias: string;
  id: string;
}) => Promise<SessionDetail | null>;

export type ExitReason = "quit" | "ctrl-c";

export type TuiAppProps = {
  config: Config;
  list: ListService;
  getSession?: DetailService;
  onExit?: (reason: ExitReason) => void;
};

export function TuiApp({ config, list, getSession, onExit }: TuiAppProps): ReactNode {
  return (
    <TuiAppView
      config={config}
      list={list}
      getSession={getSession}
      onExit={onExit}
    />
  );
}

export function TuiAppView({
  config,
  list,
  getSession,
  onExit,
  viewportHeightOverride,
}: TuiAppProps & { viewportHeightOverride?: number }): ReactNode {
  const { height } = useTerminalDimensions();
  const effectiveHeight = viewportHeightOverride ?? height;
  const [listState, setListState] = useState<TuiListState>(() =>
    createListState(config.agents)
  );
  const [detailState, setDetailState] = useState<TuiDetailState | null>(null);
  const [view, setView] = useState<"list" | "detail">("list");
  const [fatalError, setFatalError] = useState<string | null>(null);

  const listViewportHeight = useMemo(() => {
    const header = 1;
    const footer = 1;
    const filter = listState.mode === "filter" ? 1 : 0;
    return Math.max(1, effectiveHeight - header - footer - filter);
  }, [effectiveHeight, listState.mode]);

  const detailViewportHeight = useMemo(() => {
    const header = 1;
    const footer = 1;
    return Math.max(1, effectiveHeight - header - footer);
  }, [effectiveHeight]);

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
    list({})
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
  }, [list]);

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
        const detail = await getSession({
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
      } catch (error) {
        setListState((prev) => ({
          ...prev,
          statusMessage: withLabel(session, errorMessage(error)),
        }));
      }
    },
    [getSession]
  );

  const handleListKey = useCallback(
    (key: ListKeyInput) => {
      setListState((prev) => {
        const { state, effects } = applyListKey(prev, key);
        for (const effect of effects) {
          if (effect.type === "exit") {
            handleExit(effect.reason);
          }
          if (effect.type === "open-detail") {
            void openDetail(effect.session);
          }
        }
        return state;
      });
    },
    [handleExit, openDetail]
  );

  const handleDetailKey = useCallback(
    (key: DetailKeyInput) => {
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
        if (view === "detail" && detailState) {
          handleDetailKey(key);
          return;
        }
        handleListKey(key);
      },
      [detailState, fatalError, handleDetailKey, handleExit, handleListKey, view]
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
      <Header title={view === "detail" ? "Session Detail" : "Sessions"} />
      {view === "list" && listState.mode === "filter" ? (
        <FilterInput value={listState.filterInput} />
      ) : null}
      {view === "detail" && detailState ? (
        <DetailView state={detailState} height={detailViewportHeight} />
      ) : (
        <ListView state={listState} height={listViewportHeight} />
      )}
      {view === "detail" && detailState ? (
        <Footer text="Esc: back  ? : help  q/Ctrl+C: exit" />
      ) : (
        <Footer text={formatFooter(listState)} />
      )}
      {view === "detail" && detailState ? (
        <HelpOverlay visible={detailState.mode === "help"} view="detail" />
      ) : (
        <HelpOverlay visible={listState.mode === "help"} view="list" />
      )}
    </box>
  );
}

export async function runTuiApp(options: {
  config: Config;
  list: ListService;
  getSession?: DetailService;
}): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  await new Promise<void>((resolve) => {
    const handleExit = () => {
      renderer.destroy();
      resolve();
    };
    root.render(
      <TuiApp
        config={options.config}
        list={options.list}
        getSession={options.getSession}
        onExit={handleExit}
      />
    );
  });
}

function Header({ title }: { title: string }): ReactNode {
  return (
    <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
      <text fg="#9fd3ff">{title}</text>
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

function ListView({ state, height }: { state: TuiListState; height: number }): ReactNode {
  const emptyState = getEmptyState(state);
  const rows = state.filteredSessions.slice(
    state.scrollOffset,
    state.scrollOffset + height
  );

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1 }}>
      {emptyState.kind !== "none" ? (
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
        {isDetail ? null : <text fg="#cccccc">/: filter</text>}
        {isDetail ? null : <text fg="#cccccc">a/l: toggle agent/alias</text>}
        {isDetail ? null : <text fg="#cccccc">0: clear toggles</text>}
        {isDetail ? null : <text fg="#cccccc">Enter: open detail</text>}
        <text fg="#cccccc">{isDetail ? "Esc: back" : "Esc: close"}</text>
        <text fg="#cccccc">q/Ctrl+C: exit</text>
        <text fg="#888888">Press ? or Esc to close</text>
      </box>
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
