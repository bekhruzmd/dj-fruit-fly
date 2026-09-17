"""Build local lesson folders with explicit permission and optional reviewed targets."""
import argparse
import json
from pathlib import Path
import tempfile

from .export import export_lesson, prepare_lesson
from .importer import import_local_file, import_url


def build_from_request(request, out_root):
    permission = request.get("ownerConfirmedPermission")
    raw = (import_url(request["url"], permission) if request.get("url") else
           import_local_file(request["path"], permission))
    try:
        with tempfile.TemporaryDirectory(prefix="lesson-build-") as work:
            sources = {name: import_local_file(path, permission)
                       for name, path in request.get("sourcePaths", {}).items()}
            prepared = prepare_lesson(raw, work, start_seconds=request.get("startSeconds"),
                end_seconds=request.get("endSeconds"), human_annotations=request.get("humanAnnotations"),
                source_imports=sources, actions=request.get("observedControllerActions"), title=request.get("title"))
            return export_lesson(prepared, out_root)
    finally:
        raw.close()
# Summary: This runs the same permission-gated build pipeline for CLI and HTTP callers.
# Source paths must refer to separately supplied originals; user declarations remain unverified.


def main():
    parser = argparse.ArgumentParser(description="Build a local DJ lesson; no inferred controller actions.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--file")
    source.add_argument("--url")
    parser.add_argument("--permission-confirmed", action="store_true", help="I own or have permission to use all supplied media")
    parser.add_argument("--out", default=".cache/lessons")
    parser.add_argument("--start", type=float)
    parser.add_argument("--end", type=float)
    parser.add_argument("--title")
    parser.add_argument("--source-a")
    parser.add_argument("--source-b")
    parser.add_argument("--annotations", help="JSON object containing only human annotations")
    parser.add_argument("--actions", help="JSON list of authored/controller_log mixer_rates events")
    args = parser.parse_args()
    try:
        request = {"path": args.file, "url": args.url, "ownerConfirmedPermission": args.permission_confirmed,
                   "startSeconds": args.start, "endSeconds": args.end, "title": args.title,
                   "sourcePaths": {key: path for key, path in (("source_A", args.source_a), ("source_B", args.source_b)) if path},
                   "humanAnnotations": json.loads(Path(args.annotations).read_text()) if args.annotations else {},
                   "observedControllerActions": json.loads(Path(args.actions).read_text()) if args.actions else None}
        print(build_from_request(request, args.out))
    except (ValueError, OSError) as error:
        parser.exit(2, f"Lesson build failed: {error}\n")
# Summary: This exposes repeatable local/URL builds with optional explicit source review and action targets.
# It reports actionable failures and does not infer missing permissions or missing teaching labels.


if __name__ == "__main__":
    main()

# Module summary: Run via python -m lesson_builder.cli in the analysis environment.
# The command builds artifacts; playback, human review quality, and imitation training remain separate responsibilities.
