import { randomUUID } from "node:crypto";
import { AgentKind } from "../config/types";

export type CloneRequest = {
  source: {
    agent: AgentKind;
    alias?: string;
    session_id: string;
  };
  destination: {
    agent: AgentKind;
    alias: string;
  };
};

export type CloneResult = {
  destinationId: string;
};

export type CloneMetadata = {
  src: {
    agent: AgentKind;
    session_id: string;
    version: string;
  };
  dst: {
    agent: AgentKind;
    session_id: string;
    version: string;
  };
};

export type CloneMessage = {
  role: string;
  content: string;
  created_at: string;
  attachments?: unknown;
  images?: unknown;
  tool_calls?: unknown;
  [key: string]: unknown;
};

export type CloneSession = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: CloneMessage[];
  [key: string]: unknown;
};

export interface CloneSourceAdapter {
  agent: "codex";
  alias: string;
  version: string;
  getSession(session_id: string): Promise<CloneSession | null>;
}

export interface CloneDestinationAdapter {
  agent: "opencode";
  alias: string;
  version: string;
  createSession(input: {
    session: CloneSession;
    metadata: CloneMetadata;
    session_id: string;
  }): Promise<void>;
  hasSession?(session_id: string): Promise<boolean> | boolean;
  generateSessionId?(): string;
  isIdConflictError?(error: unknown): boolean;
}

export interface CloneRegistry {
  getSource(source: CloneRequest["source"]): CloneSourceAdapter | undefined;
  getDestination(
    destination: CloneRequest["destination"]
  ): CloneDestinationAdapter | undefined;
  listDestinations?(agent: AgentKind): string[];
  listSources?(agent: AgentKind): string[];
}

export interface CloneServiceOptions {
  maxIdAttempts?: number;
  generateId?: () => string;
  isIdConflictError?: (error: unknown) => boolean;
}

export function createCloneService(
  registry: CloneRegistry,
  options: CloneServiceOptions = {}
): (request: CloneRequest) => Promise<CloneResult> {
  return (request) => cloneSession(request, registry, options);
}

export async function cloneSession(
  request: CloneRequest,
  registry: CloneRegistry,
  options: CloneServiceOptions = {}
): Promise<CloneResult> {
  if (request.source.agent !== "codex" || request.destination.agent !== "opencode") {
    throw new Error(
      `Clone direction not supported: ${request.source.agent} -> ${request.destination.agent}`
    );
  }

  if (!request.source.alias) {
    throw new Error(`Clone source alias is required for ${request.source.agent}`);
  }

  const sourceAdapter = registry.getSource(request.source);
  if (!sourceAdapter) {
    const available =
      registry.listSources?.(request.source.agent).filter(Boolean) ?? [];
    if (available.length > 0) {
      throw new Error(
        `Unknown alias "${request.source.alias}" for ${request.source.agent}. Available aliases: ${formatList(
          available
        )}`
      );
    }
    throw new Error(
      `Clone source adapter not found for ${formatAdapterLabel(
        request.source.agent,
        request.source.alias
      )}`
    );
  }

  const destinationAdapter = registry.getDestination(request.destination);
  if (!destinationAdapter) {
    const available =
      registry.listDestinations?.(request.destination.agent).filter(Boolean) ?? [];
    if (available.length > 0) {
      throw new Error(
        `Unknown alias "${request.destination.alias}" for ${request.destination.agent}. Available aliases: ${formatList(
          available
        )}`
      );
    }
    throw new Error(
      `Clone destination adapter not found for ${formatAdapterLabel(
        request.destination.agent,
        request.destination.alias
      )}`
    );
  }

  const sourceSession = await sourceAdapter.getSession(request.source.session_id);
  if (!sourceSession) {
    throw new Error(
      `Source session not found for ${formatAdapterLabel(
        request.source.agent,
        request.source.alias
      )}: ${request.source.session_id}`
    );
  }

  const unsupported = findUnsupportedContent(sourceSession.messages);
  if (unsupported) {
    throw new Error(
      `Unsupported content (${unsupported}) in ${formatAdapterLabel(
        request.source.agent,
        request.source.alias
      )} session ${request.source.session_id}`
    );
  }

  const generateId =
    options.generateId ?? destinationAdapter.generateSessionId ?? defaultIdGenerator;
  const maxAttempts = options.maxIdAttempts ?? 5;
  const isConflictError =
    options.isIdConflictError ?? destinationAdapter.isIdConflictError;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const destinationId = generateId();
    if (destinationAdapter.hasSession) {
      const exists = await Promise.resolve(
        destinationAdapter.hasSession(destinationId)
      );
      if (exists) {
        continue;
      }
    }

    const metadata: CloneMetadata = {
      src: {
        agent: request.source.agent,
        session_id: request.source.session_id,
        version: sourceAdapter.version,
      },
      dst: {
        agent: request.destination.agent,
        session_id: destinationId,
        version: destinationAdapter.version,
      },
    };

    const destinationSession: CloneSession = {
      ...sourceSession,
      id: destinationId,
      messages: sourceSession.messages.map((message) => ({ ...message })),
    };

    try {
      await destinationAdapter.createSession({
        session: destinationSession,
        metadata,
        session_id: destinationId,
      });
      return { destinationId };
    } catch (error) {
      lastError = error;
      if (isConflictError && isConflictError(error)) {
        continue;
      }
      throw new Error(
        `${formatAdapterLabel(
          request.destination.agent,
          request.destination.alias
        )} ${errorMessage(error)}`
      );
    }
  }

  if (lastError && options.isIdConflictError && options.isIdConflictError(lastError)) {
    throw new Error(
      `Unable to allocate destination session id after ${maxAttempts} attempts`
    );
  }

  throw new Error(
    `Unable to allocate destination session id after ${maxAttempts} attempts`
  );
}

function defaultIdGenerator(): string {
  return randomUUID();
}

function formatAdapterLabel(agent: AgentKind, alias: string): string {
  return `[${agent}:${alias}]`;
}

function formatList(values: string[]): string {
  if (values.length === 0) {
    return "(none)";
  }
  return values.join(", ");
}

function hasPayload(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

function findUnsupportedContent(messages: CloneMessage[]): string | null {
  for (const message of messages) {
    if (hasPayload(message.attachments)) {
      return "attachments";
    }
    if (hasPayload(message.images)) {
      return "images";
    }
    if (hasPayload(message.tool_calls)) {
      return "tool calls";
    }
  }
  return null;
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
