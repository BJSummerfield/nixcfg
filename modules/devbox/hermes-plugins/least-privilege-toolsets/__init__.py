"""least-privilege-toolsets — register restricted custom toolsets for least-privilege roles.

Tool restriction in Hermes is toolset-granular: the built-in ``file`` toolset is indivisible
(``read_file``, ``write_file``, ``patch``, ``search_files``), so a reviewer profile granted
``file`` can also WRITE. This plugin uses ``toolsets.create_custom_toolset`` — the documented
escape hatch that takes an explicit tool-name list — to publish narrower toolsets:

    readonly  -> read_file, search_files
    verify    -> read_file, search_files, terminal, process_manage

Both names then satisfy ``toolsets.validate_toolset``, resolve through
``toolsets.resolve_toolset``, and can be used as ``hermes -t readonly`` or as a profile's
``platform_toolsets.cli`` list (explicit non-configurable entries pass through
``_get_platform_tools``).

Registration is idempotent and never raises into plugin discovery.
"""

from __future__ import annotations

import logging
from typing import Dict, List

logger = logging.getLogger(__name__)

# name -> (description, explicit tool-name list)
CUSTOM_TOOLSETS: Dict[str, tuple] = {
    "readonly": (
        "Read-only file access: read_file + search_files. No write_file, no patch, "
        "no terminal. For reviewer/auditor roles that must never mutate the workspace.",
        ["read_file", "search_files"],
    ),
    "verify": (
        "Read-only file access plus command execution: read_file, search_files, "
        "terminal, process_manage. Can RUN tests/builds but cannot edit files.",
        ["read_file", "search_files", "terminal", "process_manage"],
    ),
}


def _install() -> List[str]:
    """Create the custom toolsets in the shared TOOLSETS table. Returns names installed."""
    import toolsets as _toolsets

    installed: List[str] = []
    for name, (description, tools) in CUSTOM_TOOLSETS.items():
        existing = _toolsets.TOOLSETS.get(name)
        if existing is not None and list(existing.get("tools") or []) == list(tools):
            installed.append(name)
            continue  # already correct (double discovery / force reload)
        if existing is not None:
            logger.warning(
                "least-privilege-toolsets: overwriting existing toolset %r (was %s)",
                name, sorted(existing.get("tools") or []),
            )
        _toolsets.create_custom_toolset(name, description, tools=list(tools))
        installed.append(name)

    # create_custom_toolset mutates TOOLSETS after resolve_toolset() may already have
    # memoized a miss for these names; drop the memo so the first lookup is correct.
    try:
        _toolsets._resolve_toolset_memo.clear()
    except Exception:  # pragma: no cover - private detail, best effort
        logger.debug("least-privilege-toolsets: resolve memo clear failed", exc_info=True)
    return installed


# Install at import time as well as in register(): some host code paths read TOOLSETS
# before hook registration completes, and _install() is idempotent.
try:
    _install()
except Exception:  # pragma: no cover
    logger.warning("least-privilege-toolsets: import-time install failed", exc_info=True)


def register(ctx) -> None:
    """Plugin entrypoint — publish the restricted toolsets."""
    try:
        installed = _install()
    except Exception:
        logger.warning("least-privilege-toolsets: failed to register toolsets", exc_info=True)
        return
    logger.info("least-privilege-toolsets: registered toolsets %s", ", ".join(installed))
