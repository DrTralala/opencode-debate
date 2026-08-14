#!/usr/bin/env python3
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import html
import errno
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Sequence


class TranscriptError(ValueError):
    """Raised when a Markdown transcript violates the persisted schema."""


@dataclass(frozen=True)
class ParticipantTurn:
    number: int
    agent: str
    text: str
    consensus_reached: bool | None
    recommend_stopping: bool | None


@dataclass(frozen=True)
class DebateRound:
    number: int
    turns: tuple[ParticipantTurn, ParticipantTurn, ParticipantTurn]


@dataclass(frozen=True)
class Transcript:
    title: str
    date: str
    topic: str
    maximum_rounds: int
    rounds_completed: int
    participants: tuple[tuple[int, str], tuple[int, str], tuple[int, str]]
    consensus_reached: str
    rounds: tuple[DebateRound, ...]
    extension_decisions: str | None
    json_parsing_problems: str | None
    final_synthesis: str


@dataclass(frozen=True)
class RenderedContent:
    rounds: tuple[tuple[str, str, str], ...]
    extension_decisions: str | None
    json_parsing_problems: str | None
    final_synthesis: str


MARKDOWN_HELPER_PATH = Path(__file__).with_name("render_markdown.mjs")


TITLE_RE = re.compile(r"^# Debate: (.+)$")
METADATA_RE = re.compile(r"^\*\*([^*]+):\*\*\s*(.+)$")
TOPIC_METADATA_RE = re.compile(r"^\*\*Topic:\*\*\s*(.*)$")
TOPIC_BLOCK_BEGIN_RE = re.compile(r"^<!-- BEGIN TOPIC (\S+) -->$")
TOPIC_BLOCK_MARKER_INTENT_RE = re.compile(
    r"^<!--\s*(?:BEGIN|END) TOPIC(?:\s|-->|$)"
)
ROUND_RE = re.compile(r"^## Round ([1-9][0-9]*)$")
PARTICIPANT_RE = re.compile(r"^### Participant ([1-3]) \(([^)]+)\)$")
STATUS_RE = re.compile(
    r"^- \*\*(consensus_reached|recommend_stopping):\*\* (true|false)$"
)
REQUIRED_METADATA = (
    "Date",
    "Topic",
    "Maximum rounds",
    "Rounds completed",
    "Participants",
    "Consensus reached",
)


def _nonempty(text: str, field: str) -> str:
    value = text.strip()
    if not value:
        raise TranscriptError(f"{field} must not be empty")
    return value


def _parse_positive_int(value: str, field: str) -> int:
    if not re.fullmatch(r"[1-9][0-9]*", value):
        raise TranscriptError(f"{field} must be a positive integer")
    return int(value)


def _parse_participants(
    value: str,
) -> tuple[tuple[int, str], tuple[int, str], tuple[int, str]]:
    matches = re.findall(r"Participant ([1-3]) \(([^)]+)\)", value)
    if len(matches) != 3 or [int(number) for number, _ in matches] != [1, 2, 3]:
        raise TranscriptError("Participants metadata must list Participants 1, 2, and 3")
    expected = ", ".join(
        f"Participant {number} ({agent})" for number, agent in matches
    )
    if value != expected:
        raise TranscriptError("Participants metadata has invalid text")
    return tuple(
        (int(number), agent) for number, agent in matches
    )  # type: ignore[return-value]


def _starts_section(lines: list[str], index: int) -> bool:
    if lines[index] != "---":
        return False
    heading = index + 1
    while heading < len(lines) and not lines[heading].strip():
        heading += 1
    return heading < len(lines) and lines[heading].startswith("## ")


def _has_topic_block_marker_intent(line: str) -> bool:
    return TOPIC_BLOCK_MARKER_INTENT_RE.match(line.strip()) is not None


def _parse_topic(lines: list[str], index: int, inline_value: str) -> tuple[str, int]:
    begin_match = TOPIC_BLOCK_BEGIN_RE.fullmatch(inline_value)
    topic_start = index + 1
    if begin_match is None and not inline_value:
        marker_index = topic_start
        while marker_index < len(lines) and not lines[marker_index].strip():
            marker_index += 1
        if marker_index < len(lines):
            begin_match = TOPIC_BLOCK_BEGIN_RE.fullmatch(lines[marker_index])
            if begin_match is not None:
                topic_start = marker_index + 1

    if begin_match is not None:
        end_marker = f"<!-- END TOPIC {begin_match.group(1)} -->"
        topic_end = topic_start
        while topic_end < len(lines):
            if lines[topic_end] == end_marker:
                topic = "\n".join(lines[topic_start:topic_end])
                if not topic.strip():
                    raise TranscriptError("Topic must not be empty")
                return topic, topic_end + 1
            if _has_topic_block_marker_intent(lines[topic_end]):
                raise TranscriptError(
                    "Topic block contains a malformed or mismatched marker"
                )
            topic_end += 1
        raise TranscriptError("Topic block is missing its matching end marker")

    if _has_topic_block_marker_intent(inline_value):
        raise TranscriptError("Topic block begin marker is malformed")

    topic_lines = [inline_value]
    index += 1
    while index < len(lines):
        if _starts_section(lines, index) or METADATA_RE.fullmatch(lines[index]):
            break
        if _has_topic_block_marker_intent(lines[index]):
            raise TranscriptError("Topic block marker has no valid begin marker")
        topic_lines.append(lines[index])
        index += 1
    return _nonempty("\n".join(topic_lines), "Topic"), index


def _parse_metadata(lines: list[str]) -> tuple[dict[str, str], int]:
    metadata: dict[str, str] = {}
    index = 1
    while index < len(lines) and not _starts_section(lines, index):
        topic_match = TOPIC_METADATA_RE.fullmatch(lines[index])
        if topic_match is not None:
            if "Topic" in metadata:
                raise TranscriptError("Duplicate metadata: Topic")
            metadata["Topic"], index = _parse_topic(
                lines, index, topic_match.group(1)
            )
            continue
        match = METADATA_RE.fullmatch(lines[index])
        if match is not None:
            field = match.group(1)
            if field == "Date" and field in metadata:
                raise TranscriptError(f"Duplicate metadata: {field}")
            metadata[field] = match.group(2).strip()
        index += 1
    for field in REQUIRED_METADATA:
        if field not in metadata:
            raise TranscriptError(f"Missing required metadata: {field}")
    return metadata, index


def _sections(lines: list[str]) -> list[tuple[str, int, int]]:
    headings: list[tuple[str, int]] = []
    for index, line in enumerate(lines):
        if not line.startswith("## "):
            continue
        previous = index - 1
        while previous >= 0 and not lines[previous].strip():
            previous -= 1
        if previous >= 0 and lines[previous] == "---":
            headings.append((line, index))
    if not headings:
        raise TranscriptError("Transcript has no round or synthesis sections")
    return [
        (
            heading,
            start,
            headings[index + 1][1] if index + 1 < len(headings) else len(lines),
        )
        for index, (heading, start) in enumerate(headings)
    ]


def _without_trailing_separator(lines: list[str]) -> list[str]:
    body = list(lines)
    while body and not body[-1].strip():
        body.pop()
    if body and body[-1] == "---":
        body.pop()
        while body and not body[-1].strip():
            body.pop()
    return body


def _parse_turn(
    number: int, agent: str, round_number: int, body: list[str]
) -> ParticipantTurn:
    while body and not body[0].strip():
        body.pop(0)
    statuses: dict[str, bool] = {}
    while body:
        match = STATUS_RE.fullmatch(body[0])
        if match is None:
            break
        statuses[match.group(1).lower()] = match.group(2).lower() == "true"
        body.pop(0)
    while body and not body[0].strip():
        body.pop(0)
    text = _nonempty(
        "\n".join(body), f"Participant {number} round {round_number} turn"
    )
    if round_number == 1:
        if statuses:
            raise TranscriptError("Round 1 must not contain consensus status fields")
        consensus = recommend = None
    else:
        for field in ("consensus_reached", "recommend_stopping"):
            if field not in statuses:
                raise TranscriptError(
                    f"Participant {number} round {round_number} is missing {field}"
                )
        consensus = statuses["consensus_reached"]
        recommend = statuses["recommend_stopping"]
    return ParticipantTurn(number, agent, text, consensus, recommend)


def _parse_round(round_number: int, lines: list[str]) -> DebateRound:
    headings = [
        (index, PARTICIPANT_RE.fullmatch(line)) for index, line in enumerate(lines)
    ]
    participant_headings = [
        (index, match) for index, match in headings if match is not None
    ]
    if len(participant_headings) != 3:
        raise TranscriptError(
            f"Round {round_number} must contain exactly three participants"
        )
    turns: list[ParticipantTurn] = []
    for offset, (start, match) in enumerate(participant_headings):
        assert match is not None
        number = int(match.group(1))
        if number != offset + 1:
            raise TranscriptError(
                f"Round {round_number} participant headings must be ordered 1, 2, 3"
            )
        end = (
            participant_headings[offset + 1][0]
            if offset + 1 < 3
            else len(lines)
        )
        turns.append(
            _parse_turn(number, match.group(2), round_number, lines[start + 1 : end])
        )
    return DebateRound(round_number, tuple(turns))  # type: ignore[arg-type]


DATE_ONLY_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
LEGACY_DATE_RE = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}(?::|-)[0-9]{2}(?::|-)[0-9]{2}Z"
)


def parse_transcript(
    markdown: str,
    *,
    date_only: bool = False,
    expected_date: str | None = None,
) -> Transcript:
    lines = markdown.splitlines()
    if not lines:
        raise TranscriptError("Transcript is empty")
    title_match = TITLE_RE.fullmatch(lines[0])
    if title_match is None:
        raise TranscriptError("Transcript must start with '# Debate: <title>'")

    metadata, metadata_end = _parse_metadata(lines)
    lines = lines[metadata_end:]
    section_list = _sections(lines)

    maximum_rounds = _parse_positive_int(
        metadata["Maximum rounds"], "Maximum rounds"
    )
    rounds_completed = _parse_positive_int(
        metadata["Rounds completed"], "Rounds completed"
    )
    rounds: list[DebateRound] = []
    optional: dict[str, str] = {}
    final_synthesis: str | None = None
    seen_non_round = False
    for section_index, (heading, start, end) in enumerate(section_list):
        round_match = ROUND_RE.fullmatch(heading)
        body = lines[start + 1 : end]
        if section_index < len(section_list) - 1:
            body = _without_trailing_separator(body)
        if round_match:
            if seen_non_round:
                raise TranscriptError(
                    "Round sections must precede optional and synthesis sections"
                )
            rounds.append(_parse_round(int(round_match.group(1)), body))
        elif heading in ("## Extension Decisions", "## JSON Parsing Problems"):
            seen_non_round = True
            if heading in optional:
                raise TranscriptError(
                    f"Transcript contains multiple {heading.removeprefix('## ')} sections"
                )
            optional[heading] = _nonempty(
                "\n".join(body), heading.removeprefix("## ")
            )
        elif heading == "## Final Synthesis":
            seen_non_round = True
            if final_synthesis is not None:
                raise TranscriptError(
                    "Transcript contains multiple Final Synthesis sections"
                )
            if section_index != len(section_list) - 1:
                raise TranscriptError("Final Synthesis must be the last section")
            final_synthesis = _nonempty("\n".join(body), "Final Synthesis")
        else:
            raise TranscriptError(f"Unsupported level-two section: {heading}")

    expected_rounds = list(range(1, len(rounds) + 1))
    if [round_.number for round_ in rounds] != expected_rounds:
        raise TranscriptError("Transcript round headings must be contiguous from 1")
    if len(rounds) != rounds_completed:
        raise TranscriptError("Rounds completed metadata does not match round sections")
    if final_synthesis is None:
        raise TranscriptError("Missing Final Synthesis section")

    date_pattern = DATE_ONLY_RE if date_only else re.compile(
        rf"(?:{LEGACY_DATE_RE.pattern}|{DATE_ONLY_RE.pattern}(?!T))"
    )
    if date_pattern.fullmatch(metadata["Date"]) is None:
        raise TranscriptError(
            "Date must be a UTC YYYY-MM-DD value"
            if date_only
            else "Date must be a UTC YYYY-MM-DD value or legacy timestamp"
        )
    if expected_date is not None and metadata["Date"] != expected_date:
        raise TranscriptError(f"Date must equal expected UTC date {expected_date}")

    participants = _parse_participants(metadata["Participants"])
    for round_ in rounds:
        if [(turn.number, turn.agent) for turn in round_.turns] != list(participants):
            raise TranscriptError(
                f"Round {round_.number} participants do not match metadata"
            )

    return Transcript(
        title=_nonempty(title_match.group(1), "Title"),
        date=metadata["Date"],
        topic=metadata["Topic"],
        maximum_rounds=maximum_rounds,
        rounds_completed=rounds_completed,
        participants=participants,
        consensus_reached=metadata["Consensus reached"],
        rounds=tuple(rounds),
        extension_decisions=optional.get("## Extension Decisions"),
        json_parsing_problems=optional.get("## JSON Parsing Problems"),
        final_synthesis=final_synthesis,
    )


AGENT_LABELS = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "glm": "GLM",
    "kimi": "Kimi",
    "qwen": "Qwen",
}


def _agent_label(agent: str) -> str:
    suffix = agent.removeprefix("debate-")
    return AGENT_LABELS.get(suffix, suffix.replace("-", " ").title())


def _escaped(value: str) -> str:
    return html.escape(value, quote=True)


def render_markdown_items(
    items: Sequence[str], helper_path: Path = MARKDOWN_HELPER_PATH
) -> tuple[str, ...]:
    payload = json.dumps({"items": list(items)}, ensure_ascii=False)
    try:
        completed = subprocess.run(
            ["node", str(helper_path)],
            input=payload,
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise TranscriptError(f"Markdown renderer could not start: {error}") from error
    if completed.returncode != 0:
        detail = completed.stderr.strip() or f"exit status {completed.returncode}"
        raise TranscriptError(f"Markdown renderer failed: {detail}")
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise TranscriptError("Markdown renderer returned invalid JSON") from error
    if not isinstance(response, dict) or not isinstance(response.get("html"), list):
        raise TranscriptError("Markdown renderer returned an invalid output shape")
    rendered = response["html"]
    if any(not isinstance(item, str) for item in rendered):
        raise TranscriptError("Markdown renderer returned a non-string item")
    if len(rendered) != len(items):
        raise TranscriptError("Markdown renderer returned the wrong item count")
    return tuple(rendered)


def _render_content(transcript: Transcript) -> RenderedContent:
    source_items = [
        turn.text for round_ in transcript.rounds for turn in round_.turns
    ]
    if transcript.extension_decisions is not None:
        source_items.append(transcript.extension_decisions)
    if transcript.json_parsing_problems is not None:
        source_items.append(transcript.json_parsing_problems)
    source_items.append(transcript.final_synthesis)

    rendered = iter(render_markdown_items(source_items))
    rounds = tuple(
        tuple(next(rendered) for _ in round_.turns)
        for round_ in transcript.rounds
    )
    extension_decisions = (
        next(rendered) if transcript.extension_decisions is not None else None
    )
    json_parsing_problems = (
        next(rendered) if transcript.json_parsing_problems is not None else None
    )
    final_synthesis = next(rendered)
    return RenderedContent(
        rounds=rounds,  # type: ignore[arg-type]
        extension_decisions=extension_decisions,
        json_parsing_problems=json_parsing_problems,
        final_synthesis=final_synthesis,
    )


def _badge(label: str, value: bool) -> str:
    css_class = "badge-ok" if value else "badge-no"
    state = "Yes" if value else "No"
    return f'<span class="{css_class}">{label}: {state}</span>'


def _round_rows(round_: DebateRound, rendered_turns: Sequence[str]) -> str:
    if round_.number == 1:
        cells = "".join(
            f'<td><div class="markdown-body">{turn_html}</div></td>'
            for turn_html in rendered_turns
        )
        return f'<tr class="turn-row"><th scope="row">1</th>{cells}</tr>'
    status_cells = "".join(
        "<td>"
        + _badge("Consensus", bool(turn.consensus_reached))
        + " "
        + _badge("Stop", bool(turn.recommend_stopping))
        + "</td>"
        for turn in round_.turns
    )
    turn_cells = "".join(
        f'<td><div class="markdown-body">{turn_html}</div></td>'
        for turn_html in rendered_turns
    )
    return (
        f'<tr class="turn-row"><th scope="row" rowspan="2">{round_.number}</th>'
        f"{turn_cells}</tr>"
        f'<tr class="status-row">{status_cells}</tr>'
    )


def _optional_section(title: str, value: str | None) -> str:
    if value is None:
        return ""
    return (
        f'<section class="detail-section"><h2>{title}</h2>'
        f'<div class="markdown-body">{value}</div></section>'
    )


def render_html(transcript: Transcript) -> str:
    content = _render_content(transcript)
    headers = "".join(
        f'<th>Participant {number}<span class="agent-name">'
        f"{_escaped(_agent_label(agent))}</span></th>"
        for number, agent in transcript.participants
    )
    rows = "".join(
        _round_rows(round_, rendered_turns)
        for round_, rendered_turns in zip(transcript.rounds, content.rounds)
    )
    metadata = (
        f"<dt>Date</dt><dd>{_escaped(transcript.date)}</dd>"
        f"<dt>Maximum rounds</dt><dd>{transcript.maximum_rounds}</dd>"
        f"<dt>Rounds completed</dt><dd>{transcript.rounds_completed}</dd>"
        f"<dt>Consensus reached</dt><dd>{_escaped(transcript.consensus_reached)}</dd>"
    )
    extensions = _optional_section(
        "Extension Decisions", content.extension_decisions
    )
    problems = _optional_section(
        "JSON Parsing Problems", content.json_parsing_problems
    )
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Debate: {_escaped(transcript.title)}</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; padding: 16px; background: #1b1e21; color: #dee2e6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.5; }}
  h1 {{ margin-top: 0; padding-bottom: 8px; border-bottom: 2px solid #495057; font-size: 1.5rem; }}
  h2 {{ margin-top: 1.5rem; font-size: 1.25rem; }}
  .metadata, .detail-section, .summary-section {{ margin: 12px 0; padding: 12px 16px; border: 1px solid #495057; border-radius: 6px; background: #212529; }}
  .metadata dl {{ display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }}
  .metadata dt {{ font-weight: 600; }}
  .metadata dd {{ margin: 0; }}
  .topic-box {{ margin: 12px 0; padding: 12px 16px; border: 1px solid #997404; border-radius: 6px; background: #332701; white-space: pre-wrap; }}
  .debate-table {{ width: 100%; table-layout: fixed; border-collapse: collapse; margin: 16px 0; }}
  .round-column {{ width: 3rem; }}
  .participant-column {{ width: calc((100% - 3rem) / 3); }}
  .debate-table > thead > tr > th, .debate-table > tbody > tr > th, .debate-table > tbody > tr > td {{ border: 1px solid #495057; padding: 10px 12px; vertical-align: top; }}
  .debate-table > thead > tr > th, .debate-table > tbody > tr > th {{ background: #343a40; color: #fff; text-align: center; font-size: 0.85rem; }}
  .debate-table > tbody > tr > td {{ background: #212529; font-size: 0.85rem; }}
  .agent-name {{ display: block; color: #adb5bd; font-size: 0.75rem; font-weight: 400; }}
  .debate-table .status-row > td {{ background: #2b3035; text-align: center; }}
  .markdown-body {{ overflow-wrap: anywhere; }}
  .markdown-body > :first-child {{ margin-top: 0; }}
  .markdown-body > :last-child {{ margin-bottom: 0; }}
  .markdown-body pre {{ overflow-x: auto; padding: 10px; border-radius: 4px; background: #16191c; }}
  .markdown-body code {{ font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }}
  .markdown-body :not(pre) > code {{ padding: 1px 4px; border-radius: 3px; background: #343a40; }}
  .markdown-body a {{ color: #6ea8fe; }}
  .markdown-body table {{ width: 100%; border-collapse: collapse; margin: 8px 0; }}
  .markdown-body th, .markdown-body td {{ border: 1px solid #495057; padding: 6px 8px; text-align: left; }}
  .badge-ok, .badge-no {{ display: inline-block; padding: 1px 6px; border-radius: 3px; color: #fff; font-size: 0.75rem; font-weight: 600; }}
  .badge-ok {{ background: #198754; }}
  .badge-no {{ background: #dc3545; }}
  .summary-section {{ padding: 16px; }}
  .summary-section h2, .detail-section h2 {{ margin-top: 0; }}
</style>
</head>
<body>
<h1>Debate: {_escaped(transcript.title)}</h1>
<section class="metadata"><dl>{metadata}</dl></section>
<div class="topic-box"><strong>Topic:</strong> {_escaped(transcript.topic)}</div>
<h2>Debate Rounds</h2>
<table class="debate-table">
<colgroup><col class="round-column"><col class="participant-column"><col class="participant-column"><col class="participant-column"></colgroup>
<thead><tr><th>Rd</th>{headers}</tr></thead>
<tbody>{rows}</tbody>
</table>
{extensions}{problems}
<section class="summary-section"><h2>Final Synthesis</h2><div class="markdown-body">{content.final_synthesis}</div></section>
</body>
</html>
'''


LEGACY_TRANSCRIPT_RE = re.compile(
    r"^(?P<date>[0-9]{4}-[0-9]{2}-[0-9]{2})T"
    r"(?P<time>[0-9]{2}-[0-9]{2}-[0-9]{2})Z-(?P<slug>.+)\.md$"
)
DATE_ONLY_TRANSCRIPT_RE = re.compile(
    r"^(?P<date>[0-9]{4}-[0-9]{2}-[0-9]{2})-(?P<rest>.+)\.md$"
)


def _ensure_trusted_debates_root(cwd: Path) -> Path:
    absolute_cwd = cwd if cwd.is_absolute() else Path.cwd() / cwd
    current = Path(absolute_cwd.anchor)
    for component in absolute_cwd.parts[1:]:
        current /= component
        if current.is_symlink():
            raise TranscriptError("Project directory path components must not be symlinks")
    if absolute_cwd.is_symlink():
        raise TranscriptError("Project directory must not be a symlink")
    root = absolute_cwd / "docs" / "debates"
    for component in (absolute_cwd / "docs", root):
        try:
            if component.is_symlink():
                raise TranscriptError(
                    "Transcript directory path components must not be symlinks"
                )
        except OSError as error:
            raise TranscriptError(f"Could not inspect transcript directory: {error}") from error
    return root.resolve()


def _date_only_key(path: Path, names: set[str]) -> tuple[tuple[int, ...], str, int]:
    match = DATE_ONLY_TRANSCRIPT_RE.fullmatch(path.name)
    assert match is not None
    date = tuple(int(value) for value in match.group("date").split("-"))
    rest = match.group("rest")
    suffix = 1
    stem = rest
    if "-" in rest:
        prefix, candidate = rest.rsplit("-", 1)
        if candidate.isdigit() and int(candidate) >= 2:
            base_name = f"{match.group('date')}-{prefix}.md"
            if base_name in names:
                stem = prefix
                suffix = int(candidate)
    return date, stem, suffix


def _latest_key(path: Path, names: set[str]) -> tuple[tuple[int, ...], tuple[int, ...], int, str, int]:
    legacy = LEGACY_TRANSCRIPT_RE.fullmatch(path.name)
    if legacy is not None:
        date = tuple(int(value) for value in legacy.group("date").split("-"))
        time = tuple(int(value) for value in re.split(r"[-:]", legacy.group("time")))
        return date, time, 1, legacy.group("slug"), 1
    date, stem, suffix = _date_only_key(path, names)
    return date, (0, 0, 0), 0, stem, suffix


def resolve_transcript_path(arguments: Sequence[str], cwd: Path) -> Path:
    root = _ensure_trusted_debates_root(cwd)
    if list(arguments) == ["--latest"]:
        candidates: list[Path] = []
        for path in root.glob("*.md"):
            if path.is_symlink():
                raise TranscriptError("Transcript path must not be a symlink")
            if path.is_file() and (
                LEGACY_TRANSCRIPT_RE.fullmatch(path.name)
                or DATE_ONLY_TRANSCRIPT_RE.fullmatch(path.name)
            ):
                candidates.append(path.resolve())
        if not candidates:
            raise TranscriptError(
                "No Markdown transcripts found in docs/debates"
            )
        names = {path.name for path in candidates}
        return max(candidates, key=lambda path: _latest_key(path, names))
    if len(arguments) != 1 or arguments[0].startswith("-"):
        raise TranscriptError("Specify exactly one transcript path or --latest")
    supplied_candidate = Path(arguments[0])
    candidate = supplied_candidate
    if not candidate.is_absolute():
        candidate = cwd / candidate
    if candidate.is_symlink():
        raise TranscriptError("Transcript path must not be a symlink")
    candidate = candidate.resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise TranscriptError(
            "Transcript path must resolve beneath docs/debates"
        ) from error
    if candidate.suffix != ".md":
        raise TranscriptError("Transcript path must end in .md")
    if not candidate.is_file():
        raise TranscriptError(f"Transcript does not exist: {candidate}")
    return candidate


def _atomic_write(path: Path, content: str) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.stem}-", suffix=".tmp", dir=path.parent, text=True
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(
            descriptor, "w", encoding="utf-8", newline="\n"
        ) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _descriptor_flags() -> int:
    if sys.platform != "linux" or not hasattr(os, "O_DIRECTORY") or not hasattr(os, "O_NOFOLLOW"):
        raise TranscriptError("Linux descriptor-relative publication support is required")
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def _open_existing_directory(path: Path) -> int:
    current = os.open(os.path.sep, _descriptor_flags())
    try:
        for component in path.resolve().parts[1:]:
            next_descriptor = os.open(component, _descriptor_flags(), dir_fd=current)
            os.close(current)
            current = next_descriptor
        return current
    except BaseException:
        os.close(current)
        raise


def _descriptor_identity(descriptor: int) -> tuple[int, int]:
    value = os.fstat(descriptor)
    if not stat.S_ISDIR(value.st_mode):
        raise TranscriptError("publication component is not a directory")
    return value.st_dev, value.st_ino


def _publication_token(token: str) -> dict[str, object]:
    try:
        value = json.loads(token)
    except json.JSONDecodeError as error:
        raise TranscriptError("publication token is invalid") from error
    if not isinstance(value, dict):
        raise TranscriptError("publication token is invalid")
    required = ("project", "docs", "debates", "filename", "source")
    if any(key not in value for key in required):
        raise TranscriptError("publication token is incomplete")
    filename = value["filename"]
    if (
        not isinstance(filename, str)
        or not filename
        or Path(filename).name != filename
        or filename in {".", ".."}
        or not filename.endswith(".md")
        or not isinstance(value["source"], (list, tuple))
    ):
        raise TranscriptError("publication token is invalid")
    return value


def _token_identity(value: object) -> tuple[int, int]:
    if not isinstance(value, (list, tuple)) or len(value) != 2 or not all(
        isinstance(item, int) for item in value
    ):
        raise TranscriptError("publication token has an invalid identity")
    return value[0], value[1]


def _wait_for_generation_release(path: str) -> None:
    barrier = Path(path)
    barrier.write_text("ready\n", encoding="utf-8")
    deadline = time.monotonic() + 10
    while True:
        if "release\n" in barrier.read_text(encoding="utf-8"):
            return
        if time.monotonic() >= deadline:
            raise TimeoutError("generation barrier timed out")
        time.sleep(0.01)


def _canonical_generation_descriptors(
    cwd: Path,
    token: dict[str, object],
) -> tuple[int, int, int]:
    project_descriptor = _open_existing_directory(cwd)
    docs_descriptor: int | None = None
    debates_descriptor: int | None = None
    try:
        docs_descriptor = os.open("docs", _descriptor_flags(), dir_fd=project_descriptor)
        debates_descriptor = os.open("debates", _descriptor_flags(), dir_fd=docs_descriptor)
        identities = (
            _descriptor_identity(project_descriptor),
            _descriptor_identity(docs_descriptor),
            _descriptor_identity(debates_descriptor),
        )
        expected = tuple(_token_identity(token[key]) for key in ("project", "docs", "debates"))
        if identities != expected:
            raise TranscriptError("canonical transcript directory changed before HTML generation")
        return project_descriptor, docs_descriptor, debates_descriptor
    except BaseException:
        for descriptor in (debates_descriptor, docs_descriptor, project_descriptor):
            if descriptor is not None:
                os.close(descriptor)
        raise


def _generate_from_publication(
    transcript_path: Path,
    token_text: str,
    generation_barrier: str | None,
    post_publication_barrier: str | None,
) -> Path:
    token = _publication_token(token_text)
    cwd = Path.cwd().resolve()
    root = _ensure_trusted_debates_root(cwd)
    filename = token["filename"]
    if not isinstance(filename, str) or transcript_path.resolve() != root / filename:
        raise TranscriptError("publication token does not match the transcript path")
    if generation_barrier is not None:
        _wait_for_generation_release(generation_barrier)

    descriptors = _canonical_generation_descriptors(cwd, token)
    project_descriptor, docs_descriptor, debates_descriptor = descriptors
    source_descriptor: int | None = None
    temporary_name: str | None = None
    html_identity: tuple[int, int] | None = None
    try:
        source_descriptor = os.open(
            filename,
            os.O_RDONLY | os.O_NOFOLLOW,
            dir_fd=debates_descriptor,
        )
        source_identity = os.fstat(source_descriptor)
        expected_source = _token_identity(token["source"])
        if (source_identity.st_dev, source_identity.st_ino) != expected_source:
            raise TranscriptError("published transcript identity changed before HTML generation")
        with os.fdopen(os.dup(source_descriptor), "r", encoding="utf-8") as stream:
            markdown = stream.read()
        if not _canonical_generation_descriptors_match(cwd, token):
            raise TranscriptError("canonical transcript directory changed during HTML generation")
        transcript = parse_transcript(markdown)
        content = render_html(transcript)
        output_name = f"{Path(filename).stem}.html"
        temporary_name = f".{Path(output_name).stem}-{os.getpid()}-{os.urandom(8).hex()}.tmp"
        temporary_descriptor = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=debates_descriptor,
        )
        try:
            payload = content.encode("utf-8")
            remaining = memoryview(payload)
            while remaining:
                written = os.write(temporary_descriptor, remaining)
                if written <= 0:
                    raise OSError("short HTML write")
                remaining = remaining[written:]
            os.fsync(temporary_descriptor)
            temporary_stat = os.fstat(temporary_descriptor)
            if not stat.S_ISREG(temporary_stat.st_mode):
                raise TranscriptError("temporary HTML is not a regular file")
            html_identity = (temporary_stat.st_dev, temporary_stat.st_ino)
        finally:
            os.close(temporary_descriptor)
        if not _canonical_generation_descriptors_match(cwd, token):
            raise TranscriptError("canonical transcript directory changed before HTML publication")
        os.replace(
            temporary_name,
            output_name,
            src_dir_fd=debates_descriptor,
            dst_dir_fd=debates_descriptor,
        )
        temporary_name = None
        try:
            if post_publication_barrier is not None:
                _wait_for_generation_release(post_publication_barrier)
            published_stat = os.stat(
                output_name,
                dir_fd=debates_descriptor,
                follow_symlinks=False,
            )
            published_identity_matches = (
                html_identity is not None
                and _same_regular_inode(published_stat, html_identity)
            )
            canonical_identity_matches = _canonical_generation_descriptors_match(
                cwd, token
            )
            if not published_identity_matches or not canonical_identity_matches:
                raise TranscriptError(
                    "published HTML or canonical transcript directory changed after HTML publication"
                )
        except BaseException:
            if html_identity is not None:
                _unlink_owned_html(debates_descriptor, output_name, html_identity)
            raise
        _fsync_generation_directory(debates_descriptor)
        return root / output_name
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name, dir_fd=debates_descriptor)
            except FileNotFoundError:
                pass
        if source_descriptor is not None:
            os.close(source_descriptor)
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def _canonical_generation_descriptors_match(cwd: Path, token: dict[str, object]) -> bool:
    descriptors: tuple[int, int, int] | None = None
    try:
        descriptors = _canonical_generation_descriptors(cwd, token)
        return True
    except (OSError, TranscriptError):
        return False
    finally:
        if descriptors is not None:
            for descriptor in reversed(descriptors):
                os.close(descriptor)


def _fsync_generation_directory(descriptor: int) -> None:
    try:
        os.fsync(descriptor)
    except OSError as error:
        if error.errno not in {errno.EBADF, errno.EINVAL, errno.ENOTSUP}:
            raise


def _same_regular_inode(
    value: os.stat_result,
    identity: tuple[int, int],
) -> bool:
    return (
        stat.S_ISREG(value.st_mode)
        and value.st_dev == identity[0]
        and value.st_ino == identity[1]
    )


def _unlink_owned_html(
    descriptor: int,
    name: str,
    identity: tuple[int, int],
) -> None:
    try:
        current = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not _same_regular_inode(current, identity):
        return
    os.unlink(name, dir_fd=descriptor)
    _fsync_generation_directory(descriptor)


def generate(
    transcript_path: Path,
    publication_token: str | None = None,
    generation_barrier: str | None = None,
    post_publication_barrier: str | None = None,
) -> Path:
    if publication_token is not None:
        return _generate_from_publication(
            transcript_path,
            publication_token,
            generation_barrier,
            post_publication_barrier,
        )
    transcript = parse_transcript(transcript_path.read_text(encoding="utf-8"))
    output_path = transcript_path.with_suffix(".html")
    _atomic_write(output_path, render_html(transcript))
    return output_path


def validate_date_placeholder(markdown: str) -> None:
    placeholder_line = "**Date:** <timestamp>"
    lines = markdown.splitlines(keepends=True)
    metadata_lines = [line.rstrip("\r\n") for line in lines]
    metadata, metadata_end = _parse_metadata(metadata_lines)
    if metadata.get("Date") != "<timestamp>" or markdown.count(placeholder_line) != 1:
        raise TranscriptError(
            "Markdown must contain exactly one canonical top-level Date placeholder"
        )
    if any(line == placeholder_line for line in metadata_lines[metadata_end:]):
        raise TranscriptError(
            "Markdown must contain exactly one canonical top-level Date placeholder"
        )
    replaced = False
    for index in range(metadata_end):
        if metadata_lines[index] != placeholder_line:
            continue
        line_ending = lines[index][len(lines[index].rstrip("\r\n")):]
        lines[index] = "**Date:** 2000-01-01" + line_ending
        replaced = True
        break
    if not replaced:
        raise TranscriptError(
            "Markdown must contain exactly one canonical top-level Date placeholder"
        )
    parse_transcript(
        "".join(lines),
        date_only=True,
        expected_date="2000-01-01",
    )


def validate_stdin(
    date_only: bool = False,
    expected_date: str | None = None,
    date_placeholder: bool = False,
) -> None:
    markdown = sys.stdin.read()
    if date_placeholder:
        validate_date_placeholder(markdown)
        return
    parse_transcript(markdown, date_only=date_only, expected_date=expected_date)


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    try:
        if arguments == ["--validate-stdin"]:
            validate_stdin()
            return 0
        if arguments == ["--validate-stdin", "--date-placeholder"]:
            validate_stdin(date_placeholder=True)
            return 0
        if (
            len(arguments) == 3
            and arguments[0] == "--validate-stdin"
            and arguments[1] == "--date-only"
        ):
            validate_stdin(date_only=True, expected_date=arguments[2])
            return 0
        publication_token: str | None = None
        generation_barrier: str | None = None
        post_publication_barrier: str | None = None
        if len(arguments) >= 3 and arguments[1] == "--publication-token":
            publication_token = arguments[2]
            optional_arguments = arguments[3:]
            if len(optional_arguments) % 2 != 0:
                raise TranscriptError("invalid publication generation arguments")
            for index in range(0, len(optional_arguments), 2):
                option, value = optional_arguments[index : index + 2]
                if option == "--generation-barrier" and generation_barrier is None:
                    generation_barrier = value
                elif (
                    option == "--post-publication-barrier"
                    and post_publication_barrier is None
                ):
                    post_publication_barrier = value
                else:
                    raise TranscriptError("invalid publication generation arguments")
            source = Path(arguments[0])
            if not source.is_absolute():
                source = Path.cwd() / source
        else:
            source = resolve_transcript_path(arguments, Path.cwd())
        output = generate(
            source,
            publication_token,
            generation_barrier,
            post_publication_barrier,
        )
    except (OSError, UnicodeError, TranscriptError) as error:
        print(f"generate_html: {error}", file=sys.stderr)
        return 2
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
