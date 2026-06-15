"""Read bundled Figma skill documents from names or skill://figma/... URIs."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse


_URI_PREFIX = "skill://figma/"
_SKILL_ROOT = Path(__file__).resolve().parents[1]
_OFFICIAL_SKILLS_ROOT = _SKILL_ROOT / "references" / "official-figma-skills"


class FigmaSkillUriError(ValueError):
    """Raised when a Figma skill URI cannot be resolved safely."""


def _normalize_input(uri_or_name: str) -> str:
    if uri_or_name.startswith(_URI_PREFIX):
        return uri_or_name
    if "://" in uri_or_name:
        raise FigmaSkillUriError(f"Expected URI starting with {_URI_PREFIX!r}: {uri_or_name!r}")
    if "/" in uri_or_name or "\\" in uri_or_name:
        return f"{_URI_PREFIX}{uri_or_name}"
    return f"{_URI_PREFIX}{uri_or_name}/SKILL.md"


def resolve(uri_or_name: str) -> Path:
    """Resolve a skill://figma/... URI or skill name to a bundled plugin-local file path."""
    uri = _normalize_input(uri_or_name)

    parsed = urlparse(uri)
    if parsed.scheme != "skill" or parsed.netloc != "figma":
        raise FigmaSkillUriError(f"Unsupported Figma skill URI: {uri!r}")

    relative_text = unquote(parsed.path.lstrip("/"))
    if not relative_text:
        raise FigmaSkillUriError(f"Missing skill path in URI: {uri!r}")

    relative_path = Path(relative_text)
    if relative_path.is_absolute() or any(part in {"", ".", ".."} for part in relative_path.parts):
        raise FigmaSkillUriError(f"Unsafe skill path in URI: {uri!r}")

    resolved = (_OFFICIAL_SKILLS_ROOT / relative_path).resolve()
    root = _OFFICIAL_SKILLS_ROOT.resolve()

    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise FigmaSkillUriError(f"Resolved path escapes bundled Figma skills: {uri!r}") from exc

    if not resolved.is_file():
        raise FileNotFoundError(f"No bundled Figma skill document for URI {uri!r}: {resolved}")

    return resolved


def read(uri_or_name: str, encoding: str = "utf-8") -> str:
    """Return bundled Figma skill content for a skill://figma/... URI or skill name."""
    return resolve(uri_or_name).read_text(encoding=encoding)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Read bundled Figma skill documents by skill://figma/... URI, relative path, or skill name.",
        epilog=(
            "examples:\n"
            "  python <skill_dir>/scripts/figma_skill_reader.py figma-use\n"
            "  python <skill_dir>/scripts/figma_skill_reader.py figma-use/references/api-reference.md\n"
            "  python <skill_dir>/scripts/figma_skill_reader.py skill://figma/figma-code-connect/SKILL.md\n"
            "  python <skill_dir>/scripts/figma_skill_reader.py figma-use --path\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("uri", help="Figma skill URI or name, for example skill://figma/figma-code-connect/SKILL.md or figma-use")
    parser.add_argument("--path", action="store_true", help="Print the resolved plugin-local path instead of content.")
    args = parser.parse_args()

    try:
        if args.path:
            print(resolve(args.uri))
        else:
            print(read(args.uri), end="")
    except (FigmaSkillUriError, FileNotFoundError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
