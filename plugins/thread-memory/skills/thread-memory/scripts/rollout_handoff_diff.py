"""Apply a positional, single-note unified diff to saved text."""

import re

HUNK = re.compile(r"@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(?: .*)?")
NO_NEWLINE = r"\ No newline at end of file"


def apply_handoff_diff(summary: str, patch: str) -> str:
    parts = re.split(r"(\r?\n)", summary) if summary else []
    source = list(zip(parts[::2], parts[1::2] + [""]))
    default_ending = parts[1] if len(parts) > 1 else "\n"
    lines = patch.replace("\r\n", "\n").removesuffix("\n").split("\n")
    index = 0
    git_header = lines[0].startswith("diff --git ")
    if git_header:
        index += 1
        if index < len(lines) and lines[index].startswith("index "):
            index += 1
    if git_header or (index < len(lines) and lines[index].startswith("--- ")):
        if (
            index + 1 >= len(lines)
            or not lines[index].startswith("--- ")
            or not lines[index + 1].startswith("+++ ")
        ):
            raise ValueError("expected unified diff file headers")
        index += 2
    if index == len(lines):
        raise ValueError("expected a unified diff hunk")

    result: list[tuple[str, str]] = []
    source_index = 0
    result_eof = None
    while index < len(lines):
        header = HUNK.fullmatch(lines[index])
        if header is None:
            raise ValueError(f"expected a unified diff hunk at patch line {index + 1}")
        old_number, old_count, new_number, new_count = (
            int(value) if value is not None else 1 for value in header.groups()
        )
        old_start = old_number - bool(old_count)
        new_start = new_number - bool(new_count)
        old_end = old_start + old_count
        if not source_index <= old_start <= old_end <= len(source) or not (old_count or new_count):
            raise ValueError(f"invalid or overlapping source range at patch line {index + 1}")
        result.extend(source[source_index:old_start])
        if new_start != len(result):
            raise ValueError(f"incorrect output range at patch line {index + 1}")
        new_end = new_start + new_count
        source_index = old_start
        index += 1

        while source_index < old_end or len(result) < new_end:
            if index >= len(lines) or lines[index][:1] not in {" ", "-", "+"}:
                raise ValueError(f"expected a unified diff body at patch line {index + 1}")
            prefix, content = lines[index][0], lines[index][1:]
            if prefix != "+":
                if source_index >= old_end:
                    raise ValueError(f"too many source lines at patch line {index + 1}")
                if source[source_index][0] != content:
                    raise ValueError(f"patch does not match summary line {source_index + 1}")
                source_index += 1
            if prefix != "-":
                if len(result) >= new_end:
                    raise ValueError(f"too many output lines at patch line {index + 1}")
                result.append(source[source_index - 1] if prefix == " " else (content, default_ending))
            index += 1

            if index < len(lines) and lines[index] == NO_NEWLINE:
                if prefix != "+" and source_index != len(source):
                    raise ValueError(f"end-of-file marker before last source line at patch line {index + 1}")
                if prefix != "-":
                    if result_eof is not None:
                        raise ValueError(f"repeated output end-of-file marker at patch line {index + 1}")
                    result_eof = len(result)
                index += 1

    result.extend(source[source_index:])
    if result_eof is not None and result_eof != len(result):
        raise ValueError("end-of-file marker before last output line")
    return "".join(
        content + (ending or default_ending) if index < len(result) - 1 else content
        for index, (content, ending) in enumerate(result)
    ).rstrip("\r\n")
