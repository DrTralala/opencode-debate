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

    def test_parses_matching_tokenised_multiline_topic_as_topic_content(self) -> None:
        tokenised = VALID_TRANSCRIPT.replace(
            '**Topic:** Compare <alpha> & "beta"',
            """**Topic:**
<!-- BEGIN TOPIC abc123 -->
Compare <alpha> & "beta"

---

## Topic heading

**Maximum rounds:** 99
Closing topic line.
<!-- END TOPIC abc123 -->""",
        )

        transcript = parse_transcript(tokenised)

        self.assertEqual(
            transcript.topic,
            'Compare <alpha> & "beta"\n\n---\n\n## Topic heading\n\n'
            "**Maximum rounds:** 99\nClosing topic line.",
        )

    def test_rejects_malformed_inline_topic_block_begin_marker(self) -> None:
        malformed = VALID_TRANSCRIPT.replace(
            '**Topic:** Compare <alpha> & "beta"',
            """**Topic:** <!-- BEGIN TOPIC -->
**Maximum rounds:** 99
<!-- END TOPIC -->""",
        )

        with self.assertRaisesRegex(TranscriptError, "Topic block"):
            parse_transcript(malformed)

    def test_rejects_mismatched_topic_block_token(self) -> None:
        mismatched = VALID_TRANSCRIPT.replace(
            '**Topic:** Compare <alpha> & "beta"',
            """**Topic:** <!-- BEGIN TOPIC abc123 -->
Token mismatch.
<!-- END TOPIC xyz789 -->""",
        )

        with self.assertRaisesRegex(TranscriptError, "Topic block"):
            parse_transcript(mismatched)

    def test_recognises_topic_block_after_blank_separator(self) -> None:
        tokenised = VALID_TRANSCRIPT.replace(
            '**Topic:** Compare <alpha> & "beta"',
            """**Topic:**

<!-- BEGIN TOPIC abc123 -->
Separated marker.
**Maximum rounds:** 99
<!-- END TOPIC abc123 -->""",
        )

        transcript = parse_transcript(tokenised)

        self.assertEqual(
            transcript.topic, "Separated marker.\n**Maximum rounds:** 99"
        )
        self.assertEqual(transcript.maximum_rounds, 3)

    def test_preserves_token_block_boundary_whitespace(self) -> None:
        tokenised = VALID_TRANSCRIPT.replace(
            '**Topic:** Compare <alpha> & "beta"',
            "**Topic:** <!-- BEGIN TOPIC abc123 -->\n\n"
            "  <alpha>  \n\n"
            "<!-- END TOPIC abc123 -->",
        )

        transcript = parse_transcript(tokenised)

        self.assertEqual(transcript.topic, "\n  <alpha>  \n")

    def test_preserves_legacy_single_line_topic_metadata(self) -> None:
        transcript = parse_transcript(VALID_TRANSCRIPT)

        self.assertEqual(transcript.topic, 'Compare <alpha> & "beta"')

    def test_preserves_legacy_topic_that_mentions_marker_words(self) -> None:
        legacy = VALID_TRANSCRIPT.replace(
            '**Topic:** Compare <alpha> & "beta"',
            "**Topic:** Compare BEGIN TOPIC and END TOPIC delimiters.",
        )

        transcript = parse_transcript(legacy)

        self.assertEqual(
            transcript.topic, "Compare BEGIN TOPIC and END TOPIC delimiters."
        )

    def test_preserves_legacy_inline_multiline_topic_metadata(self) -> None:
        legacy = VALID_TRANSCRIPT.replace(
            '**Topic:** Compare <alpha> & "beta"',
            '**Topic:** Compare <alpha> & "beta"\n\nSecond topic paragraph.',
        )

        transcript = parse_transcript(legacy)

        self.assertEqual(
            transcript.topic,
            'Compare <alpha> & "beta"\n\nSecond topic paragraph.',
        )

    def test_topic_last_legacy_multiline_stops_at_section_boundary(self) -> None:
        topic_last = VALID_TRANSCRIPT.replace(
            '**Topic:** Compare <alpha> & "beta"\n', ""
        ).replace(
            "**Consensus reached:** No (2/3)",
            "**Consensus reached:** No (2/3)\n"
            "**Topic:** Topic last in the preamble.\nSecond topic line.",
        )

        transcript = parse_transcript(topic_last)

        self.assertEqual(
            transcript.topic, "Topic last in the preamble.\nSecond topic line."
        )
        self.assertEqual(len(transcript.rounds), 2)

    def test_preserves_level_two_headings_inside_turns_and_synthesis(self) -> None:
        heading_rich = VALID_TRANSCRIPT.replace(
            "Anthropic first turn.", "## Verdict\n\nAnthropic first turn."
        ).replace(
            "Use <safe> output & preserve quotes.",
            "## Final Assessment\n\nUse <safe> output & preserve quotes.",
        )

        transcript = parse_transcript(heading_rich)

        self.assertIn("## Verdict", transcript.rounds[0].turns[1].text)
        self.assertIn("## Final Assessment", transcript.final_synthesis)

    def test_rejects_missing_required_metadata(self) -> None:
        with self.assertRaisesRegex(TranscriptError, "Maximum rounds"):
            parse_transcript(VALID_TRANSCRIPT.replace("**Maximum rounds:** 3\n", ""))

    def test_rejects_missing_preamble_metadata_despite_section_lookalike(self) -> None:
        broken = VALID_TRANSCRIPT.replace("**Maximum rounds:** 3\n", "").replace(
            "Kimi's first turn.", "**Maximum rounds:** 3\n\nKimi's first turn."
        )

        with self.assertRaisesRegex(
            TranscriptError, "Missing required metadata: Maximum rounds"
        ):
            parse_transcript(broken)

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

    def test_rejects_separator_introduced_unsupported_section(self) -> None:
        broken = VALID_TRANSCRIPT.replace(
            "## Final Synthesis",
            "## Unsupported\n\nUnexpected content.\n\n---\n\n## Final Synthesis",
        )
        with self.assertRaisesRegex(TranscriptError, "Unsupported level-two section"):
            parse_transcript(broken)

    def test_requires_final_synthesis_to_be_the_last_section(self) -> None:
        broken = VALID_TRANSCRIPT + "\n---\n\n## Extension Decisions\n\nToo late.\n"
        with self.assertRaisesRegex(TranscriptError, "last section"):
            parse_transcript(broken)


class RenderHtmlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.html = render_html(parse_transcript(VALID_TRANSCRIPT))

    def test_escapes_literal_metadata_locations(self) -> None:
        self.assertIn("Compare &lt;alpha&gt; &amp; &quot;beta&quot;", self.html)
        self.assertNotIn("Compare <alpha>", self.html)

    def test_escapes_tokenised_multiline_topic_and_preserves_pre_wrap(self) -> None:
        tokenised = VALID_TRANSCRIPT.replace(
            '**Topic:** Compare <alpha> & "beta"',
            """**Topic:** <!-- BEGIN TOPIC abc123 -->
First <unsafe> line & "quoted"

Second line.
<!-- END TOPIC abc123 -->""",
        )

        rendered = render_html(parse_transcript(tokenised))

        self.assertIn(
            "First &lt;unsafe&gt; line &amp; &quot;quoted&quot;\n\nSecond line.",
            rendered,
        )
        self.assertNotIn("First <unsafe>", rendered)
        self.assertNotIn("BEGIN TOPIC", rendered)
        self.assertIn("white-space: pre-wrap", rendered)

    def test_renders_preserved_topic_block_boundary_whitespace(self) -> None:
        tokenised = VALID_TRANSCRIPT.replace(
            '**Topic:** Compare <alpha> & "beta"',
            "**Topic:** <!-- BEGIN TOPIC abc123 -->\n\n"
            "  <alpha>  \n\n"
            "<!-- END TOPIC abc123 -->",
        )

        rendered = render_html(parse_transcript(tokenised))

        self.assertIn(
            "<strong>Topic:</strong> \n  &lt;alpha&gt;  \n</div>", rendered
        )
        self.assertIn("white-space: pre-wrap", rendered)

    def test_renders_markdown_for_every_narrative_section(self) -> None:
        markdown_rich = (
            VALID_TRANSCRIPT.replace("Kimi's first turn.", "**Kimi** first turn.")
            .replace("The user granted one more round.", "- Granted **one** round")
            .replace("Participant 2 required one retry.", "`Participant 2` required one retry.")
            .replace(
                "Use <safe> output & preserve quotes.",
                "## Final Assessment\n\nUse **safe** output.",
            )
        )

        rendered = render_html(parse_transcript(markdown_rich))

        self.assertIn("<strong>Kimi</strong> first turn.", rendered)
        self.assertIn("<li>Granted <strong>one</strong> round</li>", rendered)
        self.assertIn("<code>Participant 2</code> required one retry.", rendered)
        self.assertIn("<h2>Final Assessment</h2>", rendered)
        self.assertNotIn("**Kimi**", rendered)

    def test_sanitizes_executable_markdown(self) -> None:
        unsafe = VALID_TRANSCRIPT.replace(
            "Anthropic first turn.",
            '<script>alert(1)</script>\n\n[bad](javascript:alert(2))',
        )
        rendered = render_html(parse_transcript(unsafe))
        self.assertNotIn("<script", rendered)
        self.assertNotIn("javascript:", rendered)

    def test_reports_markdown_helper_start_failure(self) -> None:
        with patch("subprocess.run", side_effect=FileNotFoundError("node missing")):
            with self.assertRaisesRegex(TranscriptError, "could not start"):
                render_html(parse_transcript(VALID_TRANSCRIPT))

    def test_reports_markdown_helper_nonzero_exit(self) -> None:
        failed = __import__("subprocess").CompletedProcess(
            args=[], returncode=1, stdout="", stderr="bad input"
        )
        with patch("subprocess.run", return_value=failed):
            with self.assertRaisesRegex(TranscriptError, "bad input"):
                render_html(parse_transcript(VALID_TRANSCRIPT))

    def test_rejects_malformed_markdown_helper_output(self) -> None:
        malformed = __import__("subprocess").CompletedProcess(
            args=[], returncode=0, stdout="not-json", stderr=""
        )
        with patch("subprocess.run", return_value=malformed):
            with self.assertRaisesRegex(TranscriptError, "invalid JSON"):
                render_html(parse_transcript(VALID_TRANSCRIPT))

    def test_rejects_wrong_markdown_helper_item_count(self) -> None:
        wrong_count = __import__("subprocess").CompletedProcess(
            args=[], returncode=0, stdout='{"html":[]}', stderr=""
        )
        with patch("subprocess.run", return_value=wrong_count):
            with self.assertRaisesRegex(TranscriptError, "item count"):
                render_html(parse_transcript(VALID_TRANSCRIPT))

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
        self.assertIn('<table class="debate-table">', self.html)
        self.assertIn(".markdown-body pre", self.html)
        self.assertIn("overflow-x: auto", self.html)

    def test_puts_round_two_statuses_below_the_responses(self) -> None:
        turn_marker = '<tr class="turn-row"><th scope="row" rowspan="2">2</th>'
        turn_at = self.html.index(turn_marker)
        status_at = self.html.index('<tr class="status-row">', turn_at)
        self.assertLess(turn_at, status_at)
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

    def test_markdown_failure_preserves_existing_output(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            debates = root / "docs" / "debates"
            debates.mkdir(parents=True)
            source = debates / "2026-07-26T08-01-32Z-test.md"
            output = source.with_suffix(".html")
            source.write_text(VALID_TRANSCRIPT, encoding="utf-8")
            output.write_text("old", encoding="utf-8")
            with patch("subprocess.run", side_effect=FileNotFoundError("node missing")):
                with self.assertRaisesRegex(TranscriptError, "could not start"):
                    generate(source)
            self.assertEqual(output.read_text(encoding="utf-8"), "old")

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
