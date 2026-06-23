# pi-warden

A [pi](https://github.com/earendil-works/pi) extension that blocks or gates tool calls based on configurable command-content and path-containment rules. Think of it as a static guardrail layer — it intercepts every `tool_call` before execution and enforces your rules.

## Install

```bash
pi install git:github.com/A7exSchin/pi-warden
```

Then create your config file:

```bash
cp ~/.pi/agent/git/github.com/A7exSchin/pi-warden/pi-warden.rules.example.json \
   ~/.pi/agent/pi-warden.rules.json
```

Edit `~/.pi/agent/pi-warden.rules.json` to your needs. The extension loads on next pi startup.

## What it does

pi-warden evaluates every tool call against two rule sections:

### Commands

Content rules matched against the `command` field of `bash` calls.

- **Match modes:** `substring` or `regex`, with optional `case_sensitive` flag.
- **Precedence:** block-wins — if any matching rule blocks, the call is blocked.
- **Default:** `"allow"` = blacklist (block only listed patterns); `"block"` = whitelist (allow only listed patterns).

### Paths

Directory-containment rules matched against filesystem paths in `read`/`write`/`edit` and paths extracted from `bash` commands.

- **Containment:** each rule specifies a `dir` (resolved via `~`, `..`, symlinks). A path is "under" that dir if it equals it or is a descendant.
- **Precedence:** longest-prefix wins — the most specific directory decides, enabling carve-outs (e.g. block `~/.ssh` but allow `~/.ssh/known_hosts`).
- **Scope (`on`):** `"read"`, `"write"`, or `"any"` (default). Enables read/write asymmetry — block writes to a directory while allowing reads.
- **Actions:** `"block"`, `"allow"`, or `"confirm"` (interactive prompt; fails closed without a UI).

### Cross-section logic

A call is blocked if **either** section blocks it. Commands are evaluated first; path evaluation is skipped if commands already block.

## Config

Config lives at `~/.pi/agent/pi-warden.rules.json` (override with env `PI_WARDEN_RULES`).

```json
{
  "commands": {
    "default": "allow",
    "rules": [
      {
        "id": "no-rm-rf",
        "match": "substring",
        "value": "rm -rf",
        "case_sensitive": false,
        "action": "block",
        "reason": "Recursive force-delete is reserved for the user."
      }
    ]
  },
  "paths": {
    "default": "allow",
    "rules": [
      {
        "id": "ssh-dir",
        "dir": "~/.ssh",
        "on": "any",
        "action": "block",
        "reason": "SSH directory is off-limits."
      },
      {
        "id": "config-readonly",
        "dir": "~/project/_core",
        "on": "write",
        "action": "confirm",
        "reason": "Writes to the rulebook require your confirmation."
      }
    ]
  }
}
```

### Command rule fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique rule identifier |
| `match` | yes | `"substring"` or `"regex"` |
| `value` | yes | The pattern to match against the bash command |
| `case_sensitive` | no | Default: `false` |
| `action` | no | `"block"` or `"allow"`. Default: opposite of section `default` |
| `reason` | no | Message shown when the rule fires |
| `enabled` | no | Set `false` to disable without removing |

### Path rule fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique rule identifier |
| `dir` | yes | Directory or file path (`~` expanded, symlinks resolved) |
| `on` | no | `"read"`, `"write"`, or `"any"` (default) |
| `action` | no | `"block"`, `"allow"`, or `"confirm"`. Default: opposite of section `default` |
| `reason` | no | Message shown when the rule fires |
| `enabled` | no | Set `false` to disable without removing |

## Commands

```
/pi-warden              Show status
/pi-warden status       Show status
/pi-warden list         List all rules with state
/pi-warden reload       Re-read config from disk
/pi-warden governance unlock   Bypass path protections for this session
/pi-warden governance lock     Re-enable path protections
/pi-warden governance          Show governance state
```

**Governance unlock** bypasses all path rules (block + confirm) for the session. Command rules still apply. Resets on `/reload` or restart.

## Scope limits

- **bash is arbitrary shell.** Path extraction is best-effort (splits on whitespace/shell metacharacters, keeps tokens with `/` or `~`). Obfuscation via `$HOME`, variables, base64, or quote-splitting is not caught.
- **Block messages are instructions, not true enforcement.** A sufficiently adversarial prompt injection could ignore them. True isolation requires a container or separate OS user.
- **`confirm` requires an interactive UI.** Headless / `-p` mode fails closed with a message directing the user to governance unlock.

## License

MIT
