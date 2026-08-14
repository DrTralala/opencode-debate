from __future__ import annotations

import json
import importlib
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "format_response.py"


def formatter_module():
    try:
        return importlib.import_module("scripts.format_response")
    except ModuleNotFoundError as error:
        raise AssertionError(
            "scripts.format_response is missing; implement the formatter first"
        ) from error


class FormatResponseTests(unittest.TestCase):
    def test_literal_control_characters_inside_strings_are_repaired(self) -> None:
        controls = "\n\r\t\b\f" + "".join(
            chr(code) for code in range(0x20) if code not in (8, 9, 10, 12, 13)
        )
        turn = f"before{controls}after"

        formatted = formatter_module().format_response(
            '{"turn":"' + turn + '"}', "round1"
        )

        self.assertEqual(formatted, json.dumps({"turn": turn}))

    def test_existing_json_escapes_are_not_rewritten(self) -> None:
        raw = r'{"turn":"line\nquote: \"yes\" slash: \\ nul: \u0000"}'

        formatted = formatter_module().format_response(raw, "round1")

        self.assertEqual(formatted, json.dumps(json.loads(raw)))

    def test_legal_json_whitespace_outside_strings_is_preserved_for_parsing(self) -> None:
        raw = '\n\t{\r\n "turn"\t:\n "whitespace"\r\n}\n'

        formatted = formatter_module().format_response(raw, "round1")

        self.assertEqual(formatted, '{"turn": "whitespace"}')

    def test_round_one_uses_default_json_unicode_escaping(self) -> None:
        raw = (
            "I considered the question first.\n"
            "```json\n"
            '{"turn":"First line\\nQuote: \\"yes\\" \\\\ path — café"}\n'
            "```\n"
            "That is my complete response."
        )

        formatted = formatter_module().format_response(raw, "round1")

        self.assertEqual(
            formatted,
            '{"turn": "First line\\nQuote: \\"yes\\" \\\\ path \\u2014 caf\\u00e9"}',
        )

    def test_later_round_requires_and_preserves_both_statuses(self) -> None:
        raw = (
            'prose before {"turn": "refined position", '
            '"consensus_reached": false, "recommend_stopping": true} prose after'
        )

        formatted = formatter_module().format_response(raw, "round2")

        self.assertEqual(
            formatted,
            '{"turn": "refined position", "consensus_reached": false, '
            '"recommend_stopping": true}',
        )

    def test_turn_text_is_not_trimmed_or_rewritten(self) -> None:
        raw = '{"turn":"  keep this newline\\nand these spaces  "}'

        formatted = formatter_module().format_response(raw, "round1")

        self.assertEqual(
            formatted,
            '{"turn": "  keep this newline\\nand these spaces  "}',
        )

    def test_duplicate_object_keys_are_rejected(self) -> None:
        cases = (
            ('{"turn":"first","turn":"second"}', "round1", "turn"),
            (
                '{"turn":"later","consensus_reached":true,'
                '"consensus_reached":false,"recommend_stopping":true}',
                "round2",
                "consensus_reached",
            ),
            (
                '{"turn":"later","consensus_reached":false,'
                '"recommend_stopping":true,"recommend_stopping":false}',
                "round2",
                "recommend_stopping",
            ),
        )
        for raw, schema, field in cases:
            with self.subTest(field=field):
                with self.assertRaises(
                    formatter_module().ResponseFormatError
                ) as caught:
                    formatter_module().format_response(raw, schema)
                self.assertEqual(
                    str(caught.exception), f"Duplicate JSON object key: {field}"
                )

    def test_malformed_json_reports_line_and_column(self) -> None:
        raw = 'prefix\n{\n  "turn": "missing comma"\n  "other": "value"\n}'

        with self.assertRaisesRegex(
            formatter_module().ResponseFormatError,
            r"Malformed JSON.*line [0-9]+.*column [0-9]+",
        ):
            formatter_module().format_response(raw, "round1")

    def test_missing_later_round_fields_are_rejected(self) -> None:
        with self.assertRaisesRegex(
            formatter_module().ResponseFormatError,
            r"missing required field.*consensus_reached.*recommend_stopping",
        ):
            formatter_module().format_response('{"turn":"needs statuses"}', "round2")

    def test_unexpected_round_one_fields_are_rejected(self) -> None:
        with self.assertRaisesRegex(
            formatter_module().ResponseFormatError,
            r"unexpected field.*consensus_reached",
        ):
            formatter_module().format_response(
                '{"turn":"first round", "consensus_reached": true}', "round1"
            )

    def test_incorrect_field_types_are_rejected(self) -> None:
        cases = (
            ('{"turn": 42}', "round1", "turn must be a non-empty string"),
            (
                '{"turn":"later", "consensus_reached":"false", '
                '"recommend_stopping": true}',
                "round2",
                "consensus_reached must be a boolean",
            ),
        )
        for raw, schema, message in cases:
            with self.subTest(raw=raw):
                with self.assertRaisesRegex(
                    formatter_module().ResponseFormatError, message
                ):
                    formatter_module().format_response(raw, schema)

    def test_empty_turn_is_rejected(self) -> None:
        with self.assertRaisesRegex(
            formatter_module().ResponseFormatError,
            "turn must be a non-empty string",
        ):
            formatter_module().format_response('{"turn":"  \\n  "}', "round1")

    def test_unknown_schema_is_rejected(self) -> None:
        with self.assertRaisesRegex(
            formatter_module().ResponseFormatError, "schema must be round1 or round2"
        ):
            formatter_module().format_response('{"turn":"response"}', "round3")

    def test_non_whitespace_control_characters_outside_strings_remain_invalid(self) -> None:
        with self.assertRaisesRegex(
            formatter_module().ResponseFormatError, "Malformed JSON"
        ):
            formatter_module().format_response('{"turn"\x00:"response"}', "round1")

    def test_plain_markdown_without_json_is_rejected(self) -> None:
        with self.assertRaisesRegex(
            formatter_module().ResponseFormatError,
            "Response does not contain a JSON object",
        ):
            formatter_module().format_response("This is plain Markdown.", "round1")

    def test_multiple_json_objects_are_rejected_as_ambiguous_syntax(self) -> None:
        with self.assertRaisesRegex(
            formatter_module().ResponseFormatError, "Malformed JSON"
        ):
            formatter_module().format_response(
                '{"turn":"first"} and {"turn":"second"}', "round1"
            )


class FormatResponseCliTests(unittest.TestCase):
    def run_cli(self, schema: str, raw: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), schema],
            input=raw,
            text=True,
            capture_output=True,
            cwd=ROOT,
            check=False,
        )

    def test_success_writes_only_canonical_json_to_stdout(self) -> None:
        completed = self.run_cli("round1", 'prefix {"turn":"CLI response"} suffix')

        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, '{"turn": "CLI response"}\n')
        self.assertEqual(completed.stderr, "")

    def test_failure_writes_diagnostic_to_stderr_and_nothing_to_stdout(self) -> None:
        completed = self.run_cli("round2", '{"turn":"missing statuses"}')

        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, "")
        self.assertRegex(
            completed.stderr,
            r"^format_response: .*consensus_reached.*recommend_stopping",
        )
        self.assertNotIn("Traceback", completed.stderr)


if __name__ == "__main__":
    unittest.main()
