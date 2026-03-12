import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { getSessionsPath } from "./config.js";
import { tmuxSessionName, tmuxSessionExists } from "./tmux.js";

export function loadState() {
  const path = getSessionsPath();
  if (!existsSync(path)) {
    return defaultState();
  }
  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return defaultState();
  }
}

export function saveState(state) {
  const path = getSessionsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

function defaultState() {
  return {
    activeSessionId: null,
    nextId: 1,
    sessions: [],
  };
}

export function createSession(projectPath, permissionMode, name, claudeSessionId) {
  const state = loadState();
  const id = state.nextId++;
  const now = new Date().toISOString();

  const session = {
    id,
    tmuxName: tmuxSessionName(id),
    projectPath,
    permissionMode,
    status: "starting",
    name,
    createdAt: now,
    lastActivityAt: now,
    enableHookLog: false,
  };

  // 如果提供了 claudeSessionId，立即关联
  if (claudeSessionId) {
    session.claudeSessionId = claudeSessionId;
  }

  state.sessions.push(session);
  state.activeSessionId = id;
  saveState(state);
  return session;
}

export function getSession(id) {
  const state = loadState();
  return state.sessions.find((s) => s.id === id);
}

export function getActiveSession() {
  const state = loadState();
  if (state.activeSessionId === null) return undefined;
  return state.sessions.find((s) => s.id === state.activeSessionId);
}

export function setActiveSession(id) {
  const state = loadState();
  const session = state.sessions.find((s) => s.id === id);
  if (!session || session.status === "stopped") return false;
  state.activeSessionId = id;
  saveState(state);
  return true;
}

export function updateSession(id, updates) {
  const state = loadState();
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return;
  Object.assign(session, updates);
  saveState(state);
}

export function closeSession(id) {
  const state = loadState();
  const sessionIndex = state.sessions.findIndex((s) => s.id === id);
  if (sessionIndex === -1) return false;

  // 从数组中完全移除 session
  state.sessions.splice(sessionIndex, 1);

  // 如果关闭的是活跃 session，切换到下一个可用 session
  if (state.activeSessionId === id) {
    const next = state.sessions.find((s) => s.status !== "stopped");
    state.activeSessionId = next ? next.id : null;
  }

  saveState(state);
  return true;
}

export function listActiveSessions() {
  const state = loadState();
  return state.sessions.filter((s) => s.status !== "stopped");
}

export function listAllSessions() {
  const state = loadState();
  return state.sessions;
}

export function findSessionByClaudeId(claudeSessionId) {
  const state = loadState();
  return state.sessions.find((s) => s.claudeSessionId === claudeSessionId);
}

export function findSessionByTmuxName(tmuxName) {
  const state = loadState();
  return state.sessions.find((s) => s.tmuxName === tmuxName);
}

export function associateClaudeSession(sessionId, claudeSessionId) {
  updateSession(sessionId, {
    claudeSessionId,
    status: "active",
    lastActivityAt: new Date().toISOString(),
  });
}

export function syncSessionStates() {
  const state = loadState();
  let changed = false;

  for (const session of state.sessions) {
    if (session.status === "stopped") continue;
    if (!tmuxSessionExists(session.tmuxName)) {
      session.status = "stopped";
      changed = true;
    }
  }

  if (changed) {
    if (state.activeSessionId !== null) {
      const active = state.sessions.find((s) => s.id === state.activeSessionId);
      if (active && active.status === "stopped") {
        const next = state.sessions.find((s) => s.status !== "stopped");
        state.activeSessionId = next ? next.id : null;
      }
    }
    saveState(state);
  }
}

