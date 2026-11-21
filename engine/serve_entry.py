"""Entry point for `agents serve` (Mistral Studio): the Vigil Detective, bound to one local app.

    uv run --project engine agents serve engine

Runs the agent on this laptop (so attacks still only reach the app's loopback address from
.vigil/target.json), registers it in your Mistral workspace and prints a link to trigger it from Studio.
Every step is logged to engine/runs/serve-<time>.jsonl, which the live page can replay ("Load run").
Env: MISTRAL_API_KEY (required), VIGIL_APP (default: ../demo-app), VIGIL_TARGET_URL (optional loopback override).
"""
from __future__ import annotations

import os
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import mistral_agent  # noqa: E402
import profile  # noqa: E402
from run import EventLog  # noqa: E402
from tools import Tools  # noqa: E402

APP = Path(os.environ.get("VIGIL_APP") or HERE.parent / "demo-app").resolve()
_prof = profile.load_profile(APP, os.environ.get("VIGIL_TARGET_URL"))  # refuses non-loopback targets
_log = EventLog(HERE / "runs" / f"serve-{datetime.now():%Y%m%d-%H%M%S}.jsonl")
# Approval happens in the SDK permission policy (apply_fix = "ask", answered in Studio); once the platform
# lets the call through, the tool may write. Safety still comes from the re-proof and automatic rollback.
_tools = Tools(APP, target=_prof["target"], emit=_log.emit, approved=lambda file, content: True)
mistral_agent._CTX.update(tools=_tools, gate=None, emit=_log.emit, proofs=[], applied=None, scan=None)

agent = mistral_agent.build_agent()
