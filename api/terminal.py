"""Embedded workspace terminal support for Hermes Web UI.

The terminal is intentionally independent from the agent execution path.  It
starts a shell with an explicit cwd/env per process and never mutates
process-global os.environ, which avoids expanding the session-env race tracked
in the agent execution layer.
"""

from __future__ import annotations

import errno
import atexit
import codecs
import fcntl
import os
import queue
import select
import shutil
import signal
import struct
import subprocess
import termios
import threading
from dataclasses import dataclass, field
from pathlib import Path


def _set_nonblocking(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


def _winsize(rows: int, cols: int) -> bytes:
    rows = max(8, min(int(rows or 24), 80))
    cols = max(20, min(int(cols or 80), 240))
    return struct.pack("HHHH", rows, cols, 0, 0)


@dataclass
class TerminalSession:
    session_id: str
    workspace: str
    proc: subprocess.Popen
    master_fd: int
    rows: int = 24
    cols: int = 80
    output: queue.Queue = field(default_factory=lambda: queue.Queue(maxsize=2000))
    closed: threading.Event = field(default_factory=threading.Event)
    reader: threading.Thread | None = None
    # Fork-only: when True the underlying shell lives in a daemonised tmux
    # server rather than being a direct child of the WebUI. The proc/master_fd
    # in that case is the *tmux client* attaching to the session — when the
    # WebUI dies the client dies but the tmux session + user shell keep
    # running, and the next start_persistent_terminal() call re-attaches.
    # See start_persistent_terminal for details.
    persistent: bool = False
    tmux_session: str = ""

    def is_alive(self) -> bool:
        if self.persistent:
            # A persistent terminal is "alive" iff its tmux session still
            # exists, regardless of whether our local PTY client has
            # disconnected since. The PTY can be re-attached on demand.
            if self.closed.is_set():
                # closed was set on an explicit user "close terminal" call,
                # which also tears down the tmux session. Once closed,
                # stays closed.
                return False
            return _tmux_session_exists(self.tmux_session)
        return not self.closed.is_set() and self.proc.poll() is None

    def put_output(self, event: str, payload: dict) -> None:
        try:
            self.output.put_nowait((event, payload))
        except queue.Full:
            # Keep the terminal responsive by dropping the oldest queued chunk.
            try:
                self.output.get_nowait()
            except queue.Empty:
                pass
            try:
                self.output.put_nowait((event, payload))
            except queue.Full:
                pass


_TERMINALS: dict[str, TerminalSession] = {}
_LOCK = threading.RLock()


# ── tmux backing for persistent terminals (fork-only) ───────────────────────
#
# Why: the multi-terminal panel needs shells that survive WebUI restarts so
# every code-deploy doesn't cost the user their open sessions, scrollback,
# and background processes. Bare PTYs can't do that because the shell is a
# direct child of the WebUI process. tmux solves this — the tmux *server*
# is daemonised (detached from any controlling process group), so the only
# thing that dies on WebUI restart is the lightweight `tmux attach` client.
# The user's shell, foreground programs, and scrollback all live in the
# tmux server and persist until they're explicitly killed.

_TMUX_PREFIX = "hermes-multi-"


def _tmux_session_name(terminal_id: str) -> str:
    """Stable session name for a multi-terminal id (no hyphens-collision risk)."""
    return f"{_TMUX_PREFIX}{terminal_id}"


def _tmux_path() -> str | None:
    """Resolved tmux binary path, or None if tmux isn't installed."""
    return shutil.which("tmux")


def _tmux_session_exists(name: str) -> bool:
    """True iff `tmux has-session -t <name>` returns 0. False if tmux missing."""
    tmux = _tmux_path()
    if not tmux or not name:
        return False
    try:
        rc = subprocess.run(
            [tmux, "has-session", "-t", name],
            capture_output=True,
            timeout=2,
        ).returncode
        return rc == 0
    except (subprocess.SubprocessError, OSError):
        return False


def _tmux_list_persistent_sessions() -> list[dict]:
    """Return [{name, terminal_id}, ...] for every live hermes-multi-* session.

    Used by list_terminals() to surface tmux sessions whose in-memory PTY
    client has been reaped — typically because the WebUI restarted after
    they were created. The frontend's terminal_id tabs still map to these
    sessions; we just need to lazily re-attach on first interaction.
    """
    tmux = _tmux_path()
    if not tmux:
        return []
    try:
        out = subprocess.run(
            [tmux, "list-sessions", "-F", "#{session_name}"],
            capture_output=True,
            timeout=2,
            text=True,
        )
    except (subprocess.SubprocessError, OSError):
        return []
    if out.returncode != 0:
        # `no server running` is the common case before any persistent
        # terminal has been created. Don't surface as an error.
        return []
    sessions = []
    for line in (out.stdout or "").splitlines():
        line = line.strip()
        if line.startswith(_TMUX_PREFIX):
            sessions.append({
                "name": line,
                "terminal_id": line[len(_TMUX_PREFIX):],
            })
    return sessions


def _tmux_kill_session(name: str) -> None:
    """Best-effort `tmux kill-session -t <name>`. Silent if the session is gone."""
    tmux = _tmux_path()
    if not tmux or not name:
        return
    try:
        subprocess.run(
            [tmux, "kill-session", "-t", name],
            capture_output=True,
            timeout=3,
        )
    except (subprocess.SubprocessError, OSError):
        pass


def _terminal_shell_preexec_fn() -> None:
    """Ask Linux to terminate the PTY shell when the WebUI parent dies."""
    try:
        import ctypes

        libc = ctypes.CDLL(None)
        libc.prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG=1, SIGTERM=15
    except Exception:
        # Non-Linux platforms or restricted runtimes should still be able to
        # open an embedded terminal; they just do not get the Linux pdeathsig
        # hardening.
        pass


def _decode_terminal_output(decoder, data: bytes) -> str:
    """Decode PTY bytes without stripping terminal control sequences."""
    return decoder.decode(data)


def _shell_path() -> str:
    shell = os.environ.get("SHELL") or ""
    if shell and Path(shell).exists():
        return shell
    return shutil.which("zsh") or shutil.which("bash") or shutil.which("sh") or "/bin/sh"


def _shell_argv(shell: str) -> list[str]:
    name = Path(shell).name
    if name in {"zsh", "bash", "sh"}:
        return [shell, "-i"]
    return [shell]


def _reader_loop(term: TerminalSession) -> None:
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    try:
        while not term.closed.is_set():
            if term.proc.poll() is not None:
                break
            try:
                ready, _, _ = select.select([term.master_fd], [], [], 0.25)
            except (OSError, ValueError):
                break
            if not ready:
                continue
            try:
                data = os.read(term.master_fd, 8192)
            except OSError as exc:
                if exc.errno in (errno.EIO, errno.EBADF):
                    break
                raise
            if not data:
                break
            text = _decode_terminal_output(decoder, data)
            if text:
                term.put_output("output", {"text": text})
    except Exception as exc:
        term.put_output("terminal_error", {"error": str(exc)})
    finally:
        term.closed.set()
        code = term.proc.poll()
        term.put_output("terminal_closed", {"exit_code": code})


def _set_size(term: TerminalSession, rows: int, cols: int) -> None:
    term.rows = max(8, min(int(rows or term.rows or 24), 80))
    term.cols = max(20, min(int(cols or term.cols or 80), 240))
    try:
        fcntl.ioctl(term.master_fd, termios.TIOCSWINSZ, _winsize(term.rows, term.cols))
    except OSError:
        pass
    try:
        if term.proc.poll() is None:
            os.killpg(term.proc.pid, signal.SIGWINCH)
    except (OSError, ProcessLookupError):
        pass


def start_terminal(session_id: str, workspace: Path, rows: int = 24, cols: int = 80, restart: bool = False) -> TerminalSession:
    """Start or return the embedded terminal for a WebUI session."""
    sid = str(session_id or "").strip()
    if not sid:
        raise ValueError("session_id is required")
    cwd = str(Path(workspace).expanduser().resolve())
    if not Path(cwd).is_dir():
        raise ValueError("workspace is not a directory")

    with _LOCK:
        current = _TERMINALS.get(sid)
        if current and current.is_alive() and not restart and current.workspace == cwd:
            _set_size(current, rows, cols)
            return current
        if current:
            close_terminal(sid)

        master_fd, slave_fd = os.openpty()
        # Build a safe env: allowlist common shell vars, strip API keys and secrets.
        # The PTY shell is an interactive UI surface — do not leak server credentials.
        _SAFE_ENV_KEYS = {
            "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL",
            "LC_CTYPE", "LC_MESSAGES", "LANGUAGE", "TZ", "TMPDIR", "TEMP",
            "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
        }
        env = {k: v for k, v in os.environ.items() if k in _SAFE_ENV_KEYS}
        env.update(
            {
                "TERM": "xterm-256color",
                "COLORTERM": "truecolor",
                "COLUMNS": str(cols),
                "LINES": str(rows),
                "PWD": cwd,
                "HERMES_WEBUI_TERMINAL": "1",
            }
        )
        shell = _shell_path()
        proc = subprocess.Popen(
            _shell_argv(shell),
            cwd=cwd,
            env=env,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
            preexec_fn=_terminal_shell_preexec_fn,
            start_new_session=True,
        )
        os.close(slave_fd)
        _set_nonblocking(master_fd)

        term = TerminalSession(
            session_id=sid,
            workspace=cwd,
            proc=proc,
            master_fd=master_fd,
            rows=rows,
            cols=cols,
        )
        _set_size(term, rows, cols)
        term.reader = threading.Thread(target=_reader_loop, args=(term,), daemon=True)
        term.reader.start()
        _TERMINALS[sid] = term
        return term


def get_terminal(session_id: str) -> TerminalSession | None:
    sid = str(session_id or "")
    with _LOCK:
        term = _TERMINALS.get(sid)
        if term and term.is_alive():
            return term
        # Lazy recovery for persistent (tmux-backed) terminals: if there's no
        # in-memory PTY client but the tmux session is still alive (typically
        # the case immediately after a WebUI restart), re-attach transparently
        # so the existing terminal_id in the user's open tab stays valid.
        if not term:
            session_name = _tmux_session_name(sid)
            if _tmux_session_exists(session_name):
                try:
                    return start_persistent_terminal(
                        sid,
                        Path(os.path.expanduser("~")),  # cwd ignored by attach path
                        rows=24,
                        cols=80,
                        restart=False,
                    )
                except Exception:
                    return None
        return term


def start_persistent_terminal(
    terminal_id: str,
    workspace: Path,
    rows: int = 24,
    cols: int = 80,
    restart: bool = False,
) -> TerminalSession:
    """tmux-backed shell that survives WebUI restarts.

    Differences vs start_terminal:
      - The PTY's child is `tmux new-session -A -s hermes-multi-<id>` rather
        than the user's shell directly. tmux's server is daemonised; the
        shell lives there, not in this process tree.
      - On WebUI restart the PTY client (this proc's child) dies but the
        tmux session and its shell keep running. get_terminal() lazily
        re-attaches when the frontend next polls /api/terminals/output.
      - close_terminal() runs `tmux kill-session` when persistent=True so
        explicit user "close tab" still tears down the underlying shell.
      - close_all_terminals() (registered atexit) only closes the PTY
        client for persistent sessions, leaving the tmux server's shell
        intact for the next WebUI process to re-attach.

    Falls back to start_terminal() if tmux isn't installed, with the
    documented "shell dies on restart" caveat.
    """
    sid = str(terminal_id or "").strip()
    if not sid:
        raise ValueError("terminal_id is required")
    tmux = _tmux_path()
    if not tmux:
        # Graceful degradation: tmux missing → non-persistent shell. Caller
        # gets the same TerminalSession shape, just without the survive-
        # restart property. Better than refusing to start the terminal.
        return start_terminal(sid, workspace, rows=rows, cols=cols, restart=restart)

    cwd = str(Path(workspace).expanduser().resolve())
    if not Path(cwd).is_dir():
        raise ValueError("workspace is not a directory")
    session_name = _tmux_session_name(sid)

    with _LOCK:
        current = _TERMINALS.get(sid)
        if current and current.is_alive() and not restart:
            # Already attached, just resize and return.
            _set_size(current, rows, cols)
            return current
        if current:
            # Drop the old in-memory entry — but only kill the tmux session
            # if the caller explicitly asked to restart. Otherwise we re-
            # attach to the existing session below.
            close_terminal(sid, _kill_tmux=restart)

        master_fd, slave_fd = os.openpty()
        # Same env hardening as start_terminal: strip secrets, only pass
        # shell-related vars through.
        _SAFE_ENV_KEYS = {
            "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL",
            "LC_CTYPE", "LC_MESSAGES", "LANGUAGE", "TZ", "TMPDIR", "TEMP",
            "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
        }
        env = {k: v for k, v in os.environ.items() if k in _SAFE_ENV_KEYS}
        env.update(
            {
                "TERM": "xterm-256color",
                "COLORTERM": "truecolor",
                "COLUMNS": str(cols),
                "LINES": str(rows),
                "PWD": cwd,
                "HERMES_WEBUI_TERMINAL": "1",
            }
        )
        shell = _shell_path()

        # tmux flags walkthrough:
        #   new-session -A -s NAME    : create-or-attach (idempotent)
        #   -x COLS -y ROWS           : initial window size when creating
        #   -c CWD                    : starting directory when creating
        #   -d/-A interaction         : -A flips -d off; with -A we DO attach
        #                               to the new client (our PTY)
        # NB: we do NOT pass a command to tmux — it picks $SHELL inside the
        # session, which we've already hardened in `env`.
        tmux_argv = [
            tmux,
            "new-session",
            "-A",
            "-s", session_name,
            "-x", str(max(20, min(int(cols or 80), 240))),
            "-y", str(max(8, min(int(rows or 24), 80))),
            "-c", cwd,
            shell,
        ]
        # Crucially: NO preexec_fn=prctl(PDEATHSIG) here. That hook is what
        # makes the upstream start_terminal kill its shell when the WebUI
        # dies; we explicitly DON'T want that here — the whole point of
        # tmux backing is shell survival.
        proc = subprocess.Popen(
            tmux_argv,
            cwd=cwd,
            env=env,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
            start_new_session=True,
        )
        os.close(slave_fd)
        _set_nonblocking(master_fd)

        term = TerminalSession(
            session_id=sid,
            workspace=cwd,
            proc=proc,
            master_fd=master_fd,
            rows=rows,
            cols=cols,
            persistent=True,
            tmux_session=session_name,
        )
        _set_size(term, rows, cols)
        term.reader = threading.Thread(target=_reader_loop, args=(term,), daemon=True)
        term.reader.start()
        _TERMINALS[sid] = term
        return term


def write_terminal(session_id: str, data: str) -> None:
    term = get_terminal(session_id)
    if not term or not term.is_alive():
        raise KeyError("terminal not running")
    os.write(term.master_fd, str(data or "").encode("utf-8", errors="replace"))


def resize_terminal(session_id: str, rows: int, cols: int) -> None:
    term = get_terminal(session_id)
    if not term:
        raise KeyError("terminal not running")
    _set_size(term, rows, cols)


def list_terminals() -> list[dict]:
    """Return a snapshot of every live terminal. Each row: {id, workspace,
    rows, cols, alive, persistent}. Used by the fork-only /api/terminals/list
    endpoint so the frontend can recover its tab list after a reload.

    Includes orphaned tmux sessions — tmux-backed terminals whose in-memory
    PTY client has been reaped (typically by a WebUI restart). These show as
    persistent + alive even though _TERMINALS doesn't know about them yet;
    the next /api/terminals/output call against that id will re-attach.
    """
    out: list[dict] = []
    with _LOCK:
        snapshot = list(_TERMINALS.items())
        in_memory_ids = set(_TERMINALS.keys())
    for sid, term in snapshot:
        out.append({
            "id": sid,
            "workspace": term.workspace,
            "rows": term.rows,
            "cols": term.cols,
            "alive": term.is_alive(),
            "persistent": term.persistent,
        })
    # Surface tmux sessions that survived a restart but haven't been
    # re-attached yet. We can't recover the original workspace path for
    # these so we report "?" — the frontend mostly just needs the id +
    # alive flag to render the tab and start polling output.
    for entry in _tmux_list_persistent_sessions():
        if entry["terminal_id"] in in_memory_ids:
            continue
        out.append({
            "id": entry["terminal_id"],
            "workspace": "?",
            "rows": 24,
            "cols": 80,
            "alive": True,
            "persistent": True,
            "orphan": True,
        })
    return out


def close_terminal(session_id: str, *, _kill_tmux: bool = True) -> bool:
    """Close a terminal in the in-memory registry.

    For non-persistent terminals: reaps the shell process group (SIGHUP →
    SIGKILL on timeout). Same behaviour as the original.

    For persistent (tmux-backed) terminals: tears down the PTY *client*
    immediately, then by default also runs `tmux kill-session` so the
    user's shell is actually gone. Set _kill_tmux=False (used by
    start_persistent_terminal during a re-attach) to drop the PTY client
    only and leave the tmux session running.
    """
    sid = str(session_id or "")
    with _LOCK:
        term = _TERMINALS.pop(sid, None)
    if not term:
        # No in-memory entry, but maybe a tmux session lingering from
        # before a restart. Still honour the user's explicit close.
        if _kill_tmux:
            _tmux_kill_session(_tmux_session_name(sid))
            return True
        return False
    term.closed.set()
    try:
        if term.proc.poll() is None:
            try:
                os.killpg(term.proc.pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
            try:
                term.proc.wait(timeout=1.5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(term.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    term.proc.wait(timeout=1.0)
                except (subprocess.TimeoutExpired, ProcessLookupError):
                    pass
    finally:
        try:
            os.close(term.master_fd)
        except OSError:
            pass
    # The PTY client is gone; for a persistent terminal we still need to
    # tell tmux to destroy the underlying session unless we're mid re-attach.
    if term.persistent and _kill_tmux:
        _tmux_kill_session(term.tmux_session)
    return True


def close_all_terminals() -> None:
    """Best-effort reap during graceful WebUI shutdown.

    Persistent (tmux-backed) terminals: detach the PTY client only —
    DO NOT kill the tmux session. That's the whole point: shells survive
    restarts so the user picks them back up exactly where they were.

    Non-persistent terminals: same as before (full shell teardown).
    """
    with _LOCK:
        items = list(_TERMINALS.items())
    for sid, term in items:
        close_terminal(sid, _kill_tmux=not term.persistent)


atexit.register(close_all_terminals)
