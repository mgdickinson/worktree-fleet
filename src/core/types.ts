export const CURRENT_SCHEMA_VERSION = 1;

export type AgentKind = "claude-code" | "codex" | "generic-cli" | string;

export type AdapterMode = "wrapper" | "native" | "host-managed" | "generic";

export interface AdapterRegistration {
  schema_version: number;
  kind: string;
  mode: AdapterMode;
  installed_at: string;
  updated_at: string;
  package_bin: string | null;
  command: string | null;
  native_lifecycle: boolean;
  notes: string[];
}

export interface ActivityEvent {
  schema_version: number;
  activity_id: string;
  created_at: string;
  kind: string;
  summary: string;
  repo_id: string | null;
  session_id: string | null;
  worktree_path: string | null;
  details: Record<string, unknown>;
}

export interface PendingTarget {
  event_id: string;
  repo_id: string;
  source: string;
  ref: string;
  sha: string;
  created_at: string;
}

export interface IntegrationState {
  pending: PendingTarget | null;
  blocked: boolean;
  blocked_event_id: string | null;
  blocked_files: string[];
  blocked_reason: string | null;
  divergent_targets: PendingTarget[];
  last_notified_block_key: string | null;
  last_integrated_sha: string | null;
}

export interface SessionState {
  schema_version: number;
  session_id: string;
  agent_kind: AgentKind;
  adapter: string;
  adapter_version: string;
  pid: number;
  worktree_path: string;
  repo_id: string;
  branch: string;
  started_at: string;
  heartbeat_at: string;
  dirty_files: string[];
  dirty_refreshed_at: string;
  last_absorbed_event_id: string | null;
  integration: IntegrationState;
}

export interface IntentState {
  schema_version: number;
  session_id: string;
  tool_touched: string[];
  upcoming: string[];
  last_fleet_check_at?: string | null;
  updated_at: string;
}

export interface MainEvent extends PendingTarget {
  schema_version: number;
}

export interface ConfigState {
  schema_version: number;
  created_at: string;
  updated_at: string;
}

export interface LastFetchState {
  schema_version: number;
  repo_id: string;
  remote: string;
  ref: string;
  last_fetch_attempt_at: string | null;
  last_fetch_success_at: string | null;
  last_observed_sha: string | null;
  last_error: string | null;
}

export interface RepoConfigState {
  schema_version: number;
  repo_id: string;
  integration_branch: string;
  integration_remote: string;
  integration_remote_ref: string;
  created_at: string;
  updated_at: string;
}

export interface LockMetadata {
  pid: number;
  hostname: string;
  acquired_at: string;
}

export interface RepoInfo {
  root: string;
  commonDir: string;
  repoId: string;
  branch: string;
  head: string;
}
