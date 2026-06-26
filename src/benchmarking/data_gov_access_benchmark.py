#!/usr/bin/env python3
"""Build a data.gov.uk spreadsheet benchmark for raw Python vs extracted SQLite.

The runner discovers spreadsheet-like resources from data.gov.uk, uploads them
with pre-extraction enabled, waits until each document is ready, asks a standard
question set through both benchmark access modes, and saves rows to the app's
benchmark_runs table.

Example:
  python src/benchmarking/data_gov_access_benchmark.py \
    --base-url https://xlsx-song.example.workers.dev \
    --limit 100 \
    --save-to-benchmarks
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import re
import sys
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib import parse, request

from llm_testing import (
    EvalResult,
    ModelSpec,
    ask_spreadsheet,
    eval_result_from_answer,
    normalize_base_url,
    parse_access_modes,
    parse_model_specs,
    post_json,
    upload_spreadsheet,
    wait_for_spreadsheet_ready,
)


DEFAULT_BASE_URL = "http://localhost:5173"
DEFAULT_OUTPUT_DIR = Path("benchmarks/data-gov-access")
DEFAULT_MODEL = "openai:gpt-5.5"
DEFAULT_ACCESS_MODES = "sqlite,raw"
DEFAULT_QUESTIONS = [
    "What is this spreadsheet about? Give the subject, geography, time period, and the main measures.",
    "What tables or sheets are available, and how many rows does each one contain?",
    "Find three notable numeric facts in the document. Include the source columns or sheet names you used.",
    "What is the latest time period in the document, and what values are reported for it?",
]


@dataclass
class DataGovResourceCandidate:
    dataset_id: str
    dataset_title: str
    resource_id: str
    resource_name: str
    format: str
    url: str
    size: int | None


@dataclass
class UploadedDocument:
    candidate: DataGovResourceCandidate
    filename: str
    spreadsheet_id: str
    spreadsheet_filename: str
    upload_seconds: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload 100 data.gov.uk spreadsheet documents and benchmark sqlite vs raw Python access.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"Worker/dev-server origin. Default: {DEFAULT_BASE_URL}")
    parser.add_argument("--limit", type=int, default=100, help="Number of documents to upload and benchmark. Default: 100")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help=f"Directory for downloaded files and JSONL output. Default: {DEFAULT_OUTPUT_DIR}")
    parser.add_argument("--query", default="statistics", help="Fallback package_search query if package_list is unavailable. Default: statistics")
    parser.add_argument("--max-size-mb", type=float, default=8, help="Skip resources larger than this. Default: 8")
    parser.add_argument("--models", default=DEFAULT_MODEL, help="Comma-separated provider:model list. Default: openai:gpt-5.5")
    parser.add_argument("--access-modes", default=DEFAULT_ACCESS_MODES, help="Comma-separated access modes. Default: sqlite,raw")
    parser.add_argument("--questions-file", help="JSON or newline text file of benchmark questions.")
    parser.add_argument("--save-to-benchmarks", action="store_true", help="Persist benchmark rows to /api/benchmarks/runs.")
    parser.add_argument("--discovery-only", action="store_true", help="Only discover candidate resources and write candidates.jsonl.")
    parser.add_argument("--skip-existing", action="store_true", default=True, help="Reuse manifest entries already uploaded in a previous run.")
    parser.add_argument("--delay-seconds", type=float, default=1.0, help="Delay between answer requests. Default: 1")
    return parser.parse_args()


def data_gov_json(action: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"https://data.gov.uk/api/action/{action}"
    if params:
        url = f"{url}?{parse.urlencode(params)}"
    http_request = request.Request(url, headers={"accept": "application/json", "user-agent": "xlsx-song-agent-sandbox-benchmark/1.0"})
    with request.urlopen(http_request, timeout=60) as response:
        content_type = response.headers.get("content-type", "")
        text = response.read().decode("utf-8", errors="replace")
    if "json" not in content_type and not text.lstrip().startswith("{"):
        raise RuntimeError(f"data.gov.uk {action} did not return JSON: {text[:120]}")
    payload = json.loads(text)
    if not payload.get("success", False):
        raise RuntimeError(f"data.gov.uk {action} returned success=false")
    return payload


def supported_resource(resource: dict[str, Any]) -> bool:
    url = str(resource.get("url") or "")
    fmt = str(resource.get("format") or "").lower()
    return bool(re.search(r"\.(csv|tsv|xlsx?|ods|xml)(?:[?#].*)?$", url, re.I) or any(part in fmt for part in ["csv", "tsv", "xls", "xlsx", "ods", "xml"]))


def safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip(".-")
    return cleaned[:140] or f"data-gov-{uuid.uuid4().hex}.csv"


def filename_for(candidate: DataGovResourceCandidate) -> str:
    parsed = parse.urlparse(candidate.url)
    url_name = parse.unquote(Path(parsed.path).name)
    if re.search(r"\.[A-Za-z0-9]+$", url_name):
        return safe_filename(url_name)
    extension = candidate.format.lower().replace(".", "")
    if extension not in {"csv", "tsv", "xls", "xlsx", "ods", "xml"}:
        extension = "csv"
    return safe_filename(f"{candidate.resource_name or candidate.dataset_title}.{extension}")


def package_to_candidates(package: dict[str, Any], max_size_bytes: int) -> list[DataGovResourceCandidate]:
    dataset_id = str(package.get("id") or package.get("name") or "")
    dataset_title = str(package.get("title") or dataset_id or "data.gov.uk dataset")
    candidates: list[DataGovResourceCandidate] = []
    for resource in package.get("resources") or []:
        if not isinstance(resource, dict) or not supported_resource(resource):
            continue
        url = str(resource.get("url") or "")
        if not url.startswith(("http://", "https://")):
            continue
        raw_size = resource.get("size")
        size = int(raw_size) if isinstance(raw_size, int) or (isinstance(raw_size, str) and raw_size.isdigit()) else None
        if size is not None and size > max_size_bytes:
            continue
        candidates.append(
            DataGovResourceCandidate(
                dataset_id=dataset_id,
                dataset_title=dataset_title,
                resource_id=str(resource.get("id") or url),
                resource_name=str(resource.get("name") or resource.get("description") or filename_for_url(url)),
                format=str(resource.get("format") or Path(parse.urlparse(url).path).suffix.lstrip(".") or "csv"),
                url=url,
                size=size,
            )
        )
    return candidates


def filename_for_url(url: str) -> str:
    return parse.unquote(Path(parse.urlparse(url).path).name) or "data.gov.uk resource"


def discover_candidates(limit: int, query: str, max_size_bytes: int) -> list[DataGovResourceCandidate]:
    candidates: list[DataGovResourceCandidate] = []
    seen_urls: set[str] = set()

    try:
        package_list = data_gov_json("package_list")
        package_ids = [str(item) for item in package_list.get("result", []) if isinstance(item, str)]
        for package_id in package_ids:
            if len(candidates) >= limit:
                break
            try:
                package = data_gov_json("package_show", {"id": package_id}).get("result") or {}
            except Exception as exc:
                print(f"Skipping package {package_id}: {exc}", file=sys.stderr)
                continue
            for candidate in package_to_candidates(package, max_size_bytes):
                if candidate.url in seen_urls:
                    continue
                seen_urls.add(candidate.url)
                candidates.append(candidate)
                if len(candidates) >= limit:
                    break
    except Exception as exc:
        print(f"package_list unavailable, falling back to package_search: {exc}", file=sys.stderr)

    page = 0
    while len(candidates) < limit:
        payload = data_gov_json("package_search", {"q": query, "rows": 100, "start": page * 100})
        results = (payload.get("result") or {}).get("results") or []
        if not results:
            break
        for package in results:
            if not isinstance(package, dict):
                continue
            for candidate in package_to_candidates(package, max_size_bytes):
                if candidate.url in seen_urls:
                    continue
                seen_urls.add(candidate.url)
                candidates.append(candidate)
                if len(candidates) >= limit:
                    break
            if len(candidates) >= limit:
                break
        page += 1

    return candidates[:limit]


def append_jsonl(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def read_uploaded_manifest(path: Path) -> dict[str, UploadedDocument]:
    if not path.exists():
        return {}
    uploaded: dict[str, UploadedDocument] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        candidate = DataGovResourceCandidate(**item["candidate"])
        uploaded[candidate.url] = UploadedDocument(candidate=candidate, **{key: item[key] for key in ["filename", "spreadsheet_id", "spreadsheet_filename", "upload_seconds"]})
    return uploaded


def download_resource(candidate: DataGovResourceCandidate, output_dir: Path) -> Path:
    filename = filename_for(candidate)
    path = output_dir / "files" / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > 0:
        return path
    http_request = request.Request(candidate.url, headers={"user-agent": "xlsx-song-agent-sandbox-benchmark/1.0"})
    with request.urlopen(http_request, timeout=180) as response:
        data = response.read()
        content_type = response.headers.get("content-type") or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    if not data:
        raise RuntimeError("downloaded file was empty")
    if "html" in content_type.lower() and not filename.lower().endswith((".html", ".xml")):
        raise RuntimeError(f"resource returned HTML instead of a spreadsheet ({content_type})")
    path.write_bytes(data)
    return path


def load_questions(path: str | None) -> list[str]:
    if not path:
        return DEFAULT_QUESTIONS
    text = Path(path).read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("questions file is empty")
    if text.lstrip().startswith("["):
        loaded = json.loads(text)
        if not isinstance(loaded, list) or not all(isinstance(item, str) for item in loaded):
            raise ValueError("questions JSON must be a string array")
        return [item.strip() for item in loaded if item.strip()]
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def result_score(result: EvalResult) -> float:
    if result.error or not result.answer:
        return -1_000_000
    cost = result.estimated_cost_usd if result.estimated_cost_usd is not None else 0.001
    tokens = result.total_tokens if result.total_tokens is not None else 2_000
    answer_bonus = min(len(result.answer), 2_000) / 2_000
    return answer_bonus - (result.answer_seconds * 0.08) - (cost * 60) - (tokens / 100_000)


def save_comparison_run(base_url: str, result: EvalResult, group_id: str, document_index: int, question_index: int, winner: str | None, competitor_count: int) -> None:
    quality = 5 if result.access_mode == winner else 3
    if result.error:
        quality = 1
    payload = {
        "answer": result.answer or "",
        "answerSeconds": result.answer_seconds,
        "error": result.error,
        "evidence": {
            "accessMode": result.access_mode,
            "benchmarkGroupId": group_id,
            "competitorCount": competitor_count,
            "documentIndex": document_index,
            "endpoint": result.endpoint,
            "estimatedCostUsd": result.estimated_cost_usd,
            "model": result.model_config,
            "pricing": result.pricing,
            "questionIndex": question_index,
            "usage": result.usage,
            "winner": winner,
        },
        "finishReason": result.finish_reason,
        "inputTokens": result.input_tokens,
        "modelName": result.model_name,
        "modelProvider": result.model_provider,
        "outputTokens": result.output_tokens,
        "prompt": result.prompt,
        "quality": quality,
        "requestId": result.request_id,
        "spreadsheetFilename": result.spreadsheet_filename,
        "spreadsheetId": result.spreadsheet_id or "unknown",
        "totalSeconds": result.total_seconds,
        "totalTokens": result.total_tokens,
        "uploadSeconds": result.upload_seconds,
    }
    post_json(f"{base_url}/api/benchmarks/runs", payload)


def main() -> int:
    args = parse_args()
    base_url = normalize_base_url(args.base_url)
    output_dir = Path(args.output_dir)
    candidates_path = output_dir / "candidates.jsonl"
    manifest_path = output_dir / "uploaded.jsonl"
    results_path = output_dir / "results.jsonl"
    max_size_bytes = int(args.max_size_mb * 1024 * 1024)
    group_id = f"data-gov-access-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}"
    output_dir.mkdir(parents=True, exist_ok=True)

    questions = load_questions(args.questions_file)
    models = parse_model_specs(args.models)
    access_modes = parse_access_modes(args.access_modes)

    candidates = discover_candidates(args.limit, args.query, max_size_bytes)
    candidates_path.write_text("", encoding="utf-8")
    for candidate in candidates:
        append_jsonl(candidates_path, asdict(candidate))

    print(f"Discovered {len(candidates)} candidate resources. Wrote {candidates_path}.")
    if args.discovery_only:
        return 0

    uploaded_manifest = read_uploaded_manifest(manifest_path) if args.skip_existing else {}

    for document_index, candidate in enumerate(candidates, start=1):
        try:
            if candidate.url in uploaded_manifest:
                uploaded = uploaded_manifest[candidate.url]
                print(f"[{document_index}/{len(candidates)}] Reusing {uploaded.spreadsheet_filename} ({uploaded.spreadsheet_id})")
            else:
                file_path = download_resource(candidate, output_dir)
                started = time.perf_counter()
                upload_payload = upload_spreadsheet(base_url, file_path, pre_extract=True)
                upload_seconds = time.perf_counter() - started
                spreadsheet = upload_payload.get("spreadsheet") or {}
                spreadsheet_id = spreadsheet.get("id")
                if not spreadsheet_id:
                    raise RuntimeError("upload response did not include spreadsheet.id")
                ready_spreadsheet = wait_for_spreadsheet_ready(base_url, spreadsheet_id)
                uploaded = UploadedDocument(
                    candidate=candidate,
                    filename=file_path.name,
                    spreadsheet_id=spreadsheet_id,
                    spreadsheet_filename=ready_spreadsheet.get("filename") or spreadsheet.get("filename") or file_path.name,
                    upload_seconds=upload_seconds,
                )
                uploaded_payload = asdict(uploaded)
                uploaded_payload["candidate"] = asdict(candidate)
                append_jsonl(manifest_path, uploaded_payload)
                print(f"[{document_index}/{len(candidates)}] Uploaded {uploaded.spreadsheet_filename} ({uploaded.spreadsheet_id})")

            for question_index, question in enumerate(questions, start=1):
                prompt = f"{question}\n\nAnswer using concise evidence from this specific spreadsheet."
                pair_results: list[EvalResult] = []
                for model in models:
                    for access_mode in access_modes:
                        run_started = time.perf_counter()
                        try:
                            endpoint, answer_payload, answer_seconds = ask_spreadsheet(base_url, uploaded.spreadsheet_id, prompt, access_mode, model)
                            result = eval_result_from_answer(
                                access_mode=access_mode,
                                answer_payload=answer_payload,
                                answer_seconds=answer_seconds,
                                base_url=base_url,
                                endpoint=endpoint,
                                prompt=prompt,
                                spreadsheet_filename=uploaded.spreadsheet_filename,
                                spreadsheet_id=uploaded.spreadsheet_id,
                                total_seconds=time.perf_counter() - run_started,
                                upload_seconds=uploaded.upload_seconds,
                            )
                        except Exception as exc:
                            result = EvalResult(
                                prompt=prompt,
                                answer=None,
                                access_mode=access_mode,
                                base_url=base_url,
                                endpoint=f"{base_url}/api/spreadsheets/{uploaded.spreadsheet_id}/agent-request",
                                finish_reason=None,
                                model_provider=model.provider,
                                model_name=model.model,
                                model_config={"provider": model.provider, "model": model.model},
                                request_id=None,
                                spreadsheet_id=uploaded.spreadsheet_id,
                                spreadsheet_filename=uploaded.spreadsheet_filename,
                                total_seconds=time.perf_counter() - run_started,
                                upload_seconds=uploaded.upload_seconds,
                                answer_seconds=0,
                                input_tokens=None,
                                output_tokens=None,
                                total_tokens=None,
                                estimated_cost_usd=None,
                                pricing=None,
                                usage=None,
                                error=str(exc),
                            )
                        pair_results.append(result)
                        append_jsonl(results_path, {**asdict(result), "benchmarkGroupId": group_id, "documentIndex": document_index, "questionIndex": question_index})
                        time.sleep(args.delay_seconds)

                winner_result = max(pair_results, key=result_score) if pair_results else None
                winner = winner_result.access_mode if winner_result and result_score(winner_result) > -1_000_000 else None
                if args.save_to_benchmarks:
                    for result in pair_results:
                        save_comparison_run(base_url, result, group_id, document_index, question_index, winner, len(pair_results))
                print(f"  Q{question_index}: winner={winner or 'none'}")
        except Exception as exc:
            append_jsonl(output_dir / "errors.jsonl", {"candidate": asdict(candidate), "documentIndex": document_index, "error": str(exc)})
            print(f"[{document_index}/{len(candidates)}] Failed {candidate.url}: {exc}", file=sys.stderr)

    print(f"Done. Results: {results_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
