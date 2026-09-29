"""Opt-in loopback oracle: pinned run/store code, scripted non-inference executor."""
import argparse
import asyncio
import contextlib
import contextvars
import hmac
import itertools
import importlib.metadata
import json
import logging
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import types
import typing
from pathlib import Path

from sources import LOCK, definitions, load_module, verify


def package(name):
    module = types.ModuleType(name)
    module.__path__ = []
    sys.modules[name] = module
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sources", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--time", type=float, required=True)
    parser.add_argument("--allow-disposable-state", action="store_true")
    args = parser.parse_args()
    if not args.allow_disposable_state:
        parser.error("explicit --allow-disposable-state is required")
    root = Path(__file__).resolve().parents[4]
    state = Path(args.state).resolve()
    state.relative_to(root / ".mockingbird" / "hermes-oracle")
    if not state.parent.is_dir():
        parser.error("create a fresh oracle state directory before launch")
    source = Path(args.sources).resolve()
    verify(source)
    if not (3, 11) <= sys.version_info[:2] < (3, 14):
        parser.error("pinned Hermes requires Python >=3.11,<3.14")
    import aiohttp
    from aiohttp import web
    if aiohttp.__version__ != LOCK["aiohttp"]:
        parser.error("aiohttp version differs from source-lock.json")

    provenance = {}
    base = {**{key: value for key, value in vars(typing).items() if not key.startswith("__")}, "asyncio": asyncio, "contextlib": contextlib,
            "ContextVar": contextvars.ContextVar, "contextmanager": contextlib.contextmanager,
            "hmac": hmac, "itertools": itertools, "json": json, "logging": logging,
            "os": os, "re": re, "sqlite3": sqlite3, "subprocess": subprocess,
            "sys": sys, "threading": threading, "time": time, "Path": Path,
            "logger": logging.getLogger("oracle"), "web": web}
    def selected(filename, names, extra=None):
        namespace = {**base, **(extra or {})}
        provenance[filename] = definitions(source / filename, names, namespace)
        return namespace
    for name in ["agent", "gateway", "tools", "hermes_cli"]:
        package(name)
    safety = types.ModuleType("agent.file_safety")
    safety.__dict__.update(selected("file_safety.py", ["_BLOCKED_PROJECT_ENV_BASENAMES"]))
    sys.modules[safety.__name__] = safety
    redactor = load_module(source / "agent_redact.py", "agent.redact")
    interrupt = load_module(source / "interrupt_compat.py", "agent.interrupt_compat")
    sqlite_runtime = load_module(source / "sqlite_runtime.py", "hermes_cli.sqlite_runtime")
    sys.modules[sqlite_runtime.__name__] = sqlite_runtime
    state_module = types.ModuleType("hermes_state")
    state_module.__dict__.update(selected("hermes_state.py", ["apply_wal_with_fallback"], {
        "_is_sqlite_wal_reset_vulnerable": sqlite_runtime.is_sqlite_wal_reset_vulnerable,
    }))
    sys.modules["hermes_state"] = state_module
    status = types.ModuleType("gateway.status")
    status.__dict__.update(selected("gateway_status.py", ["_pid_exists", "get_process_start_time"]))
    sys.modules["gateway.status"] = status
    # Only these execution integration hooks are substituted. They never dispatch
    # tools, persist sessions, spawn child tools or register real approval work.
    approval = types.ModuleType("tools.approval")
    for name in ["register_gateway_notify", "unregister_gateway_notify", "reset_current_session_key", "set_current_session_key"]:
        setattr(approval, name, lambda *a, **k: None)
    sys.modules[approval.__name__] = approval
    session = types.ModuleType("gateway.session_context")
    session.clear_session_vars = lambda *a: None
    sys.modules[session.__name__] = session
    clock = [args.time]
    controlled_time = types.SimpleNamespace(time=lambda: clock[0])
    store_module = load_module(source / "api_server_run_idempotency.py", "oracle_store")
    store_module.time = controlled_time
    runs = load_module(source / "api_server_runs.py", "oracle_runs")
    runs.time = controlled_time
    api = types.SimpleNamespace(**selected("api_server.py", [
        "_openai_error", "_redact_api_error_text", "_request_agent_overrides",
        "_approval_event_choices", "_expected_api_key", "_check_auth", "_parse_session_key_header",
    ], {"redact_sensitive_text": redactor.redact_sensitive_text}))
    api._api_request_profile = contextvars.ContextVar("oracle_profile", default="default")
    api._api_request_browser_control_principal = contextvars.ContextVar("oracle_principal", default=None)
    api._api_request_browser_control_transport_family = contextvars.ContextVar("oracle_transport", default=None)
    api._ProviderAuthResolutionError = type("UnexercisedProviderAuthError", (Exception,), {})
    api._publish_turn_process_ownership = lambda *a: None
    api._clear_turn_process_ownership = lambda *a: None
    api._reap_disconnected_agent_processes = lambda *a, **k: None
    api.request_hard_interrupt = interrupt.request_hard_interrupt
    # Preserve the selected functions' original global context variable binding.
    for name in ["_expected_api_key", "_check_auth"]:
        getattr(api, name).__globals__["_api_request_profile"] = api._api_request_profile
    room = selected("room_grants.py", ["_room_grant_token"])

    class ScriptedAgent:
        session_prompt_tokens = 0
        session_completion_tokens = 0
        session_total_tokens = 0
        def __init__(self):
            self.release = threading.Event()
            self.result = {"final_response": "synthetic output"}
        def hard_interrupt(self, message=None):
            # Hold acknowledgement until the fixture selects cancellation or a
            # completion-winning race; the upstream stop handler owns stopping.
            self.interrupted = True
        def run_conversation(self, **kwargs):
            if not self.release.wait(30):
                raise TimeoutError("oracle executor was not explicitly settled")
            return self.result

    class Adapter:
        _model_name = "hermes-agent"
        _api_key = ""
        _MAX_SESSION_HEADER_LEN = 256
        _RUN_STATUS_TTL = 3600
        _RUN_STREAM_TTL = 300
        _room_grant_token = staticmethod(room["_room_grant_token"])
        _expected_api_key = api._expected_api_key
        _check_auth = api._check_auth
        _parse_session_key_header = api._parse_session_key_header
        def __init__(self):
            self._background_tasks = set()
            self._stopping_run_ids = set()
            self._active_run_agents = {}
            self._active_run_tasks = {}
            self._response_store = {}
            runs._initialize_run_state(self, store_factory=lambda: store_module.RunIdempotencyStore(str(state)))
        def _make_run_event_callback(self, run_id, loop):
            return runs._make_run_event_callback(self, run_id, loop, _api_server=api)
        def _run_idempotency_scope(self, request):
            return runs._run_idempotency_scope(self, request, _api_server=api)
        def _check_run_auth(self, request, *, permission):
            return runs._check_run_auth(self, request, permission=permission, _api_server=api)
        async def _normalize_room_dispatch(self, request, body):
            if self._room_grant_token(request) or "hosted_room_dispatch" in body or "_room_execution_policy" in body:
                raise ValueError("hosted rooms are outside this oracle")
            return body, None
        def _resolve_route(self, model):
            return None
        def _request_route_conflict_error(self, **kwargs):
            return None
        def _concurrency_limited_response(self):
            return None
        async def _conversation_history_for_session(self, session):
            return []
        def _profile_scope(self, profile):
            return contextlib.nullcontext()
        def _bind_api_server_session(self, **kwargs):
            return []
        def _activate_admitted_request(self):
            pass
        def _create_agent(self, **kwargs):
            return ScriptedAgent()
    for name in ["_set_run_status", "_durable_run_status", "_request_owns_run"]:
        setattr(Adapter, name, getattr(runs, name))
    adapter = Adapter()

    async def submit(request):
        error = adapter._check_auth(request)
        if error is not None:
            return error
        return await runs._handle_runs(adapter, request, _api_server=api)
    async def poll(request):
        return await runs._handle_get_run(adapter, request, _api_server=api)
    async def stop(request):
        return await runs._handle_stop_run(adapter, request, _api_server=api)
    async def control(request):
        body = await request.json()
        if "time" in body:
            clock[0] = float(body["time"])
        if body.get("sweep"):
            runs._sweep_orphaned_runs_once(adapter, clock[0])
        if "settle" in body:
            run_id = body["settle"]
            agent = adapter._active_run_agents[run_id]
            agent.result = body["result"]
            agent.release.set()
            await asyncio.wait_for(asyncio.shield(adapter._active_run_tasks[run_id]), 5)
        return web.json_response({"ok": True})
    async def crash(request):
        # Deliberately omit executor cleanup and SQLite close: next invocation
        # opens the same disposable database in a genuinely new process.
        os._exit(0)
    async def serve():
        app = web.Application()
        app.router.add_post("/v1/runs", submit)
        app.router.add_get("/v1/runs/{run_id}", poll)
        app.router.add_post("/v1/runs/{run_id}/stop", stop)
        app.router.add_post("/__oracle/control", control)
        app.router.add_post("/__oracle/crash", crash)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        print(json.dumps({"url": f"http://127.0.0.1:{port}", "commit": LOCK["commit"],
                          "python": sys.version.split()[0], "aiohttp": aiohttp.__version__,
                          "sqlite": sqlite3.sqlite_version, "pid": os.getpid(),
                          "journal_mode": adapter._run_idempotency_store._conn.execute("PRAGMA journal_mode").fetchone()[0],
                          "dependencies": {name: importlib.metadata.version(name) for name in ["aiohttp", "aiohappyeyeballs", "aiosignal", "attrs", "frozenlist", "idna", "multidict", "propcache", "typing-extensions", "yarl"]},
                          "definitions": provenance}), flush=True)
        await asyncio.Event().wait()
    asyncio.run(serve())


if __name__ == "__main__":
    main()
