#!/usr/bin/env python3
"""Regenerate preview.png from a real, isolated Herdr rendering.

The script creates a throwaway Herdr app home, core session and set of demo
workspaces, fills them with curated spaces/agents, renders the current Kent
layout, captures the window with `herdr-app shot`, then stops only the
isolated processes it started. It never reads or changes the person's normal
Herdr home or core session.

Run from the repository root:

    python3 scripts/generate-preview.py
"""

from pathlib import Path
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
WIDTH = 1440
HEIGHT = 900
SHARED_DEFAULTS = {
    "layout": "kent",
    "sidebar.width": 232,
    "sidebar.collapsed": False,
    "frame.welcomed": "finished",
    "agents.sort": "priority",
}

HELPER = r'''#!/usr/bin/env python3
import sys
import time

state = sys.argv[1] if len(sys.argv) > 1 else ""
app = sys.argv[2] if len(sys.argv) > 2 else "pi"
title = sys.argv[3] if len(sys.argv) > 3 else app
body_path = sys.argv[4] if len(sys.argv) > 4 else ""

if title:
    sys.stdout.write(f"\x1b]0;{title}\x07")
if state:
    parts = [f"state={state}"]
    if state == "blocked":
        parts.append("kind=question")
    if app:
        parts.append(f"app={app}")
    sys.stdout.write("\x1b]7501;" + ":".join(parts) + "\x1b\\")
if body_path:
    with open(body_path, "r", encoding="utf-8") as body_file:
        sys.stdout.write(body_file.read())
else:
    sys.stdout.write(f"{title}\n")
sys.stdout.flush()
while True:
    time.sleep(3600)
'''

RESET = "\x1b[0m"
BOLD = "\x1b[1m"
DIM = "\x1b[2m"
GREEN = "\x1b[32m"
CYAN = "\x1b[36m"
VIOLET = "\x1b[35m"

LEFT_BODY = f"""{BOLD}{CYAN}pi · planner{RESET}

{DIM}$ pi planner --spaces grouped{RESET}

{GREEN}●{RESET} grouping 7 spaces into 3 shelves
{DIM}●{RESET} design: canvas, tokens
{DIM}●{RESET} code: kent, runner, docs
{DIM}●{RESET} default keeps loose rows separate

{BOLD}layout kent is ready{RESET}
{DIM}right-click a space for Group this space…{RESET}

{VIOLET}1{RESET}  def groups(spaces):
{VIOLET}2{RESET}      return shelf(spaces, key=\"project\")

{GREEN}✓{RESET} active rows keep the violet edge
"""

RIGHT_BODY = f"""{BOLD}{CYAN}codex · validation{RESET}

{DIM}$ herdr-app check mods/kent{RESET}
{GREEN}✓{RESET} mod loads
{GREEN}✓{RESET} 0 errors

{DIM}$ herdr-app check mods/kent-agents{RESET}
{GREEN}✓{RESET} mod loads
{GREEN}✓{RESET} 0 errors

{DIM}$ git branch --show-current{RESET}
main

{GREEN}ready{RESET}
"""

SIMPLE_BODY = f"""{DIM}$ cat NOTES.md{RESET}
curated demo workspace
layout preview data only

{GREEN}ready{RESET}
"""


class PreviewError(RuntimeError):
    pass


def run_capture(command, env, timeout=10):
    return subprocess.run(
        command,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
    )


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def isolated_env(tmp, session):
    env = os.environ.copy()
    for key in list(env):
        if key.startswith("HC_") or key.startswith("HERDR_"):
            env.pop(key, None)
    home = tmp / "home"
    runtime = tmp / "runtime"
    home.mkdir(parents=True, exist_ok=True)
    runtime.mkdir(parents=True, exist_ok=True)
    runtime.chmod(0o700)
    env.update({
        "HOME": str(home),
        "HERDR_APP_HOME": str(tmp / "app"),
        "HERDR_APP_ID": f"kent-preview-{os.getpid()}",
        "HERDR_APP_NO_SOUND": "1",
        "HERDR_TELEMETRY": "0",
        "HERDR_NOTES_MEDIA_DIR": str(tmp / "notes-media"),
        "XDG_CONFIG_HOME": str(tmp / "config"),
        "XDG_STATE_HOME": str(tmp / "state"),
        "XDG_RUNTIME_DIR": str(runtime),
        "HC_SESSION": session,
    })
    return env


def app_do(env, name, args=None, timeout=10):
    payload = json.dumps(args or {}, ensure_ascii=False)
    result = run_capture(["herdr-app", "do", name, payload], env, timeout=timeout)
    output = (result.stdout or result.stderr).strip()
    if result.returncode != 0:
        raise PreviewError(f"{name} failed: {output}")
    try:
        data = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise PreviewError(f"{name} returned non-JSON output: {output}") from exc
    if "error" in data:
        raise PreviewError(f"{name} failed: {data['error']}")
    return data


def app_status(env):
    result = run_capture(["herdr-app", "status"], env)
    if result.returncode != 0:
        raise PreviewError((result.stderr or result.stdout).strip())
    return json.loads(result.stdout)


def app_ls(env):
    result = run_capture(["herdr-app", "ls"], env)
    if result.returncode != 0:
        raise PreviewError((result.stderr or result.stdout).strip())
    return json.loads(result.stdout)


def wait_for_window(env, timeout=15):
    deadline = time.monotonic() + timeout
    last = ""
    while time.monotonic() < deadline:
        try:
            status = app_status(env)
            if status.get("layout") == "kent" and not status.get("errors") and not status.get("overlays"):
                return status
            last = json.dumps(status)
        except Exception as exc:
            last = str(exc)
        time.sleep(0.25)
    raise PreviewError(f"isolated Herdr window did not become ready: {last}")


def init_repo(path, branch):
    path.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["git", "init", "-q", "-b", branch, str(path)],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise PreviewError(f"git init failed for {path}: {result.stderr.strip()}")
    (path / "README.md").write_text(f"# {path.name}\n\ncurated preview workspace\n", encoding="utf-8")
    commands = [
        ["git", "-C", str(path), "add", "README.md"],
        [
            "git", "-C", str(path),
            "-c", "user.name=Kent Preview",
            "-c", "user.email=kent-preview@example.invalid",
            "-c", "commit.gpgsign=false",
            "commit", "--no-verify", "-q", "-m", "Initial preview commit",
        ],
    ]
    for command in commands:
        result = subprocess.run(command, text=True, capture_output=True)
        if result.returncode != 0:
            raise PreviewError(f"git setup failed for {path}: {result.stderr.strip()}")


def write_body(work, name, text):
    path = work / "bodies" / f"{name}.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def prepare_home(tmp, font):
    app_home = tmp / "app"
    (app_home / "layouts").mkdir(parents=True, exist_ok=True)
    (app_home / "mods").mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "layouts" / "kent.json", app_home / "layouts" / "kent.json")
    if (ROOT / "layouts" / "kent.png").exists():
        shutil.copy2(ROOT / "layouts" / "kent.png", app_home / "layouts" / "kent.png")
    for mod in ("kent", "kent-agents"):
        shutil.copytree(ROOT / "mods" / mod, app_home / "mods" / mod)
    if (ROOT / "keys.json").exists():
        shutil.copy2(ROOT / "keys.json", app_home / "keys.json")
    write_json(app_home / "settings.json", {
        "zoom": 1,
        "sounds": {"enabled": False},
        "minimum_contrast": 1,
        "font_size": 14,
        "ui_font": font,
        "appearance": "dark",
        "font": font,
        "telemetry": False,
    })
    write_json(app_home / "shared.json", dict(SHARED_DEFAULTS))
    write_window(app_home)


def write_window(app_home):
    write_json(app_home / "window.json", {
        "state": "windowed",
        "bounds": [80, 80, WIDTH, HEIGHT],
    })


def prepare_demo(tmp):
    helper = tmp / "demo_agent.py"
    helper.write_text(HELPER, encoding="utf-8")
    helper.chmod(0o755)

    # Copies named after real entries in Herdr's program table: running them
    # through python3 makes the interpreter detection resolve the basename, so
    # demo rows show true program icons instead of fake codex/claude reports.
    program_copies = {}
    bindir = tmp / "bin"
    bindir.mkdir(exist_ok=True)
    for program in ("nvim", "docker", "astro", "pytest", "shell"):
        copy = bindir / program
        copy.write_text(HELPER, encoding="utf-8")
        copy.chmod(0o755)
        program_copies[program] = copy

    for name, branch in {
        "herdr-kent": "main",
        "canvas-redesign": None,
        "brand-tokens": "tokens/v2",
        "runner-api": None,
        "docs-site": "docs/restructure",
        "agent-lab": None,
        "overlay-prototype": None,
        "scratchpad": None,
    }.items():
        folder = tmp / name
        if branch:
            init_repo(folder, branch)
        else:
            folder.mkdir(parents=True, exist_ok=True)

    bodies = {
        "left": write_body(tmp, "left", LEFT_BODY),
        "right": write_body(tmp, "right", RIGHT_BODY),
    }
    for name in ("canvas-redesign", "brand-tokens", "runner-api", "docs-site", "agent-lab", "overlay-prototype", "scratchpad"):
        bodies[name] = write_body(tmp, name, SIMPLE_BODY.replace("curated demo workspace", f"{name} · curated demo workspace"))
    return tmp, helper, bodies, program_copies


def start_app(env, tmp):
    log = open(tmp / "herdr-app.log", "a", encoding="utf-8")
    process = subprocess.Popen(
        ["herdr-app"],
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return process, log


def stop_app(process, log=None):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
    if log:
        log.close()


def terminal_rows(listing):
    rows = []
    for space in listing.get("spaces", []):
        for tab in space.get("tabs", []):
            rows.extend(tab.get("terminals", []))
    return rows


def pane_for_terminal(listing, terminal):
    for row in terminal_rows(listing):
        if row.get("terminal") == terminal:
            return row.get("pane")
    return None


def make_space(env, helper, folder, body, name, tab_name, state="", app="pi", title=None, focus=False, cmd=None):
    args = {
        "name": name,
        "folder": str(folder),
        "machine": "",
        "focus": focus,
        "argv": [*(cmd or [str(helper)]), state, app, title or name, str(body)],
    }
    created = app_do(env, "space.new", args)
    if tab_name:
        app_do(env, "tab.rename", {"id": created["tab"], "name": tab_name})
    return created


def create_demo_spaces(env, work, helper, bodies, program_copies):
    ids = {}
    active = make_space(
        env,
        helper,
        work / "herdr-kent",
        bodies["left"],
        "herdr-kent",
        "Pi",
        state="working",
        app="pi",
        title="pi · planner",
        focus=True,
    )
    ids["herdr-kent"] = active["space"]
    active_terminal = active["terminal"]

    app_do(env, "pane.split", {
        "direction": "right",
        "argv": [str(helper), "working", "codex", "codex · validation", str(bodies["right"])],
    })

    specs = [
        ("canvas-redesign", "tokens", "", "nvim", "nvim · tokens"),
        ("brand-tokens", "supply", "", "docker", "docker · supply"),
        ("runner-api", "server", "blocked", "pi", "pi · server"),
        ("docs-site", "docs", "", "astro", "astro · docs"),
        ("agent-lab", "evals", "", "pytest", "pytest · evals"),
        ("overlay-prototype", "dnd", "idle", "gemini", "gemini · dnd"),
        ("scratchpad", "shell", "", "shell", "scratchpad"),
    ]
    for name, tab_name, state, app, title in specs:
        copy = program_copies.get(app) if not state else None
        created = make_space(
            env,
            helper,
            work / name,
            bodies[name],
            name,
            tab_name,
            state=state,
            app=app,
            title=title,
            focus=False,
            cmd=["python3", str(copy)] if copy else None,
        )
        ids[name] = created["space"]

    app_do(env, "space.select", {"id": ids["runner-api"]})
    time.sleep(0.6)
    app_do(env, "space.select", {"id": ids["herdr-kent"]})
    listing = app_ls(env)
    left_pane = pane_for_terminal(listing, active_terminal)
    if left_pane:
        app_do(env, "pane.focus", {"pane": left_pane})
    time.sleep(0.5)
    return ids


def write_groups(app_home, ids):
    shared_path = app_home / "shared.json"
    shared = json.loads(shared_path.read_text(encoding="utf-8")) if shared_path.exists() else {}
    shared.update(SHARED_DEFAULTS)
    shared["kent.groups.v1"] = {
        "version": 1,
        "groups": [
            {"id": "gdesign", "name": "design", "machine": None, "folded": False},
            {"id": "gcode", "name": "code", "machine": None, "folded": False},
            {"id": "gexperiments", "name": "experiments", "machine": None, "folded": True},
        ],
        "in": {
            "gdesign": [ids["canvas-redesign"], ids["brand-tokens"]],
            "gcode": [ids["herdr-kent"], ids["runner-api"], ids["docs-site"]],
            "gexperiments": [ids["agent-lab"], ids["overlay-prototype"]],
        },
        "defaultFolded": {},
        "at": int(time.time() * 1000),
    }
    write_json(shared_path, shared)
    write_window(app_home)


def wait_for_agents(env, expected=4, timeout=12):
    deadline = time.monotonic() + timeout
    last_count = 0
    while time.monotonic() < deadline:
        listing = app_ls(env)
        rows = terminal_rows(listing)
        last_count = sum(1 for row in rows if row.get("status"))
        if last_count >= expected:
            return listing
        time.sleep(0.3)
    raise PreviewError(f"expected {expected} reporting demo agents, saw {last_count}")


def capture_shot(env, frame, timeout=10):
    deadline = time.monotonic() + timeout
    last = ""
    while time.monotonic() < deadline:
        if frame.exists():
            frame.unlink()
        result = run_capture(["herdr-app", "shot", str(frame)], env)
        if result.returncode == 0 and frame.exists() and frame.stat().st_size > 0:
            return
        last = (result.stderr or result.stdout).strip()
        time.sleep(0.35)
    raise PreviewError(f"herdr-app shot failed: {last}")


def normalize_png(frame, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp.png")
    try:
        try:
            from PIL import Image
        except ImportError:
            shutil.copyfile(frame, temporary)
            os.replace(temporary, output)
            return "copied (Pillow unavailable; original pixel size kept)"

        with Image.open(frame) as image:
            image.load()
            if image.width > WIDTH:
                height = round(image.height * WIDTH / image.width)
                image = image.resize((WIDTH, height), Image.Resampling.LANCZOS)
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGB")
            image.save(temporary, format="PNG", optimize=True)
        os.replace(temporary, output)
        with Image.open(output) as final:
            return f"{final.width}x{final.height}"
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def pid_alive(pid):
    try:
        os.kill(int(pid), 0)
    except OSError:
        return False
    return True


def stop_core(env):
    pid = None
    try:
        status = run_capture(["hc", "server", "status", "--json"], env, timeout=5)
        if status.returncode == 0:
            pid = json.loads(status.stdout).get("pid")
    except Exception:
        pid = None
    try:
        run_capture(["hc", "server", "stop", "--json"], env, timeout=8)
    except Exception:
        pass
    if pid:
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline and pid_alive(pid):
            time.sleep(0.15)
        # An orphaned core would otherwise leak past the preview run.
        if pid_alive(pid):
            try:
                os.kill(int(pid), signal.SIGTERM)
            except OSError:
                return
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and pid_alive(pid):
                time.sleep(0.1)


def generate(output, keep=False, font="JetBrainsMono Nerd Font Mono"):
    tmp_root = Path("/tmp") if Path("/tmp").is_dir() else None
    tmp = Path(tempfile.mkdtemp(prefix="kent-", dir=tmp_root)).resolve()
    session = f"kp{os.getpid()}"
    env = isolated_env(tmp, session)
    process = None
    log = None
    try:
        prepare_home(tmp, font)
        work, helper, bodies, program_copies = prepare_demo(tmp)

        process, log = start_app(env, tmp)
        wait_for_window(env)
        initial = app_ls(env)
        if initial.get("spaces"):
            raise PreviewError("the isolated Herdr window is not empty; refusing to use it")
        ids = create_demo_spaces(env, work, helper, bodies, program_copies)
        stop_app(process, log)
        process = None
        log = None

        write_groups(tmp / "app", ids)

        process, log = start_app(env, tmp)
        wait_for_window(env)
        wait_for_agents(env, expected=4)
        time.sleep(1)
        try:
            app_do(env, "window.minimize", {})
        except PreviewError:
            pass
        frame = tmp / "frame.png"
        capture_shot(env, frame)
        details = normalize_png(frame, output)
        print(f"wrote {output} ({details})")
        # The settings-picker thumbnail is the same picture; keep the pair in sync.
        if output.resolve() == (ROOT / "preview.png").resolve():
            shutil.copy2(output, ROOT / "layouts" / "kent.png")
            print(f"wrote {ROOT / 'layouts' / 'kent.png'} (settings thumbnail)")
    finally:
        stop_app(process, log)
        stop_core(env)
        if keep:
            print(f"kept isolated preview directory: {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description="Regenerate preview.png from an isolated Herdr rendering.")
    parser.add_argument("--output", type=Path, default=ROOT / "preview.png", help="target PNG (default: preview.png)")
    parser.add_argument("--keep", action="store_true", help="keep the temporary isolated home for debugging")
    parser.add_argument("--font", default="JetBrainsMono Nerd Font Mono", help="UI and terminal font for the capture (default: JetBrainsMono Nerd Font Mono)")
    args = parser.parse_args()
    try:
        generate(args.output, keep=args.keep, font=args.font)
    except (PreviewError, subprocess.TimeoutExpired, OSError) as exc:
        print(f"generate-preview: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
