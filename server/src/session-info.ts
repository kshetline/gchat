export interface SessionInfo {
  allowDm: boolean;
  ip?: string;
  inChat?: boolean;
  inChatLock?: boolean;
  lastActive?: number;
  lastAlive?: number;
  lastContentUpdate?: number;
  name?: string;
  openDms?: Set<number>;
  progress?: number;
}

export interface DbSessionInfo {
  allow_dm: number;
  in_chat: number;
  ip: string;
  last_active: number;
  last_alive: number;
  last_content_update: number;
  name: string;
  token: string;
}
