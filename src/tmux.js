import { execSync, exec } from "child_process";
import { existsSync, mkdirSync } from "fs";

const TMUX_PREFIX = "cc-bridge";

export function tmuxSessionName(id) {
  return `${TMUX_PREFIX}-${id}`;
}

export function checkTmux() {
  try {
    execSync("which tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function listTmuxSessions() {
  try {
    const output = execSync(
      `tmux list-sessions -F "#{session_name}" 2>/dev/null`,
      { encoding: "utf-8" }
    );
    return output
      .trim()
      .split("\n")
      .filter((s) => s.startsWith(TMUX_PREFIX));
  } catch {
    return [];
  }
}

export function listAllTmuxSessions() {
  try {
    const output = execSync(
      `tmux list-sessions -F "#{session_name}" 2>/dev/null`,
      { encoding: "utf-8" }
    );
    return output
      .trim()
      .split("\n")
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

export function tmuxSessionExists(name) {
  try {
    execSync(`tmux has-session -t "${name}" 2>/dev/null`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function createTmuxSession(name, projectPath, permissionMode, claudeSessionId) {
  // 如果项目路径不存在，自动创建它
  if (!existsSync(projectPath)) {
    mkdirSync(projectPath, { recursive: true });
  }

  let claudeCmd =
    permissionMode === "auto"
      ? "claude --dangerously-skip-permissions"
      : "claude";

  // 如果提供了 claudeSessionId，添加 --session-id 参数
  if (claudeSessionId) {
    claudeCmd += ` --session-id ${claudeSessionId}`;
  }

  execSync(
    `tmux new-session -d -s "${name}" -x 200 -y 50 -c "${projectPath}" "${claudeCmd}"`,
    { stdio: "ignore" }
  );
}

export function tmuxSendKeys(name, text) {
  execSync(
    `tmux send-keys -t "${name}" -l ${shellEscape(text)}`,
    { stdio: "ignore" }
  );
  execSync(`tmux send-keys -t "${name}" Enter`, { stdio: "ignore" });
}

export function tmuxSendSpecialKey(name, key) {
  execSync(`tmux send-keys -t "${name}" ${key}`, { stdio: "ignore" });
}

export function tmuxCapture(name, lines = 50) {
  try {
    const output = execSync(
      `tmux capture-pane -t "${name}" -p -S -${lines}`,
      { encoding: "utf-8" }
    );
    return output.trim();
  } catch {
    return "";
  }
}

export function getCurrentTmuxSession() {
  try {
    const tmuxPane = process.env.TMUX_PANE;

    // 2. 如果为空（未定义或空字符串），直接返回空输出，避免 grep 匹配全部
    if (!tmuxPane) {
      return null; 
    }
    
    const output = execSync(
      `tmux list-panes -aF '#{pane_id} #{session_name}' | grep ${tmuxPane} | awk '{print $2}'`,
      { encoding: "utf-8" }
    );
    const trimmed = output.trim();
    // 如果 tmux 服务器未运行，返回 null
    if (trimmed.startsWith("no server running on")) {
      return null;
    }
    // 空字符串也视为找不到 session
    return trimmed || null;
  } catch {
    return null;
  }
}

export function killTmuxSession(name) {
  try {
    execSync(`tmux kill-session -t "${name}"`, { stdio: "ignore" });
  } catch {
    // session 可能已经不存在
  }
}

function shellEscape(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
