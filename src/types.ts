export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CliGlobalOptions {
  browserUrl: string;
  outDir: string;
  target?: string;
  timeout: number;
  screenshot: boolean;
}

export interface ArtifactMap {
  [name: string]: string;
}

export interface HosAction {
  rel: string;
  command: string;
  description: string;
}

export interface JsonEnvelope {
  ok: boolean;
  command: string;
  message?: string;
  data?: unknown;
  artifacts?: ArtifactMap;
  helpers?: HelperSummary[];
  actions?: HosAction[];
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface TargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface SnapshotMeta {
  id: string;
  label: string;
  createdAt: string;
  url: string;
  title: string;
  targetId: string;
  helperIds: string[];
}

export interface SnapshotResult {
  meta: SnapshotMeta;
  dir: string;
  artifacts: ArtifactMap;
}

export interface HelperSummary {
  id: string;
  title: string;
  description: string;
  matches: string[];
  commands: HelperCommandSummary[];
}

export interface HelperCommandSummary {
  name: string;
  description: string;
}
