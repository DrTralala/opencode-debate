#!/usr/bin/env python3
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import html
import json
import os
import re
import subprocess
import sys
import tempfile
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


def parse_transcript(markdown: str) -> Transcript:
    lines = markdown.splitlines()
    if not lines:
        raise TranscriptError("Transcript is empty")
    title_match = TITLE_RE.fullmatch(lines[0])
    if title_match is None:
        raise TranscriptError("Transcript must start with '# Debate: <title>'")

    section_list = _sections(lines)
    metadata: dict[str, str] = {}
    for line in lines[1 : section_list[0][1]]:
        match = METADATA_RE.fullmatch(line)
        if match:
            metadata[match.group(1)] = match.group(2).strip()
    for field in REQUIRED_METADATA:
        if field not in metadata:
            raise TranscriptError(f"Missing required metadata: {field}")

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


TIMESTAMPED_TRANSCRIPT_RE = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z-.+\.md$"
)


def resolve_transcript_path(arguments: Sequence[str], cwd: Path) -> Path:
    root = (cwd / "docs" / "debates").resolve()
    if list(arguments) == ["--latest"]:
        candidates = sorted(
            path.resolve()
            for path in root.glob("*.md")
            if TIMESTAMPED_TRANSCRIPT_RE.fullmatch(path.name)
        )
        if not candidates:
            raise TranscriptError(
                "No timestamped Markdown transcripts found in docs/debates"
            )
        return candidates[-1]
    if len(arguments) != 1 or arguments[0].startswith("-"):
        raise TranscriptError("Specify exactly one transcript path or --latest")
    candidate = Path(arguments[0])
    if not candidate.is_absolute():
        candidate = cwd / candidate
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


def generate(transcript_path: Path) -> Path:
    transcript = parse_transcript(transcript_path.read_text(encoding="utf-8"))
    output_path = transcript_path.with_suffix(".html")
    _atomic_write(output_path, render_html(transcript))
    return output_path


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    try:
        source = resolve_transcript_path(arguments, Path.cwd())
        output = generate(source)
    except (OSError, UnicodeError, TranscriptError) as error:
        print(f"generate_html: {error}", file=sys.stderr)
        return 2
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
