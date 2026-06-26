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
DEFAULT_BENCHMARK_MODELS = [
    "openai:gpt-5.5",
    "anthropic:claude-sonnet-4-6",
    "workers-ai:@cf/moonshotai/kimi-k2.7-code",
]
DEFAULT_ACCESS_MODES = ["sqlite", "raw"]
MODEL_PRICES_PER_1M_TOKENS = {
    "anthropic:claude-sonnet-4-6": {"input": 3.00, "output": 15.00},
    "openai:gpt-5.5": {"input": 5.00, "output": 30.00},
    "workers-ai:@cf/moonshotai/kimi-k2.7-code": {"input": 0.95, "output": 4.00},
}
APP_USER_AGENT = "xlsx-song-agent-sandbox-benchmark/1.0"


@dataclass
class EvalResult:
    prompt: str
    answer: str | None
    access_mode: str | None
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
    estimated_cost_usd: float | None
    pricing: dict[str, Any] | None
    usage: dict[str, Any] | None
    error: str | None = None


@dataclass
class ModelSpec:
    provider: str
    model: str


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
        "--access-mode",
        choices=["auto", "sqlite", "raw"],
        default="auto",
        help="Access strategy for a single prompt run. Default: auto.",
    )
    parser.add_argument(
        "--compare-access-modes",
        action="store_true",
        help="Run the prompt for each configured benchmark model in both sqlite and raw access modes.",
    )
    parser.add_argument(
        "--models",
        default=",".join(DEFAULT_BENCHMARK_MODELS),
        help="Comma-separated provider:model list for --compare-access-modes.",
    )
    parser.add_argument(
        "--access-modes",
        default=",".join(DEFAULT_ACCESS_MODES),
        help="Comma-separated access modes for --compare-access-modes. Default: sqlite,raw.",
    )
    parser.add_argument(
        "--save-to-benchmarks",
        action="store_true",
        help="Persist each eval row to /api/benchmarks/runs so it appears in the Benchmarks tab.",
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
        headers={"content-type": "application/json", "accept": "application/json", "user-agent": APP_USER_AGENT},
        method="POST",
    )
    return read_json_response(http_request)


def get_json(url: str) -> dict[str, Any]:
    http_request = request.Request(
        url,
        headers={"accept": "application/json", "user-agent": APP_USER_AGENT},
        method="GET",
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
            "user-agent": APP_USER_AGENT,
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
        with request.urlopen(http_request, timeout=900) as response:
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


def write_result(result: EvalResult | list[EvalResult], output: str | None, jsonl: bool) -> None:
    payload: dict[str, Any] | list[dict[str, Any]]
    if isinstance(result, list):
        payload = [asdict(item) for item in result]
    else:
        payload = asdict(result)

    if not output:
        print(json.dumps(payload, indent=2))
        return

    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if jsonl:
        with output_path.open("a", encoding="utf-8") as handle:
            if isinstance(payload, list):
                for item in payload:
                    handle.write(json.dumps(item) + "\n")
            else:
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


def model_key(provider: str | None, model: str | None) -> str | None:
    if not provider or not model:
        return None
    return f"{provider}:{model}"


def estimate_cost_usd(provider: str | None, model: str | None, input_tokens: int | None, output_tokens: int | None) -> tuple[float | None, dict[str, Any] | None]:
    key = model_key(provider, model)
    if key is None:
        return None, None

    prices = MODEL_PRICES_PER_1M_TOKENS.get(key)
    if not prices:
        return None, {
            "currency": "USD",
            "modelKey": key,
            "pricingAvailable": False,
            "unit": "1M tokens",
        }

    input_cost = ((input_tokens or 0) / 1_000_000) * prices["input"]
    output_cost = ((output_tokens or 0) / 1_000_000) * prices["output"]
    return round(input_cost + output_cost, 8), {
        "currency": "USD",
        "inputPer1MTokens": prices["input"],
        "modelKey": key,
        "outputPer1MTokens": prices["output"],
        "pricingAvailable": True,
        "unit": "1M tokens",
    }


def parse_model_specs(value: str) -> list[ModelSpec]:
    specs: list[ModelSpec] = []
    for raw_entry in value.split(","):
        entry = raw_entry.strip()
        if not entry:
            continue
        provider, separator, model = entry.partition(":")
        if not separator or not provider.strip() or not model.strip():
            raise ValueError(f"Model must be provider:model, got {entry!r}.")
        specs.append(ModelSpec(provider=provider.strip(), model=model.strip()))
    if not specs:
        raise ValueError("Provide at least one model.")
    return specs


def parse_access_modes(value: str) -> list[str]:
    modes = [entry.strip() for entry in value.split(",") if entry.strip()]
    invalid = [mode for mode in modes if mode not in {"auto", "sqlite", "raw"}]
    if invalid:
        raise ValueError(f"Invalid access mode(s): {', '.join(invalid)}")
    if not modes:
        raise ValueError("Provide at least one access mode.")
    return modes


def wait_for_spreadsheet_ready(base_url: str, spreadsheet_id: str, timeout_seconds: int = 900) -> dict[str, Any]:
    started = time.perf_counter()
    while time.perf_counter() - started < timeout_seconds:
        payload = get_json(f"{base_url}/api/spreadsheets/{spreadsheet_id}")
        spreadsheet = payload.get("spreadsheet")
        if not isinstance(spreadsheet, dict):
            raise RuntimeError("Spreadsheet status response did not include a spreadsheet object.")
        status = spreadsheet.get("status")
        if status == "ready":
            return spreadsheet
        if status == "failed":
            raise RuntimeError(f"Spreadsheet extraction failed: {spreadsheet.get('error_message') or 'unknown error'}")
        time.sleep(5)
    raise TimeoutError(f"Spreadsheet {spreadsheet_id} was not ready after {timeout_seconds} seconds.")


def ask_spreadsheet(
    base_url: str,
    spreadsheet_id: str,
    prompt: str,
    access_mode: str,
    model: ModelSpec | None,
) -> tuple[str, dict[str, Any], float]:
    endpoint = f"{base_url}/api/spreadsheets/{spreadsheet_id}/agent-request"
    payload: dict[str, Any] = {"accessMode": access_mode, "message": prompt}
    if model:
        payload["model"] = {"provider": model.provider, "model": model.model}
    answer_started = time.perf_counter()
    answer_payload = post_json(endpoint, payload)
    return endpoint, answer_payload, time.perf_counter() - answer_started


def eval_result_from_answer(
    *,
    access_mode: str,
    answer_payload: dict[str, Any],
    answer_seconds: float,
    base_url: str,
    endpoint: str,
    prompt: str,
    spreadsheet_filename: str | None,
    spreadsheet_id: str,
    total_seconds: float,
    upload_seconds: float | None,
) -> EvalResult:
    usage = answer_payload.get("usage") if isinstance(answer_payload.get("usage"), dict) else None
    model_config = answer_payload.get("model") if isinstance(answer_payload.get("model"), dict) else None
    input_tokens = token_count(usage, "inputTokens", "promptTokens", "prompt_tokens", "input_tokens")
    output_tokens = token_count(usage, "outputTokens", "completionTokens", "completion_tokens", "output_tokens")
    total_tokens = token_count(usage, "totalTokens", "total_tokens")
    if total_tokens is None and input_tokens is not None and output_tokens is not None:
        total_tokens = input_tokens + output_tokens
    model_provider = string_value(model_config, "provider")
    model_name = string_value(model_config, "model")
    estimated_cost_usd, pricing = estimate_cost_usd(model_provider, model_name, input_tokens, output_tokens)

    return EvalResult(
        prompt=prompt,
        answer=answer_payload.get("response"),
        access_mode=access_mode,
        base_url=base_url,
        endpoint=endpoint,
        finish_reason=answer_payload.get("finishReason"),
        model_provider=model_provider,
        model_name=model_name,
        model_config=model_config,
        request_id=answer_payload.get("requestId"),
        spreadsheet_id=spreadsheet_id,
        spreadsheet_filename=spreadsheet_filename,
        total_seconds=total_seconds,
        upload_seconds=upload_seconds,
        answer_seconds=answer_seconds,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        estimated_cost_usd=estimated_cost_usd,
        pricing=pricing,
        usage=usage,
    )


def save_benchmark_run(base_url: str, result: EvalResult) -> None:
    payload = {
        "id": str(uuid.uuid4()),
        "answer": result.answer or "",
        "answerSeconds": result.answer_seconds,
        "error": result.error,
        "evidence": {
            "accessMode": result.access_mode,
            "endpoint": result.endpoint,
            "estimatedCostUsd": result.estimated_cost_usd,
            "model": result.model_config,
            "pricing": result.pricing,
            "usage": result.usage,
        },
        "finishReason": result.finish_reason,
        "inputTokens": result.input_tokens,
        "modelName": result.model_name,
        "modelProvider": result.model_provider,
        "outputTokens": result.output_tokens,
        "prompt": result.prompt,
        "quality": None,
        "requestId": result.request_id,
        "spreadsheetFilename": result.spreadsheet_filename,
        "spreadsheetId": result.spreadsheet_id or "unknown",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "totalSeconds": result.total_seconds,
        "totalTokens": result.total_tokens,
        "uploadSeconds": result.upload_seconds,
    }
    post_json(f"{base_url}/api/benchmarks/runs", payload)


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
            upload_payload = upload_spreadsheet(base_url, spreadsheet_path, pre_extract=True if args.compare_access_modes else not args.no_pre_extract)
            upload_seconds = time.perf_counter() - upload_started
            spreadsheet = upload_payload.get("spreadsheet", {})
            spreadsheet_id = spreadsheet.get("id")
            spreadsheet_filename = spreadsheet.get("filename", spreadsheet_path.name)

        if not spreadsheet_id:
            raise ValueError("Provide --csv/--spreadsheet or --spreadsheet-id.")

        spreadsheet = wait_for_spreadsheet_ready(base_url, spreadsheet_id)
        spreadsheet_filename = spreadsheet_filename or spreadsheet.get("filename")

        if args.compare_access_modes:
            results: list[EvalResult] = []
            for model in parse_model_specs(args.models):
                for access_mode in parse_access_modes(args.access_modes):
                    run_started = time.perf_counter()
                    try:
                        endpoint, answer_payload, answer_seconds = ask_spreadsheet(base_url, spreadsheet_id, prompt, access_mode, model)
                        result = eval_result_from_answer(
                            access_mode=access_mode,
                            answer_payload=answer_payload,
                            answer_seconds=answer_seconds,
                            base_url=base_url,
                            endpoint=endpoint,
                            prompt=prompt,
                            spreadsheet_filename=spreadsheet_filename,
                            spreadsheet_id=spreadsheet_id,
                            total_seconds=time.perf_counter() - run_started,
                            upload_seconds=upload_seconds,
                        )
                    except Exception as exc:
                        result = EvalResult(
                            prompt=prompt,
                            answer=None,
                            access_mode=access_mode,
                            base_url=base_url,
                            endpoint=f"{base_url}/api/spreadsheets/{spreadsheet_id}/agent-request",
                            finish_reason=None,
                            model_provider=model.provider,
                            model_name=model.model,
                            model_config={"provider": model.provider, "model": model.model},
                            request_id=None,
                            spreadsheet_id=spreadsheet_id,
                            spreadsheet_filename=spreadsheet_filename,
                            total_seconds=time.perf_counter() - run_started,
                            upload_seconds=upload_seconds,
                            answer_seconds=0,
                            input_tokens=None,
                            output_tokens=None,
                            total_tokens=None,
                            estimated_cost_usd=None,
                            pricing={
                                "currency": "USD",
                                "modelKey": f"{model.provider}:{model.model}",
                                "pricingAvailable": f"{model.provider}:{model.model}" in MODEL_PRICES_PER_1M_TOKENS,
                                "unit": "1M tokens",
                            },
                            usage=None,
                            error=str(exc),
                        )
                    if args.save_to_benchmarks:
                        save_benchmark_run(base_url, result)
                    results.append(result)

            write_result(results, args.output, args.jsonl)
            return 0

        endpoint, answer_payload, answer_seconds = ask_spreadsheet(base_url, spreadsheet_id, prompt, args.access_mode, None)
        result = eval_result_from_answer(
            access_mode=args.access_mode,
            answer_payload=answer_payload,
            answer_seconds=answer_seconds,
            base_url=base_url,
            endpoint=endpoint,
            prompt=prompt,
            spreadsheet_filename=spreadsheet_filename,
            spreadsheet_id=spreadsheet_id,
            total_seconds=time.perf_counter() - total_started,
            upload_seconds=upload_seconds,
        )
        if args.save_to_benchmarks:
            save_benchmark_run(base_url, result)
        write_result(result, args.output, args.jsonl)
        return 0
    except Exception as exc:
        result = EvalResult(
            prompt=prompt,
            answer=None,
            access_mode=args.access_mode,
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
            estimated_cost_usd=None,
            pricing=None,
            usage=None,
            error=str(exc),
        )
        write_result(result, args.output, args.jsonl)
        return 1


if __name__ == "__main__":
    sys.exit(main())
