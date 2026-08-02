#!/usr/bin/env python3
"""Validate and canonicalise a participant response JSON object."""

from __future__ import annotations

import json
import sys
from collections.abc import Sequence
from typing import Any


class ResponseFormatError(ValueError):
    """Raised when a participant response does not match its schema."""


_EXPECTED_FIELDS: dict[str, frozenset[str]] = {
    "round1": frozenset(("turn",)),
    "round2": frozenset(("turn", "consensus_reached", "recommend_stopping")),
}


def _extract_json_object(raw: str) -> str:
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end < start:
        raise ResponseFormatError("Response does not contain a JSON object")
    return raw[start : end + 1]


def _reject_duplicate_object_keys(
    pairs: list[tuple[str, Any]],
) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ResponseFormatError(f"Duplicate JSON object key: {key}")
        value[key] = item
    return value


def _parse_json(raw: str) -> dict[str, Any]:
    candidate = _extract_json_object(raw)
    try:
        value = json.loads(candidate, object_pairs_hook=_reject_duplicate_object_keys)
    except json.JSONDecodeError as error:
        raise ResponseFormatError(
            f"Malformed JSON at line {error.lineno}, column {error.colno}: "
            f"{error.msg}"
        ) from error
    if not isinstance(value, dict):
        raise ResponseFormatError("Response JSON must be an object")
    return value


def _validate_fields(response: dict[str, Any], schema: str) -> None:
    expected = _EXPECTED_FIELDS[schema]
    actual = set(response)
    missing = sorted(expected - actual)
    unexpected = sorted(actual - expected)
    errors: list[str] = []
    if missing:
        errors.append(f"missing required field(s): {', '.join(missing)}")
    if unexpected:
        errors.append(f"unexpected field(s): {', '.join(unexpected)}")
    if errors:
        raise ResponseFormatError("; ".join(errors))


def _validate_values(response: dict[str, Any], schema: str) -> None:
    turn = response["turn"]
    if not isinstance(turn, str) or not turn.strip():
        raise ResponseFormatError("turn must be a non-empty string")

    if schema == "round2":
        for field in ("consensus_reached", "recommend_stopping"):
            if not isinstance(response[field], bool):
                raise ResponseFormatError(f"{field} must be a boolean")


def format_response(raw: str, schema: str) -> str:
    """Extract, validate, and canonicalise a response for ``schema``."""
    if schema not in _EXPECTED_FIELDS:
        raise ResponseFormatError("schema must be round1 or round2")
    if not isinstance(raw, str):
        raise ResponseFormatError("raw response must be a string")

    response = _parse_json(raw)
    _validate_fields(response, schema)
    _validate_values(response, schema)
    return json.dumps(response)


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if len(arguments) == 1:
        schema = arguments[0]
    elif len(arguments) == 2 and arguments[0] == "--schema":
        schema = arguments[1]
    else:
        print(
            "format_response: usage: format_response.py [--schema] round1|round2",
            file=sys.stderr,
        )
        return 2

    try:
        formatted = format_response(sys.stdin.read(), schema)
    except (OSError, ResponseFormatError) as error:
        print(f"format_response: {error}", file=sys.stderr)
        return 2
    print(formatted)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
