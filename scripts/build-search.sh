#!/usr/bin/env bash
set -euo pipefail

# ── build-search.sh ───────────────────────────────────────────────
# Builds the portable search distribution (agntspce-search MCP server)
# for the current platform using python-build-standalone.
#
# Usage: bash scripts/build-search.sh
#   Output: <project>/search/  (portable Python + search server)
#
# Requirements: curl, tar, ~800MB disk space, ~3min on fast connection
# ─────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$PROJECT_DIR/search"
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

# ── Config ───────────────────────────────────────────────────────
PYTHON_VERSION="3.13.14"
RELEASE_TAG="20260623"
PLATFORM="aarch64-apple-darwin"
ARCHIVE_NAME="cpython-${PYTHON_VERSION}+${RELEASE_TAG}-${PLATFORM}-install_only_stripped.tar.gz"
DOWNLOAD_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}/${ARCHIVE_NAME}"

echo "=== build-search.sh ==="
echo "Python: $PYTHON_VERSION"
echo "Platform: $PLATFORM"
echo "Output: $OUTPUT_DIR"
echo ""

# ── Download & extract python-build-standalone ───────────────────
echo "[1/4] Downloading python-build-standalone..."
curl -sL "$DOWNLOAD_URL" -o "$SCRATCH/python.tar.gz"
echo "  Downloaded: $(ls -lh "$SCRATCH/python.tar.gz" | awk '{print $5}')"

echo "[2/4] Extracting..."
tar xzf "$SCRATCH/python.tar.gz" -C "$SCRATCH"
PYTHON_BIN="$SCRATCH/python/bin/python3"
echo "  Python: $($PYTHON_BIN --version)"

# ── Install search package ───────────────────────────────────────
# NOTE: "semble[mcp]" is the upstream pip dependency name — it must stay as
#-is for pip to resolve. The user-visible MCP name is rewritten below.
echo "[3/4] Installing search server (semble[mcp] from PyPI)..."
"$SCRATCH/python/bin/pip" install --quiet "semble[mcp]" 2>&1 | tail -1
# Rewrite the display name → agntspce-search so the MCP server announces
# itself as agntspce-search, and create the agntspce_search package copy so
# `from agntspce_search.mcp` works. A python patch is used (not sed) because
# upstream formats the name across lines: FastMCP(\n    "semble", ...).
echo "  Rewriting MCP server display name → agntspce-search..."
"$SCRATCH/python/bin/python3" - "$SCRATCH" <<'PYEOF'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1]) / "python"
name_res = [
    (re.compile(r'FastMCP\(\s*name\s*=\s*["\']semble["\']'), 'FastMCP(name="agntspce-search"'),
    (re.compile(r'FastMCP\(\s*["\']semble["\']'), 'FastMCP("agntspce-search"'),
]
# Display strings only. Functional identifiers (Python imports,
# files("semble") resource refs, "semble[mcp]" pip specs) must stay intact
# for pip and imports to work.
installer_renames = [
    (re.compile(r"mcp__semble__"), "mcp__agntspce-search__"),
    (re.compile(r"## Semble Code Search"), "## AgntSpce Search"),
    (re.compile(r"A `semble` MCP server"), "A `agntspce-search` MCP server"),
    (re.compile(r"After semble returns"), "After agntspce-search returns"),
    (re.compile(r"\[mcp_servers\.semble\]"), "[mcp_servers.agntspce-search]"),
    (re.compile(r"mcp_servers\.semble"), "mcp_servers.agntspce-search"),
    (re.compile(r"one of semble's"), "one of agntspce-search's"),
    (re.compile(r"semble MCP entry"), "agntspce-search MCP entry"),
    (re.compile(r"call semble directly as a tool"), "call agntspce-search directly as a tool"),
    (re.compile(r"Install or uninstall semble across coding agents\."), "Install or uninstall AgntSpce Search across coding agents."),
    (re.compile(r"Semble Uninstaller"), "AgntSpce Search Uninstaller"),
    (re.compile(r"Semble Installer"), "AgntSpce Search Installer"),
    (re.compile(r"Remove semble configuration\?"), "Remove AgntSpce Search configuration?"),
    (re.compile(r"marked semble section"), "marked AgntSpce Search section"),
    (re.compile(r"the semble \[mcp_servers\."), "the agntspce-search [mcp_servers."),
    (re.compile(r"<!-- SEMBLE_START -->"), "<!-- AGNTSPCE_START -->"),
    (re.compile(r"<!-- SEMBLE_END -->"), "<!-- AGNTSPCE_END -->"),
    (re.compile(r"semble-search"), "agntspce-search"),
    (re.compile(r"semble\.md"), "agntspce-search.md"),
    # The old fallback taught agents to uvx-install the upstream package,
    # which created a global `semble` MCP entry on fresh PCs.
    (re.compile(r'If `agntspce-search` is not on `\$PATH`, use `uvx --from "semble\[mcp\]" semble`\.'), "If `agntspce-search` is not on `$PATH`, reinstall or restart AgntSpce to restore the bundled server."),
]

def rewrite_mcp(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    orig = text
    for rx, repl in name_res:
        text = rx.sub(repl, text)
    if text != orig:
        path.write_text(text, encoding="utf-8")
        print(f"  Rewrote server name in {path}")
    if re.search(r'FastMCP\(\s*(?:name\s*=\s*)?["\']semble["\']', text):
        print(f"  WARNING: old server name still present in {path}")

def rewrite_agents_py(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    orig = text
    for rx, repl in installer_renames:
        text = rx.sub(repl, text)
    if "_LEGACY_START" not in text:
        lines = text.split("\n")
        idx = next((i for i, l in enumerate(lines) if l.startswith("SEMBLE_END = ")), -1)
        if idx != -1:
            lines[idx + 1:idx + 1] = [
                "# Markers written by older installs - consulted when replacing/removing docs.",
                '_LEGACY_START = SEMBLE_START.replace("AGNTSPCE", "SEMBLE")',
                '_LEGACY_END = SEMBLE_END.replace("AGNTSPCE", "SEMBLE")',
            ]
            text = "\n".join(lines)
    if text != orig:
        path.write_text(text, encoding="utf-8")
        print(f"  Rewrote installer strings in {path}")

def rewrite_config_py(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    orig = text
    for rx, repl in installer_renames:
        text = rx.sub(repl, text)
    legacy_import = "from semble.installer.agents import SEMBLE_END, SEMBLE_START, Action"
    if "_LEGACY_START" not in text and legacy_import in text:
        text = text.replace(
            legacy_import,
            "from semble.installer.agents import SEMBLE_END, SEMBLE_START, Action, _LEGACY_END, _LEGACY_START",
        )
    migration = "    existing = existing.replace(_LEGACY_START, SEMBLE_START).replace(_LEGACY_END, SEMBLE_END)"
    if "_LEGACY_START" in text and migration not in text:
        anchor = '    existing = path.read_text(encoding="utf-8") if existed else ""'
        if anchor in text:
            text = text.replace(anchor, anchor + "\n" + migration)
        else:
            print(f"  WARNING: replace_or_append_marked anchor missing in {path}")
        anchor2 = '    existing = path.read_text(encoding="utf-8")\n'
        if anchor2 in text:
            text = text.replace(anchor2, anchor2 + migration + "\n")
        else:
            print(f"  WARNING: remove_marked anchor missing in {path}")
    if "_CODEX_MCP_HEADER_LEGACY" not in text:
        lines = text.split("\n")
        idx = next((i for i, l in enumerate(lines) if l.startswith("_CODEX_MCP_HEADER = ")), -1)
        if idx != -1:
            lines[idx + 1:idx + 1] = [
                '_CODEX_MCP_HEADER_LEGACY = _CODEX_MCP_HEADER.replace("agntspce-search", "semble")',
            ]
            text = "\n".join(lines)
        else:
            print(f"  WARNING: _CODEX_MCP_HEADER anchor missing in {path}")
    if "_CODEX_MCP_HEADER_LEGACY" in text:
        merge_anchor = '    base = _strip_toml_section(existing, _CODEX_MCP_HEADER).rstrip("\\n")'
        if merge_anchor in text:
            text = text.replace(
                merge_anchor,
                '    base = _strip_toml_section(_strip_toml_section(existing, _CODEX_MCP_HEADER_LEGACY), _CODEX_MCP_HEADER).rstrip("\\n")',
            )
        cond_anchor = "    if _CODEX_MCP_HEADER not in existing:"
        if cond_anchor in text and "_CODEX_MCP_HEADER_LEGACY not in existing" not in text:
            text = text.replace(
                cond_anchor,
                "    if _CODEX_MCP_HEADER not in existing and _CODEX_MCP_HEADER_LEGACY not in existing:",
            )
        strip_anchor = '    remaining = _strip_toml_section(existing, _CODEX_MCP_HEADER).strip("\\n")'
        if strip_anchor in text:
            text = text.replace(
                strip_anchor,
                '    remaining = _strip_toml_section(_strip_toml_section(existing, _CODEX_MCP_HEADER_LEGACY), _CODEX_MCP_HEADER).strip("\\n")',
            )
    if text != orig:
        path.write_text(text, encoding="utf-8")
        print(f"  Rewrote installer strings in {path}")

def rewrite_installer_py(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    orig = text
    for rx, repl in installer_renames:
        text = rx.sub(repl, text)
    merge_anchor = 'return WriteResult(path, merge_json_member(path, agent.mcp.key, "semble", agent.mcp.entry))'
    if merge_anchor in text:
        text = text.replace(
            merge_anchor,
            'remove_json_member(path, agent.mcp.key, "semble")\n    return WriteResult(path, merge_json_member(path, agent.mcp.key, "agntspce-search", agent.mcp.entry))',
        )
    elif '"agntspce-search", agent.mcp.entry' not in text:
        print(f"  WARNING: merge_mcp anchor missing in {path}")
    remove_anchor = 'return WriteResult(path, remove_json_member(path, agent.mcp.key, "semble"))'
    if remove_anchor in text:
        text = text.replace(
            remove_anchor,
            'remove_json_member(path, agent.mcp.key, "semble")\n    return WriteResult(path, remove_json_member(path, agent.mcp.key, "agntspce-search"))',
        )
    elif 'remove_json_member(path, agent.mcp.key, "agntspce-search")' not in text:
        print(f"  WARNING: remove_mcp anchor missing in {path}")
    if text != orig:
        path.write_text(text, encoding="utf-8")
        print(f"  Rewrote installer MCP key in {path}")

def rewrite_agent_md(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    orig = text
    for rx, repl in installer_renames:
        text = rx.sub(repl, text)
    # Templates are pure docs (no imports): remaining standalone words are
    # CLI/prose references. Fallback first so its pip spec is dropped.
    text = re.sub(
        r'If `semble` is not on `\$PATH`, use `uvx --from "semble\[mcp\]" semble` in its place\.',
        "If `agntspce-search` is not on `$PATH`, reinstall or restart AgntSpce to restore the bundled server.",
        text,
    )
    text = re.sub(r"\bsemble\b", "agntspce-search", text)
    if text != orig:
        path.write_text(text, encoding="utf-8")
        print(f"  Rewrote sub-agent display name in {path}")

def rewrite_cli_py(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    orig = text
    for old, new in [
        ('prog="semble"', 'prog="agntspce-search"'),
        ('"""Entry point for the semble command-line tool."""', '"""Entry point for the agntspce-search command-line tool."""'),
        ('"Configure semble across coding agents."', '"Configure AgntSpce Search across coding agents."'),
        ('"Remove semble configuration from coding agents."', '"Remove AgntSpce Search configuration from coding agents."'),
    ]:
        if old in text:
            text = text.replace(old, new)
        elif new not in text:
            print(f"  WARNING: cli.py anchor missing in {path}: {old[:48]}")
    if text != orig:
        path.write_text(text, encoding="utf-8")
        print(f"  Rewrote CLI display strings in {path}")

def rewrite_stats_py(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    orig = text
    old, new = '"Semble Token Savings"', '"AgntSpce Search Token Savings"'
    if old in text:
        text = text.replace(old, new)
    elif new not in text:
        print(f"  WARNING: stats.py anchor missing in {path}")
    if text != orig:
        path.write_text(text, encoding="utf-8")
        print(f"  Rewrote savings-report title in {path}")

for site in ("Lib/site-packages", "lib/python3.13/site-packages", "lib/python3.12/site-packages"):
    site_dir = root / site
    # Create the agntspce_search copy first (bytecode excluded), then patch both.
    src, dst = site_dir / "semble", site_dir / "agntspce_search"
    if src.is_dir() and not dst.exists():
        import shutil
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"))
        print(f"  Created agntspce_search package at {dst}")
    for pkg in ("semble", "agntspce_search"):
        mcp_py = site_dir / pkg / "mcp.py"
        if mcp_py.is_file():
            rewrite_mcp(mcp_py)
        agents_py = site_dir / pkg / "installer" / "agents.py"
        if agents_py.is_file():
            rewrite_agents_py(agents_py)
        config_py = site_dir / pkg / "installer" / "config.py"
        if config_py.is_file():
            rewrite_config_py(config_py)
        installer_py = site_dir / pkg / "installer" / "installer.py"
        if installer_py.is_file():
            rewrite_installer_py(installer_py)
        agents_dir = site_dir / pkg / "agents"
        if agents_dir.is_dir():
            for md in sorted(list(agents_dir.glob("*.md")) + list(agents_dir.glob("*.toml"))):
                rewrite_agent_md(md)
        cli_py = site_dir / pkg / "cli.py"
        if cli_py.is_file():
            rewrite_cli_py(cli_py)
        stats_py = site_dir / pkg / "stats.py"
        if stats_py.is_file():
            rewrite_stats_py(stats_py)
PYEOF

# Install the forked agntspce-search if the source is available
AGNTSPCE_SEARCH_SRC="$PROJECT_DIR/../CodingAgents/references/agntspce-search"
if [ -d "$AGNTSPCE_SEARCH_SRC" ]; then
  echo "  Installing agntspce-search from local source..."
  "$SCRATCH/python/bin/pip" install --quiet -e "$AGNTSPCE_SEARCH_SRC" 2>&1 | tail -1
fi

# ── Strip bytecode ───────────────────────────────────────────────
echo "[4/4] Stripping .pyc files..."
find "$SCRATCH/python" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
find "$SCRATCH/python" -name '*.pyc' -delete 2>/dev/null || true

# ── Create PYTHONHOME-aware wrapper ─────────────────────────────
BIN_PATH="$SCRATCH/python/bin/agntspce-search"
PYTHON_DIR="$SCRATCH/python"
PYTHON_BIN="$PYTHON_DIR/bin/python3"
if [ -f "$BIN_PATH" ] && [ -f "$PYTHON_BIN" ]; then
  # Rename original script to .py
  mv "$BIN_PATH" "${BIN_PATH}.py"
  # Write shell wrapper with PYTHONHOME
  cat > "$BIN_PATH" << WRAPPER
#!/bin/sh
SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
export PYTHONHOME="\$SCRIPT_DIR/.."
exec "\$SCRIPT_DIR/python3" "${BIN_PATH}.py" "\$@"
WRAPPER
  chmod +x "$BIN_PATH"
  echo "  Wrapper created: $BIN_PATH"
fi

# ── Write VERSION ────────────────────────────────────────────────
echo "0.1.1" > "$SCRATCH/VERSION"

# ── Move to output ───────────────────────────────────────────────
rm -rf "$OUTPUT_DIR"
mv "$SCRATCH" "$OUTPUT_DIR"

echo ""
echo "=== Done ==="
echo "Output: $OUTPUT_DIR"
echo "Size: $(du -sh "$OUTPUT_DIR" | awk '{print $1}')"
echo "Binary: $OUTPUT_DIR/python/bin/agntspce-search"
echo ""

# Verify the binary works
if "$OUTPUT_DIR/python/bin/agntspce-search" --help >/dev/null 2>&1; then
  echo "✓ Binary verified (--help passes)"
else
  echo "⚠ Binary --help failed"
fi
