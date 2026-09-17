"""Permission-gated imports with local probing and sanitized provenance."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

MAX_BYTES = 500 * 1024 * 1024
MAX_DURATION = 600


class MediaError(ValueError):
    """A media failure with a message suitable for the local UI."""


class SetupError(MediaError):
    """An unavailable local executable; no download is attempted."""


class URLImportError(MediaError):
    """A failed public URL import with a local-file fallback."""


@dataclass
class RawImport:
    path: Path
    sha256: str
    duration: float
    metadata: dict
    provenance: dict = field(default_factory=dict)
    performance_group_id: str = ""
    _temporary: object = field(default=None, repr=False)

    def close(self):
        if self._temporary is not None:
            self._temporary.cleanup()
            self._temporary = None
    # Summary: This releases a URL import's owned temporary storage after export.
    # Caller-owned destination directories are retained; cleanup says nothing about permission rights.


def require_tool(name):
    path = shutil.which(name)
    if path is None:
        if name == "yt-dlp":
            raise SetupError("yt-dlp is missing from PATH. Run brew install yt-dlp, or "
                             ".venv/bin/pip install -r lesson_builder/requirements.txt "
                             "and add .venv/bin to PATH.")
        raise SetupError("ffmpeg/ffprobe is missing from PATH. Run brew install ffmpeg "
                         "and ensure both ffmpeg and ffprobe are on PATH.")
    return path
# Summary: This distinguishes downloader setup from decoder setup without installing software.
# Executable presence alone does not establish codec support.


def run_media(args, *, timeout=180, message="Media processing failed; try a local WAV export."):
    try:
        return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        name = Path(args[0]).name
        raise SetupError(f"{name} became unavailable. Run brew install ffmpeg yt-dlp "
                         "and check PATH.") from None
    except (subprocess.SubprocessError, OSError):
        # stderr and exception strings can contain URLs, headers, or local paths.
        raise MediaError(message) from None
# Summary: This bounds subprocess duration and exposes only actionable, authored error text.
# It suppresses untrusted diagnostic strings; it does not repair damaged media.


def tool_version(name):
    result = run_media([require_tool(name), "--version" if name == "yt-dlp" else "-version"],
                       timeout=10, message=f"Cannot run {name}; reinstall it and check PATH.")
    return result.stdout.splitlines()[0]
# Summary: This records the installed tool's reported version for reproducibility.
# A version string does not guarantee bit-identical decoding across platforms.


def safe_url(url):
    try:
        parts = urlsplit(url)
        if parts.scheme not in ("https", "http") or not parts.hostname or parts.username or parts.password:
            raise ValueError
        # Only a public video ID survives query sanitization; tracking/auth query data does not.
        query = urlencode([(k, v) for k, v in parse_qsl(parts.query) if k == "v"])
        return urlunsplit((parts.scheme, parts.netloc, parts.path, query, ""))
    except (ValueError, TypeError):
        raise URLImportError("Use a public HTTP(S) clip URL without credentials, or download "
                             "the clip yourself and use local-file import.") from None
# Summary: This removes query/fragment metadata and refuses embedded login credentials.
# Public path components remain source identifiers; this is not a general secret scanner.


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()
# Summary: This measures exact raw-byte identity without loading the entire file.
# Independently transcoded copies have different hashes and cannot be grouped automatically by this fallback.


def import_local_file(path, owner_confirmed_permission: bool) -> RawImport:
    if owner_confirmed_permission is not True:
        raise ValueError("Confirm that you own or have permission to use this material before importing.")
    require_tool("ffmpeg")
    probe = require_tool("ffprobe")
    path = Path(path).resolve()
    if not path.is_file() or not 0 < path.stat().st_size <= MAX_BYTES:
        raise MediaError("Choose a nonempty local media file no larger than 500 MiB.")
    result = run_media([probe, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
                       message="Cannot probe this media. Export a playable audio/video file and import it locally.")
    try:
        metadata = json.loads(result.stdout)
        streams = [s for s in metadata["streams"] if s.get("codec_type") == "audio"]
        if not streams:
            raise MediaError("This file has no audio track. Choose a clip containing audio or import a WAV.")
        duration = float(metadata["format"]["duration"])
        if not 0 < duration <= MAX_DURATION:
            raise MediaError("Use a nonempty clip of at most 10 minutes; shorten the original locally first.")
        stream = streams[0]
        sr, channels = int(stream["sample_rate"]), int(stream["channels"])
        if channels > 8 or duration * sr * channels > 80_000_000:
            raise MediaError("Decoded audio is too large. Use a shorter mono/stereo clip.")
        # Keep structural probe fields, not arbitrary source tags that might contain auth data.
        clean = {"format": {k: metadata["format"].get(k) for k in
                           ("format_name", "duration", "start_time")},
                 "audio": {k: stream.get(k) for k in ("index", "codec_name", "sample_fmt", "sample_rate",
                            "channels", "channel_layout", "start_time", "duration", "bits_per_raw_sample")}}
        identity = file_hash(path)
    except (KeyError, TypeError, ValueError, OSError) as error:
        if isinstance(error, MediaError):
            raise
        raise MediaError("Incomplete or malformed media metadata. Export a WAV and import it locally.") from None
    return RawImport(path, identity, duration, clean,
        {"sourceType": "local_file", "url": None, "creator": None, "uploadDate": None,
         "importedAt": datetime.now(timezone.utc).isoformat(), "fileHash": identity,
         "ffmpegVersion": tool_version("ffmpeg"), "ffprobeVersion": tool_version("ffprobe"),
         "ytDlpVersion": None}, "sha256:" + identity)
# Summary: This enforces explicit permission, measures raw-byte identity, and probes the first audio track.
# Container duration and stream timestamps are retained; successful probing does not establish ownership or musical meaning.


def import_url(url, owner_confirmed_permission: bool, dest_dir=None) -> RawImport:
    if owner_confirmed_permission is not True:
        raise ValueError("Confirm that you own or have permission to use this material before importing.")
    # Discard token-like query material before even invoking the downloader.
    url = safe_url(url)
    downloader = require_tool("yt-dlp")
    require_tool("ffmpeg")
    require_tool("ffprobe")
    temporary = tempfile.TemporaryDirectory(prefix="lesson-import-", dir=dest_dir)
    fallback = ("Public URL import failed or is unsupported. Download the clip yourself using "
                "the platform's permitted options, then use local-file import.")
    try:
        # Full info JSON is captured only in memory: persisting it can save signed media URLs.
        # Ignore user config so it cannot inject cookies, credentials, or external postprocessors.
        args = [downloader, "--ignore-config", "--no-cache-dir", "--no-playlist", "--no-progress",
                "--max-filesize", "500M", "--socket-timeout", "30", "--retries", "1",
                "--format", "bestaudio/best", "--no-simulate", "--print", "after_move:%()j",
                "--output", str(Path(temporary.name) / "media.%(ext)s"), "--", url]
        result = run_media(args, timeout=180, message=fallback)
        info = json.loads(result.stdout.strip().splitlines()[-1])
        paths = [p for p in Path(temporary.name).glob("media.*")
                 if p.suffix not in (".part", ".ytdl", ".json")]
        if len(paths) != 1 or paths[0].stat().st_size > MAX_BYTES:
            raise URLImportError(fallback)
        raw = import_local_file(paths[0], True)
        canonical = safe_url(info.get("webpage_url") or url)
        platform = info.get("extractor_key") or info.get("extractor")
        video_id = info.get("id")
        raw.provenance.update(sourceType="url", url=canonical,
            creator=info.get("creator") or info.get("uploader"), uploader=info.get("uploader"),
            uploadDate=info.get("upload_date"), platform=platform, videoId=video_id,
            ytDlpVersion=tool_version("yt-dlp"),
            importCommand=["yt-dlp", *args[1:-3], "<temporary>/media.%(ext)s", "--", canonical])
        if platform and video_id:
            raw.performance_group_id = "video:" + hashlib.sha256(
                f"{str(platform).lower()}:{video_id}".encode()).hexdigest()
        raw._temporary = temporary
        return raw
    except SetupError:
        temporary.cleanup()
        raise
    except (MediaError, ValueError, IndexError, OSError):
        temporary.cleanup()
        raise URLImportError(fallback) from None
# Summary: This downloads one public clip with a size limit, timeout, and no authentication bypass.
# Only safe provenance fields survive; platform access can fail, and URL grouping depends on extractor IDs.

# Module summary: Imports stay local except for the explicitly requested public media download.
# Permission is a caller declaration, not verified rights; no media is sent to an AI service.
