#!/usr/bin/env python3
"""Resolve the shared Figma MCP bridge OAuth cache path."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Mapping, NamedTuple


OAUTH_CACHE_FILENAME = ".figma-workspace-oauth.json"


class OAuthCachePath(NamedTuple):
    path: str
    source: str


def resolve_oauth_cache_path(env: Mapping[str, str]) -> OAuthCachePath | None:
    explicit = env.get("FIGMA_WORKSPACE_OAUTH_CACHE_PATH")
    if explicit:
        return OAuthCachePath(explicit, "FIGMA_WORKSPACE_OAUTH_CACHE_PATH")

    codex_home = env.get("CODEX_HOME")
    if codex_home:
        return OAuthCachePath(str(Path(codex_home) / OAUTH_CACHE_FILENAME), "CODEX_HOME")

    userprofile = env.get("USERPROFILE")
    if userprofile:
        return OAuthCachePath(
            str(Path(userprofile) / ".codex" / OAUTH_CACHE_FILENAME),
            "USERPROFILE",
        )

    return None


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Print the Figma MCP bridge OAuth cache path.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print a JSON object with path, source, and exists fields.",
    )
    parser.add_argument(
        "--require-existing",
        action="store_true",
        help="Exit with code 2 if the resolved cache file does not exist.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    resolved = resolve_oauth_cache_path(os.environ)
    if resolved is None:
        print(
            "Unable to resolve Figma MCP OAuth cache path. "
            "Set FIGMA_WORKSPACE_OAUTH_CACHE_PATH, CODEX_HOME, or USERPROFILE.",
            file=sys.stderr,
        )
        return 1

    exists = Path(resolved.path).is_file()
    if args.require_existing and not exists:
        print(f"Resolved OAuth cache file does not exist: {resolved.path}", file=sys.stderr)
        return 2

    if args.json:
        print(
            json.dumps(
                {
                    "path": resolved.path,
                    "source": resolved.source,
                    "exists": exists,
                },
                ensure_ascii=False,
            ),
        )
    else:
        print(resolved.path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
