# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CC-Bridge is a Telegram Bot ↔ Claude Code bridge system that enables remote control of multiple Claude Code sessions via Telegram. It uses tmux for session management and Claude Code hooks for bidirectional communication.

## Development Commands

```bash
# Start the bot (long-running process - do NOT run in background)
npm start

# Run initialization wizard (configures bot token, chat ID, and Claude Code hooks)
npm run init

# Check syntax
node --check src/index.js

# Test hooks manually
node src/hook.js <EventType> < test-data.json
```

## Architecture

This is a **native JavaScript (ES Modules)** project - no TypeScript compilation needed despite .ts references in ARCHITECTURE.md.

### Core Components

- **Bot Process** (src/bot.js): Long-running Telegram bot that listens for messages and injects them into tmux sessions via `tmux send-keys`
- **Hook Scripts** (src/hook.js): Short-lived processes triggered by Claude Code hooks that read stdin JSON and directly call Telegram Bot API
- **Session Manager** (src/session.js): Manages session state in `sessions.json` with CRUD operations
- **tmux Wrapper** (src/tmux.js): Encapsulates all tmux operations (create, send-keys, capture, kill)

### Key Architectural Patterns

**No HTTP Server**: Hook scripts are standalone Node.js processes that read configuration from `~/.cc-bridge/.env` and call Telegram API directly. They don't communicate with the bot process.

**Data Flow**:
- TG → Claude: User sends message → Bot receives → `tmux send-keys` injects into Claude Code terminal
- Claude → TG: Claude Code triggers hook → `node hook.js` reads stdin → Directly calls Telegram Bot API

**Session Identification**: Sessions are tracked by:
- Numeric ID (user-facing, e.g., `1`, `2`)
- tmux name (e.g., `cc-bridge-1`)
- Claude session ID (UUID, optional, for resuming sessions)

### Permission Handling

The bot detects single-character permission responses (`y`, `a`, `n`) and translates them to tmux special keys:
- `y` → Enter (yes)
- `a` → Down + Enter (always)
- `n` → Up + Enter (no)

This allows users to respond to Claude Code permission prompts via Telegram.

## Configuration Files

- `~/.cc-bridge/.env`: Bot token and chat ID (created by `npm run init`)
- `~/.claude/settings.json`: Claude Code hooks configuration (auto-configured by init)
- `sessions.json`: Session state persistence (auto-generated)

## Hook Events

Claude Code hooks are configured to trigger `src/hook.js` with event type as argument:
- `Notification`: Permission requests, idle prompts → forwarded to Telegram
- `SessionStart`: New session ready → sends "✅ 新会话已就绪" notification
- `Stop`: Claude completes response → captures screen and sends summary

Hook scripts read JSON from stdin containing event data (session ID, message content, etc.).

## tmux Conventions

- Session naming: `cc-bridge-<id>` (e.g., `cc-bridge-1`)
- Sessions created with fixed dimensions: `-x 200 -y 50`
- Text injection uses `-l` flag for literal character-by-character sending
- Special keys (Enter, Up, Down) sent separately for permission handling

## Session State Management

Sessions have these statuses:
- `starting`: tmux session created, Claude Code initializing
- `active`: Claude Code running and responsive
- `idle`: No recent activity
- `stopped`: tmux session terminated

The `syncSessionStates()` function checks tmux session existence and updates status accordingly. Call this before operations that depend on session state.

## Important Implementation Details

- **Shell escaping**: tmux commands use custom `shellEscape()` function that wraps in single quotes and escapes embedded quotes
- **Async delays**: Session creation includes strategic delays (2s, 300ms, 1s) to allow Claude Code initialization
- **Auto-startup**: In "auto" permission mode, the bot automatically sends Down+Enter to bypass initial permission prompt
- **Chat ID whitelist**: Bot only responds to the configured CHAT_ID for security
- **Session cleanup**: `/close` command kills tmux session AND removes from sessions.json

## Testing

Test files in root directory demonstrate hook behavior:
- `test-hook.js`: Basic hook testing
- `test-hook-complete.js`: Stop hook testing
- `test-session-start.js`: SessionStart hook testing

Run hooks manually: `node src/hook.js <EventType> < test-data.json`

## Common Patterns

When modifying session operations:
1. Load state with `loadState()`
2. Perform modifications
3. Save with `saveState(state)`
4. Sync tmux state with `syncSessionStates()` if needed

When adding new bot commands:
1. Register with `bot.command("name", handler)`
2. Check chat ID authorization (handled by middleware)
3. Sync session states before reading session data
4. Use inline keyboards for confirmations (see `/close` command)

When working with tmux:
- Always check session existence with `tmuxSessionExists()` before operations
- Use `tmuxSendKeys()` for text, `tmuxSendSpecialKey()` for control keys
- Escape session names in shell commands with quotes
