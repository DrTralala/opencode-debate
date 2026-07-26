from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from scripts.generate_html import (
    TranscriptError,
    generate,
    main,
    parse_transcript,
    render_html,
    resolve_transcript_path,
)


VALID_TRANSCRIPT = """# Debate: Escaping and Layout

**Date:** 2026-07-26T08:01:32Z
**Topic:** Compare <alpha> & "beta"
**Maximum rounds:** 3
**Rounds completed:** 2
**Participants:** Participant 1 (debate-kimi), Participant 2 (debate-anthropic), Participant 3 (debate-openai)
**Consensus reached:** No (2/3)

---

## Round 1

### Participant 1 (debate-kimi)

Kimi's first turn.

### Participant 2 (debate-anthropic)

Anthropic first turn.

### Participant 3 (debate-openai)

OpenAI first turn.

---

## Round 2

### Participant 1 (debate-kimi)

- **consensus_reached:** true
- **recommend_stopping:** true

Kimi second turn.

### Participant 2 (debate-anthropic)

- **consensus_reached:** false
- **recommend_stopping:** false

Anthropic second turn.

### Participant 3 (debate-openai)

- **consensus_reached:** true
- **recommend_stopping:** false

OpenAI second turn.

---

## Extension Decisions

The user granted one more round.

---

## JSON Parsing Problems

Participant 2 required one retry.

---

## Final Synthesis

Use <safe> output & preserve quotes.
"""


class ParseTranscriptTests(unittest.TestCase):
    def test_parses_complete_transcript(self) -> None:
        transcript = parse_transcript(VALID_TRANSCRIPT)
        self.assertEqual(transcript.title, "Escaping and Layout")
        self.assertEqual(transcript.maximum_rounds, 3)
        self.assertEqual(transcript.rounds_completed, 2)
        self.assertEqual(
            [turn.agent for turn in transcript.rounds[0].turns],
            ["debate-kimi", "debate-anthropic", "debate-openai"],
        )
        self.assertIsNone(transcript.rounds[0].turns[0].consensus_reached)
        self.assertTrue(transcript.rounds[1].turns[0].consensus_reached)
        self.assertFalse(transcript.rounds[1].turns[1].recommend_stopping)
        self.assertEqual(
            transcript.extension_decisions, "The user granted one more round."
        )
        self.assertEqual(
            transcript.json_parsing_problems, "Participant 2 required one retry."
        )
        self.assertEqual(
            transcript.final_synthesis, "Use <safe> output & preserve quotes."
        )

    def test_rejects_missing_required_metadata(self) -> None:
        with self.assertRaisesRegex(TranscriptError, "Maximum rounds"):
            parse_transcript(VALID_TRANSCRIPT.replace("**Maximum rounds:** 3\n", ""))

    def test_rejects_non_contiguous_rounds(self) -> None:
        with self.assertRaisesRegex(TranscriptError, "round headings"):
            parse_transcript(VALID_TRANSCRIPT.replace("## Round 2", "## Round 3"))

    def test_rejects_a_round_without_exactly_three_participants(self) -> None:
        broken = VALID_TRANSCRIPT.replace(
            "### Participant 3 (debate-openai)\n\nOpenAI first turn.\n\n", "", 1
        )
        with self.assertRaisesRegex(TranscriptError, "exactly three"):
            parse_transcript(broken)

    def test_rejects_round_two_without_status_fields(self) -> None:
        broken = VALID_TRANSCRIPT.replace(
            "- **consensus_reached:** true\n", "", 1
        )
        with self.assertRaisesRegex(TranscriptError, "consensus_reached"):
            parse_transcript(broken)

    def test_rejects_noncanonical_status_boolean_case(self) -> None:
        broken = VALID_TRANSCRIPT.replace(
            "- **consensus_reached:** true", "- **consensus_reached:** True", 1
        )
        with self.assertRaisesRegex(TranscriptError, "consensus_reached"):
            parse_transcript(broken)

    def test_requires_final_synthesis_to_be_the_last_section(self) -> None:
        broken = VALID_TRANSCRIPT + "\n## Extension Decisions\n\nToo late.\n"
        with self.assertRaisesRegex(TranscriptError, "last section"):
            parse_transcript(broken)


class RenderHtmlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.html = render_html(parse_transcript(VALID_TRANSCRIPT))

    def test_escapes_every_dynamic_text_location(self) -> None:
        self.assertIn("Compare &lt;alpha&gt; &amp; &quot;beta&quot;", self.html)
        self.assertIn("Kimi&#x27;s first turn.", self.html)
        self.assertIn("Use &lt;safe&gt; output &amp; preserve quotes.", self.html)
        self.assertNotIn("Compare <alpha>", self.html)

    def test_uses_one_table_without_round_headings(self) -> None:
        self.assertEqual(self.html.count("<table"), 1)
        self.assertNotIn("<h3>Round", self.html)

    def test_fixes_round_width_and_equalises_participant_columns(self) -> None:
        self.assertIn('<col class="round-column">', self.html)
        self.assertEqual(self.html.count('<col class="participant-column">'), 3)
        self.assertIn(".round-column { width: 3rem; }", self.html)
        self.assertIn(
            ".participant-column { width: calc((100% - 3rem) / 3); }", self.html
        )

    def test_puts_round_two_statuses_in_a_dedicated_row(self) -> None:
        status_at = self.html.index('<tr class="status-row">')
        turn_at = self.html.index('<tr class="turn-row">', status_at)
        self.assertLess(status_at, turn_at)
        self.assertEqual(self.html.count('<tr class="status-row">'), 1)
        self.assertIn('rowspan="2">2</th>', self.html)

    def test_renders_optional_sections_and_has_no_turn_scroller(self) -> None:
        self.assertIn("Extension Decisions", self.html)
        self.assertIn("JSON Parsing Problems", self.html)
        self.assertNotIn("overflow-y", self.html)
        self.assertNotIn("max-height", self.html)


class GeneratorCliTests(unittest.TestCase):
    def test_direct_path_must_resolve_beneath_docs_debates(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            outside = root / "outside.md"
            outside.write_text(VALID_TRANSCRIPT, encoding="utf-8")
            with self.assertRaisesRegex(TranscriptError, "docs/debates"):
                resolve_transcript_path([str(outside)], root)

    def test_latest_selects_newest_timestamped_markdown(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            debates = root / "docs" / "debates"
            debates.mkdir(parents=True)
            older = debates / "2026-07-25T08-01-32Z-older.md"
            newer = debates / "2026-07-26T08-01-32Z-newer.md"
            older.write_text(VALID_TRANSCRIPT, encoding="utf-8")
            newer.write_text(VALID_TRANSCRIPT, encoding="utf-8")
            self.assertEqual(
                resolve_transcript_path(["--latest"], root), newer.resolve()
            )

    def test_generate_atomically_replaces_sibling_html(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            debates = root / "docs" / "debates"
            debates.mkdir(parents=True)
            source = debates / "2026-07-26T08-01-32Z-test.md"
            source.write_text(VALID_TRANSCRIPT, encoding="utf-8")
            output = generate(source)
            self.assertEqual(output, source.with_suffix(".html"))
            self.assertTrue(
                output.read_text(encoding="utf-8").startswith("<!DOCTYPE html>")
            )
            self.assertEqual(list(debates.glob("*.tmp")), [])

    def test_failed_replace_leaves_existing_output_and_no_temporary_file(
        self,
    ) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            debates = root / "docs" / "debates"
            debates.mkdir(parents=True)
            source = debates / "2026-07-26T08-01-32Z-test.md"
            output = source.with_suffix(".html")
            source.write_text(VALID_TRANSCRIPT, encoding="utf-8")
            output.write_text("old", encoding="utf-8")
            with patch(
                "scripts.generate_html.os.replace", side_effect=OSError("replace failed")
            ):
                with self.assertRaisesRegex(OSError, "replace failed"):
                    generate(source)
            self.assertEqual(output.read_text(encoding="utf-8"), "old")
            self.assertEqual(list(debates.glob("*.tmp")), [])

    def test_main_reports_validation_errors_without_a_traceback(self) -> None:
        stderr = StringIO()
        with redirect_stderr(stderr):
            result = main([])
        self.assertEqual(result, 2)
        self.assertIn(
            "exactly one transcript path or --latest", stderr.getvalue()
        )
        self.assertNotIn("Traceback", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
