import type {
  AgentKind,
  SessionCloneMetadata,
  SessionDetail,
  SessionMessage,
  SessionStorageKind,
  SessionSummary,
} from "@open-agent-sessions/sdk";

type ExpectedSessionSummary = {
  id: string;
  agent: AgentKind;
  alias: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  storage: SessionStorageKind;
  parentSessionId?: string;
};

type ExpectedSessionDetail = ExpectedSessionSummary & {
  parentSessionId?: string;
  clone?: SessionCloneMetadata;
  messages?: SessionMessage[];
  warning?: string;
};

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;

type Assert<T extends true> = T;
type SessionDetailAssignable = Assert<
  SessionDetail extends ExpectedSessionDetail ? true : false
>;
type ExpectedDetailAssignable = Assert<
  ExpectedSessionDetail extends SessionDetail ? true : false
>;

// Keep imports in this fixture tied to the public SDK, not internal source paths.
const _agentKind: AgentKind | undefined = undefined;
const _storageKind: SessionStorageKind | undefined = undefined;
void _agentKind;
void _storageKind;
void ({} as SessionDetailAssignable);
void ({} as ExpectedDetailAssignable);
