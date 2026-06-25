#!/usr/bin/env python3
"""Run simple spreadsheet-agent API evals.

The script can either upload a CSV/TSV/XLSX-style spreadsheet first or reuse an
existing spreadsheet id, then sends a plain text prompt to the agent API and
records latency, answer text, model metadata, finish reason, and token usage
returned by the worker.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib import error, request


DEFAULT_BASE_URL = "http://localhost:5173"


@dataclass
class EvalResult:
    prompt: str
    answer: str | None
    base_url: str
    endpoint: str
    finish_reason: str | None
    model_provider: str | None
    model_name: str | None
    model_config: dict[str, Any] | None
    request_id: str | None
    spreadsheet_id: str | None
    spreadsheet_filename: str | None
    total_seconds: float
    upload_seconds: float | None
    answer_seconds: float
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    usage: dict[str, Any] | None
    error: str | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Upload a spreadsheet and benchmark a plain-text prompt, model choice, latency, and token usage against the spreadsheet agent API.",
    )
    parser.add_argument(
        "prompt",
        nargs="?",
        help="Plain text prompt to send to the agent. Use --prompt-file for longer prompts.",
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"Worker/dev-server origin. Default: {DEFAULT_BASE_URL}",
    )
    parser.add_argument(
        "--csv",
        "--spreadsheet",
        dest="spreadsheet_path",
        help="Path to a spreadsheet file to upload before asking the prompt.",
    )
    parser.add_argument(
        "--spreadsheet-id",
        help="Reuse an already-uploaded spreadsheet id instead of uploading a file.",
    )
    parser.add_argument(
        "--prompt-file",
        help="Read the prompt from a text file.",
    )
    parser.add_argument(
        "--no-pre-extract",
        action="store_true",
        help="Upload with preExtract=false, forcing the agent to inspect the raw file rather than prebuilt SQL tables.",
    )
    parser.add_argument(
        "--output",
        help="Write the eval result JSON to this path.",
    )
    parser.add_argument(
        "--jsonl",
        action="store_true",
        help="Append one JSON line to --output instead of overwriting it.",
    )
    return parser.parse_args()


def load_prompt(args: argparse.Namespace) -> str:
    if args.prompt_file:
        prompt = Path(args.prompt_file).read_text(encoding="utf-8")
    else:
        prompt = args.prompt or ""

    prompt = prompt.strip()
    if not prompt:
        raise ValueError("Provide a prompt argument or --prompt-file.")
    return prompt


def normalize_base_url(base_url: str) -> str:
    return base_url.rstrip("/")


def post_json(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    http_request = request.Request(
        url,
        data=body,
        headers={"content-type": "application/json", "accept": "application/json"},
        method="POST",
    )
    return read_json_response(http_request)


def upload_spreadsheet(base_url: str, spreadsheet_path: Path, pre_extract: bool) -> dict[str, Any]:
    boundary = f"----codex-eval-{uuid.uuid4().hex}"
    content_type = mimetypes.guess_type(spreadsheet_path.name)[0] or "application/octet-stream"
    file_bytes = spreadsheet_path.read_bytes()

    parts: list[bytes] = [
        form_field(boundary, "preExtract", "true" if pre_extract else "false"),
        file_field(boundary, "spreadsheet", spreadsheet_path.name, content_type, file_bytes),
        f"--{boundary}--\r\n".encode("utf-8"),
    ]
    body = b"".join(parts)
    http_request = request.Request(
        f"{base_url}/api/spreadsheets",
        data=body,
        headers={
            "accept": "application/json",
            "content-length": str(len(body)),
            "content-type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    return read_json_response(http_request)


def form_field(boundary: str, name: str, value: str) -> bytes:
    return (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{name}"\r\n'
        "\r\n"
        f"{value}\r\n"
    ).encode("utf-8")


def file_field(boundary: str, name: str, filename: str, content_type: str, value: bytes) -> bytes:
    header = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n"
        "\r\n"
    ).encode("utf-8")
    return header + value + b"\r\n"


def read_json_response(http_request: request.Request) -> dict[str, Any]:
    try:
        with request.urlopen(http_request, timeout=300) as response:
            text = response.read().decode("utf-8")
    except error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = {"error": text}
        raise RuntimeError(f"HTTP {exc.code}: {payload.get('error', text)}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"Request failed: {exc.reason}") from exc

    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Expected JSON response, got: {text[:500]}") from exc


def write_result(result: EvalResult, output: str | None, jsonl: bool) -> None:
    payload = asdict(result)
    if not output:
        print(json.dumps(payload, indent=2))
        return

    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if jsonl:
        with output_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload) + "\n")
    else:
        output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def token_count(usage: dict[str, Any] | None, *keys: str) -> int | None:
    if not usage:
        return None

    for key in keys:
        value = usage.get(key)
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
    return None


def string_value(payload: dict[str, Any] | None, key: str) -> str | None:
    if not payload:
        return None

    value = payload.get(key)
    return value if isinstance(value, str) else None


def main() -> int:
    args = parse_args()
    base_url = normalize_base_url(args.base_url)
    prompt = args.prompt or ""

    try:
        prompt = load_prompt(args)
        spreadsheet_id = args.spreadsheet_id
        spreadsheet_filename = None
        upload_seconds = None

        total_started = time.perf_counter()
        if args.spreadsheet_path:
            spreadsheet_path = Path(args.spreadsheet_path)
            if not spreadsheet_path.exists():
                raise FileNotFoundError(f"Spreadsheet file not found: {spreadsheet_path}")

            upload_started = time.perf_counter()
            upload_payload = upload_spreadsheet(base_url, spreadsheet_path, pre_extract=not args.no_pre_extract)
            upload_seconds = time.perf_counter() - upload_started
            spreadsheet = upload_payload.get("spreadsheet", {})
            spreadsheet_id = spreadsheet.get("id")
            spreadsheet_filename = spreadsheet.get("filename", spreadsheet_path.name)

        if not spreadsheet_id:
            raise ValueError("Provide --csv/--spreadsheet or --spreadsheet-id.")

        endpoint = f"{base_url}/api/spreadsheets/{spreadsheet_id}/agent-request"
        answer_started = time.perf_counter()
        answer_payload = post_json(endpoint, {"message": prompt})
        answer_seconds = time.perf_counter() - answer_started
        usage = answer_payload.get("usage") if isinstance(answer_payload.get("usage"), dict) else None
        model_config = answer_payload.get("model") if isinstance(answer_payload.get("model"), dict) else None
        input_tokens = token_count(usage, "inputTokens", "promptTokens", "prompt_tokens", "input_tokens")
        output_tokens = token_count(usage, "outputTokens", "completionTokens", "completion_tokens", "output_tokens")
        total_tokens = token_count(usage, "totalTokens", "total_tokens")
        if total_tokens is None and input_tokens is not None and output_tokens is not None:
            total_tokens = input_tokens + output_tokens

        result = EvalResult(
            prompt=prompt,
            answer=answer_payload.get("response"),
            base_url=base_url,
            endpoint=endpoint,
            finish_reason=answer_payload.get("finishReason"),
            model_provider=string_value(model_config, "provider"),
            model_name=string_value(model_config, "model"),
            model_config=model_config,
            request_id=answer_payload.get("requestId"),
            spreadsheet_id=spreadsheet_id,
            spreadsheet_filename=spreadsheet_filename,
            total_seconds=time.perf_counter() - total_started,
            upload_seconds=upload_seconds,
            answer_seconds=answer_seconds,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            usage=usage,
        )
        write_result(result, args.output, args.jsonl)
        return 0
    except Exception as exc:
        result = EvalResult(
            prompt=prompt,
            answer=None,
            base_url=base_url,
            endpoint="",
            finish_reason=None,
            model_provider=None,
            model_name=None,
            model_config=None,
            request_id=None,
            spreadsheet_id=args.spreadsheet_id,
            spreadsheet_filename=None,
            total_seconds=0,
            upload_seconds=None,
            answer_seconds=0,
            input_tokens=None,
            output_tokens=None,
            total_tokens=None,
            usage=None,
            error=str(exc),
        )
        write_result(result, args.output, args.jsonl)
        return 1


if __name__ == "__main__":
    sys.exit(main())
