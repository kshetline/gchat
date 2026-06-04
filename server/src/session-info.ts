export interface SessionInfo {
  allowDm: boolean;
  ip?: string;
  inChat?: boolean;
  lastAlive?: number;
  lastContentUpdate?: number;
  name?: string;
  progress?: number;
}

export interface DbSessionInfo {
  allow_dm: number;
  in_chat: number;
  ip: string;
  last_alive: number;
  last_content_update: number;
  name: string;
  token: string;
}
