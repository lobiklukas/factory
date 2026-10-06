#!/usr/bin/env python3
"""Write the project config `opencode run` needs for one ralph iteration (RALPH_AGENT=opencode).

`.pi/agents/ralph-*.md` stays the single source of truth for the subagent roles: this script turns each
file's pi frontmatter (`tools:`, `description:`, ...) and body into an OpenCode V2 `agents` entry, pinned to
the model the iteration runs on, so a fallback model also moves the subagents. It also

- registers the Linear MCP server (`mcp.servers.linear`, direct `linear_*` tools, not Code Mode),
- disables every MCP server the user's global config would otherwise connect (a GitHub token, Figma,
  a browser: none of them belong in an unattended loop's context), and
- adds the repo's skills directories, so `effect`, `tdd` and `verify-*` resolve as they do under pi.

Usage: opencode-config.py --agents-dir DIR --model PROVIDER/MODEL --out FILE [--skills DIR ...]
       [--global-config FILE]
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

# pi tool name -> the OpenCode V2 permission action that covers it
TOOL_ACTIONS = {
    "read": "read",
    "ls": "read",
    "find": "glob",
    "grep": "grep",
    "bash": "shell",
    "edit": "edit",
    "write": "edit",
    "web_search": "websearch",
    "source_check": "websearch",
    "fetch_content": "webfetch",
    "get_search_content": "webfetch",
}


def split_frontmatter(text):
    """(frontmatter dict of str -> str, body) for a `---` delimited markdown file."""
    match = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not match:
        return {}, text
    meta = {}
    for line in match.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep:
            meta[key.strip()] = value.strip()
    return meta, match.group(2).lstrip("\n")


def permissions(tools):
    """Deny everything, then allow what the pi `tools:` line names. A subagent never spawns subagents."""
    rules = [{"action": "*", "resource": "*", "effect": "deny"}]
    for action in sorted({TOOL_ACTIONS[t] for t in tools if t in TOOL_ACTIONS}):
        rules.append({"action": action, "resource": "*", "effect": "allow"})
    rules.append({"action": "skill", "resource": "*", "effect": "allow"})
    # `ask` is auto-approved by `opencode run --auto`; a bare deny would block reading outside the worktree.
    rules.append({"action": "external_directory", "resource": "*", "effect": "ask"})
    return rules


def agents_from(directory, model):
    agents = {}
    for path in sorted(Path(directory).glob("ralph-*.md")):
        meta, body = split_frontmatter(path.read_text())
        tools = [t.strip() for t in meta.get("tools", "").split(",") if t.strip()]
        agents[meta.get("name", path.stem)] = {
            "description": meta.get("description", path.stem),
            "mode": "subagent",
            "model": model,
            "system": body,
            "permissions": permissions(tools),
        }
    return agents


def global_mcp_names(config_path):
    """Server names in the user's global config, in either the V1 (`mcp.<name>`) or V2 (`mcp.servers`) shape."""
    try:
        data = json.loads(Path(config_path).expanduser().read_text())
    except (OSError, ValueError):
        return []
    mcp = data.get("mcp") or {}
    servers = mcp.get("servers") if isinstance(mcp.get("servers"), dict) else mcp
    return [name for name, value in servers.items() if isinstance(value, dict)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--agents-dir", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--skills", action="append", default=[])
    parser.add_argument("--global-config", default="~/.config/opencode/opencode.json")
    args = parser.parse_args()

    # A higher-precedence server of the same name replaces the whole global object, so a disabled stub is
    # enough; it never connects.
    servers = {
        name: {"type": "local", "command": ["true"], "disabled": True}
        for name in global_mcp_names(args.global_config)
        if name != "linear"
    }
    servers["linear"] = {"type": "remote", "url": "https://mcp.linear.app/mcp", "codemode": False}

    config = {
        "$schema": "https://opencode.ai/config.json",
        "model": args.model,
        "default_agent": "build",
        "mcp": {"servers": servers},
        "skills": [s for s in args.skills if os.path.isdir(s)],
        "agents": agents_from(args.agents_dir, args.model),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(config, indent=2) + "\n")


if __name__ == "__main__":
    sys.exit(main())
