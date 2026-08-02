#!/usr/bin/env bash
# One-shot, idempotent setup for the `rlaude` backend — the Claude Code CLI pointed
# at a self-hosted, Anthropic-compatible endpoint (vLLM on a rented GPU / RunPod).
# Safe to re-run. Secrets are NOT stored in the repo: they live in ~/.config/rlaude.env,
# which this script creates with placeholders for you to edit (or pre-seed via env vars).
#
# Usage:
#   bash scripts/setup-rlaude.sh
#   RLAUDE_BASE_URL=https://... RLAUDE_KEY=... RLAUDE_MODEL=... bash scripts/setup-rlaude.sh
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 1) Where to install the wrapper: next to zlaude if you have it (already on PATH),
#    otherwise ~/.local/bin.
ZLAUDE="$(command -v zlaude 2>/dev/null || true)"
if [ -n "$ZLAUDE" ]; then BINDIR="$(dirname "$ZLAUDE")"; else BINDIR="$HOME/.local/bin"; fi
mkdir -p "$BINDIR"

# 2) The wrapper. The inner env vars are expanded at RUN time by the wrapper, not now
#    (quoted heredoc delimiter), so nothing here needs escaping.
cat > "$BINDIR/rlaude" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ -f "$HOME/.config/rlaude.env" ] && . "$HOME/.config/rlaude.env"
: "${RLAUDE_BASE_URL:?set RLAUDE_BASE_URL in ~/.config/rlaude.env}"
: "${RLAUDE_KEY:?set RLAUDE_KEY in ~/.config/rlaude.env}"
: "${RLAUDE_MODEL:?set RLAUDE_MODEL in ~/.config/rlaude.env}"
export ANTHROPIC_BASE_URL="$RLAUDE_BASE_URL" ANTHROPIC_AUTH_TOKEN="$RLAUDE_KEY"
# A stray ANTHROPIC_API_KEY takes PRECEDENCE over ANTHROPIC_AUTH_TOKEN: it would send the
# wrong auth header to the pod (x-api-key -> 401) or route to real Anthropic. Neutralize it
# loudly, so it shows up in logs instead of causing a silent misroute.
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "rlaude: ignoring a pre-existing ANTHROPIC_API_KEY (it would override the pod token)" >&2
  unset ANTHROPIC_API_KEY
fi
export ANTHROPIC_MODEL="$RLAUDE_MODEL" ANTHROPIC_SMALL_FAST_MODEL="$RLAUDE_MODEL" \
       ANTHROPIC_DEFAULT_HAIKU_MODEL="$RLAUDE_MODEL" ANTHROPIC_DEFAULT_SONNET_MODEL="$RLAUDE_MODEL" \
       ANTHROPIC_DEFAULT_OPUS_MODEL="$RLAUDE_MODEL"
exec claude "$@"
SH
chmod +x "$BINDIR/rlaude"
echo "✓ wrapper: $BINDIR/rlaude"

# 3) Endpoint/key/model — created only if absent (won't clobber your edits). Values come
#    from the environment if you passed them, else placeholders you edit afterwards.
mkdir -p "$HOME/.config"
if [ -f "$HOME/.config/rlaude.env" ]; then
  echo "• kept existing ~/.config/rlaude.env"
else
  cat > "$HOME/.config/rlaude.env" <<ENV
RLAUDE_BASE_URL="${RLAUDE_BASE_URL:-https://YOUR-POD-8000.proxy.runpod.net}"
RLAUDE_KEY="${RLAUDE_KEY:-your-bearer-key}"
RLAUDE_MODEL="${RLAUDE_MODEL:-Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8}"
ENV
  chmod 600 "$HOME/.config/rlaude.env"
  echo "✓ wrote ~/.config/rlaude.env"
fi

# 4) Register rlaude as a ralph backend (config.local.sh is gitignored, so not pulled).
CFG="$HARNESS_DIR/.agents/ralph/config.local.sh"
touch "$CFG"
if grep -q 'AGENT_RLAUDE_CMD' "$CFG"; then
  echo "• AGENT_RLAUDE_CMD already registered in config.local.sh"
else
  cat >> "$CFG" <<'CFG_LINE'
AGENT_RLAUDE_CMD='rlaude -p --dangerously-skip-permissions "$(cat {prompt})"'
CFG_LINE
  echo "✓ registered AGENT_RLAUDE_CMD in config.local.sh"
fi

# 5) PATH check + next steps.
case ":$PATH:" in
  *":$BINDIR:"*) : ;;
  *) echo "! $BINDIR is not on PATH. Add it:  echo 'export PATH=\"$BINDIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
esac
echo "---"
echo "Next: make sure ~/.config/rlaude.env has your real pod URL/key/model, then verify:"
echo "  rlaude -p 'Reply with exactly: RLAUDE OK'"
echo "Use it:  ralph batch --repo <target> --plan <dir> --builder rlaude --reviewer rlaude"
