---
name: fresh-context
description: Save a handoff snapshot and copy it to the clipboard so you can /clear and paste into the new session without losing context.
---

## What this does

1. Runs `./scripts/fresh-context "$ARGUMENTS"` to generate a paste-ready resume prompt at `.ai-session/resume/latest.md` (session_id scoped, multi-terminal safe).
2. Copies the snapshot contents to your clipboard via `pbcopy` (macOS) / `xclip` (Linux) / `clip` (Windows via WSL).
3. Prints the exact next steps so you don't have to think.

## Do this

Run the command, then print the output verbatim for the user. Do NOT add commentary or context after — the user's next action is `/clear` followed by `Cmd+V`.

```bash
!{
  set -e
  ROOT="$(pwd)"
  # Generate the snapshot (passes any inline note from $ARGUMENTS)
  if [ -n "$ARGUMENTS" ]; then
    "$ROOT/scripts/fresh-context" "$ARGUMENTS"
  else
    "$ROOT/scripts/fresh-context"
  fi

  SNAPSHOT="$ROOT/.ai-session/resume/latest.md"
  if [ ! -f "$SNAPSHOT" ]; then
    echo "ERROR: snapshot not created at $SNAPSHOT" >&2
    exit 1
  fi

  # Copy to clipboard — detect the tool
  COPIED=""
  if command -v pbcopy >/dev/null 2>&1; then
    pbcopy < "$SNAPSHOT" && COPIED="pbcopy"
  elif command -v xclip >/dev/null 2>&1; then
    xclip -selection clipboard < "$SNAPSHOT" && COPIED="xclip"
  elif command -v xsel >/dev/null 2>&1; then
    xsel --clipboard --input < "$SNAPSHOT" && COPIED="xsel"
  elif command -v clip.exe >/dev/null 2>&1; then
    clip.exe < "$SNAPSHOT" && COPIED="clip.exe"
  fi

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if [ -n "$COPIED" ]; then
    echo "✓ Snapshot copied to clipboard (${COPIED})"
  else
    echo "⚠ Could not auto-copy. Manually copy:"
    echo "  cat $SNAPSHOT | pbcopy"
  fi
  echo ""
  echo "NEXT STEPS:"
  echo "  1. Type  /clear   (Claude Code clears the conversation)"
  echo "  2. Press Cmd+V    (pastes the snapshot as your first prompt)"
  echo "  3. Press Enter    (Claude reads the snapshot and continues)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}
```

After the bash block runs, your ONLY response to the user should be the exact NEXT STEPS block printed above — no elaboration, no summary. The user is about to type `/clear` so anything you say after will be wiped anyway.
