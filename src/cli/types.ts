import { AgentKind } from "../config/types";

export type CloneSource = {
  agent: AgentKind;
  alias?: string;
  session_id: string;
};

export type CloneDestination = {
  agent: AgentKind;
  alias: string;
};

export type CloneRequest = {
  source: CloneSource;
  destination: CloneDestination;
};

export type CloneResult = {
  destinationId: string;
};

export type CloneService = (request: CloneRequest) => Promise<CloneResult>;

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
