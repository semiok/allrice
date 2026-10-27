"""macOS menu-host fault injection. Uses the packaged host unchanged, a unique
bundle ID and a synthetic Core; never uses daily pairing, Keychain, VM or Dev.
Run: python3 scripts/acceptance/runtime/bridge-quit-recovery.py /path/to/app
Real packaged-Core acceptance is separate: bridge-desktop-core.mjs.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import subprocess
import sys
import tempfile
import time

assert sys.platform == "darwin", "Native menu acceptance requires macOS"
session = subprocess.check_output(["/usr/sbin/ioreg", "-n", "Root", "-d1"], text=True)
assert not re.search(r'"CGSSessionScreenIsLocked"\s*=\s*Yes', session), "NATIVE_UI_SCREEN_LOCKED: run on an unlocked test Mac"

source = Path(sys.argv[1]).resolve()
root = Path(tempfile.mkdtemp(prefix="allrice-quit-recovery-"))
app = root / "Quit Recovery.app"
(app / "Contents/MacOS").mkdir(parents=True)
(app / "Contents/Resources").mkdir()
host = app / "Contents/MacOS/RiceBridgeApp"
host.write_bytes((source / "Contents/MacOS/RiceBridgeApp").read_bytes())
host.chmod(0o700)
info = plistlib.loads((source / "Contents/Info.plist").read_bytes())
info["CFBundleIdentifier"] = "xyz.bplabs.rice-bridge.quit-recovery-" + root.name
(app / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
core = app / "Contents/Resources/RiceBridgeCore"
core.write_text('''#!/usr/bin/python3
import sys,json,time,os,select,signal
from pathlib import Path
root=Path(__file__).parents[3]
mode=(root/'mode').read_text()
(root/'core.pid').write_text(str(os.getpid()))
signal.signal(signal.SIGTERM,signal.SIG_IGN)
state={'version':'synthetic','architecture':'native','mode':'unpaired','connection':'stopped','activeForeground':0,'activeServices':0,'pendingReceipts':0,'unknownOperations':0}
def emit(row): print(json.dumps({'v':1,**row}),flush=True)
emit({'type':'state','sequence':1,'state':state})
if mode=='pipe-closed':
 os.close(0)
 while True: time.sleep(1)
count=0
while not (root/'complete').exists():
 if not select.select([sys.stdin],[],[],.05)[0]: continue
 line=sys.stdin.readline()
 if not line: break
 request=json.loads(line)
 if request['type']=='stop':
  count+=1;(root/'stop-count').write_text(str(count))
  if mode=='clean' or (mode=='reject-then-retry' and count==2):
   emit({'type':'response','id':request['id'],'ok':True});break
  state['mode']='stopping';state['shutdown']={'phase':'sandbox','status':'waiting','elapsedMs':0,'phaseElapsedMs':0,'waitLimitMs':60000}
  emit({'type':'state','sequence':count+1,'state':state})
  if mode in ['ack-without-exit','reject-then-retry']:
   emit({'type':'response','id':request['id'],'ok':mode=='ack-without-exit','code':'DESKTOP_STOP_UNCONFIRMED'})
''')
core.chmod(0o700)
subprocess.run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-",
                "--timestamp=none", str(app)], check=True, capture_output=True)
report = {"fixture": "packaged native host with synthetic Core, no real device state",
          "sourceHostSha256": hashlib.sha256((source / "Contents/MacOS/RiceBridgeApp").read_bytes()).hexdigest(),
          "hostSha256": hashlib.sha256(host.read_bytes()).hexdigest(),
          "outerFixtureAdhocResigned": True,
          "version": info["CFBundleVersion"], "root": str(root), "cases": []}


def wait(predicate, seconds=8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if predicate():
                return
        except subprocess.CalledProcessError as error:
            # AppKit creates/destroys the window after menu action dispatch.
            # Wait for that AX object; all product assertions remain unchanged.
            if "(-1728)" not in (error.stderr or ""):
                raise
        time.sleep(.1)
    raise AssertionError("native acceptance condition timed out")


def ui(pid, lines):
    args = ["/usr/bin/osascript", "-e", f'tell application "System Events" to tell (first application process whose unix id is {pid})']
    for line in lines:
        args += ["-e", line]
    args += ["-e", "end tell"]
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=8).strip()


def menu(pid, title):
    # Menu closing/action dispatch and AX publication are asynchronous. Open
    # and observe the requested item before the single action click.
    ui(pid, ['key code 53'])
    ui(pid, ['click menu bar item "AllRice" of last menu bar'])
    wait(lambda: title in ui(pid, ['get name of menu items of menu 1 of menu bar item "AllRice" of last menu bar']))
    return ui(pid, [f'click menu item "{title}" of menu 1 of menu bar item "AllRice" of last menu bar'])


def recovery_menu_visible(pid):
    # The previous status window is a separate presentation observation. The
    # menu is the recovery entrypoint; observe it first, then explicitly open
    # and verify the real status view without inferring why a window is absent.
    ui(pid, ['key code 53'])
    ui(pid, ['click menu bar item "AllRice" of last menu bar'])
    try:
        titles = ui(pid, ['get name of menu items of menu 1 of menu bar item "AllRice" of last menu bar'])
        return "退出未完成" in titles and "退出恢复…" in titles
    finally:
        ui(pid, ['key code 53'])


def status(pid):
    return ui(pid, ['get value of text area 1 of scroll area 1 of window "AllRice 助手"'])


def press(pid, title):
    wait(lambda: title in ui(pid, ['get name of buttons of window 1']))
    ui(pid, [f'click button "{title}" of window 1'])


def process_absent(pid):
    observed = subprocess.run(["ps", "-p", str(pid), "-o", "args="],
                              capture_output=True, text=True, timeout=2)
    if observed.returncode == 0:
        return False
    assert observed.returncode == 1 and not observed.stdout.strip() and not observed.stderr.strip(), "process observation failed; absence unconfirmed"
    return True


try:
    modes = ["clean", "reject-then-retry", "pipe-closed", "hung", "ack-without-exit"]
    assert all(mode in modes for mode in sys.argv[2:]), "Unknown acceptance case"
    for mode in (sys.argv[2:] or modes):
        for name in ["core.pid", "complete", "stop-count"]:
            (root / name).unlink(missing_ok=True)
        (root / "mode").write_text(mode)
        child = subprocess.Popen([str(host)], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        row = {"mode": mode, "passed": False}
        owned_core = None
        try:
            wait(lambda: (root / "core.pid").exists())
            owned_core = int((root / "core.pid").read_text())
            time.sleep(.4)
            # A shell-launched accessory app can be visible but not active;
            # activate this exact fixture as a user would before querying AX.
            ui(child.pid, ['set frontmost to true'])
            menu(child.pid, "查看状态…")
            wait(lambda: "尚未配对" in status(child.pid))
            started = time.monotonic()
            menu(child.pid, "退出 AllRice 助手")
            if mode == "clean":
                wait(lambda: child.poll() is not None)
                assert child.returncode == 0
            else:
                if mode in ["hung", "ack-without-exit"]:
                    # Exercise the real production 60s boundary, no test override.
                    wait(lambda: recovery_menu_visible(child.pid), 65)
                    recovery_elapsed = time.monotonic() - started
                    assert 59 <= recovery_elapsed < 66
                    row["recoveryMenuObserved"] = True
                    row["recoveryMenuAfterMs"] = round(recovery_elapsed * 1000)
                    row["statusWindowVisibleAtRecovery"] = "AllRice 助手" in ui(child.pid, ['get name of windows'])
                    menu(child.pid, "查看状态…")
                    wait(lambda: "退出未完成" in status(child.pid))
                    row["recoveryStatusOpenedAndVerified"] = True
                    row["recoveryStatusAfterMs"] = round((time.monotonic() - started) * 1000)
                else:
                    wait(lambda: "退出未完成" in status(child.pid))
                row["recoveryAfterMs"] = row.get("recoveryMenuAfterMs", round((time.monotonic() - started) * 1000))
                assert child.poll() is None
                menu(child.pid, "退出诊断与日志…")
                wait(lambda: ui(child.pid, ['get name of buttons of window 1']).find("关闭") >= 0)
                diagnostic = ui(child.pid, ['get value of text area 1 of scroll area 1 of window 1'])
                parsed = json.loads(diagnostic)
                assert parsed["coreResponse"] == "unavailable"
                assert parsed["quitRecovery"] is True
                assert parsed["coreRunning"] is True
                assert parsed["waitLimitMs"] == 60000
                if mode in ["hung", "ack-without-exit"]:
                    assert parsed["hostQuitError"] == "DESKTOP_STOP_TIMEOUT"
                row["recoveryDiagnostic"] = parsed
                assert "deviceId" not in parsed and "workspaceLabels" not in parsed
                press(child.pid, "关闭")
                row["fallbackDiagnostics"] = True
                if mode == "ack-without-exit":
                    assert (root / "stop-count").read_text() == "1"
                    (root / "complete").touch()
                    wait(lambda: child.poll() is not None)
                    assert child.returncode == 0
                    wait(lambda: process_absent(owned_core))
                    assert (root / "stop-count").read_text() == "1"
                    row["stopCount"] = 1
                    row["lateOwnedCoreExitConfirmed"] = True
                    row["lateCompletionClosesHost"] = True
                else:
                    menu(child.pid, "退出恢复…")
                    press(child.pid, "返回")
                    assert child.poll() is None
                    menu(child.pid, "退出恢复…")
                    if mode == "reject-then-retry":
                        press(child.pid, "继续等待安全退出")
                        wait(lambda: child.poll() is not None)
                        assert (root / "stop-count").read_text() == "2"
                        assert child.returncode == 0
                    else:
                        press(child.pid, "强制退出并保留记录")
                        wait(lambda: child.poll() is not None)
                        assert child.returncode == 0
                        row["explicitOwnedCoreForceExit"] = True
            row["passed"] = True
        except Exception as error:
            row["failureType"] = type(error).__name__
            row["failure"] = str(error)
            row["hostExitCode"] = child.poll()
            row["stopCount"] = (root / "stop-count").read_text() if (root / "stop-count").exists() else "none"
            try:
                row["windowsOnFailure"] = ui(child.pid, ['get name of windows'])
                row["menuOnFailure"] = ui(child.pid, ['click menu bar item "AllRice" of last menu bar', 'get name of menu items of menu 1 of menu bar item "AllRice" of last menu bar'])
                ui(child.pid, ['key code 53'])
            except subprocess.CalledProcessError as error:
                row["accessibilityError"] = error.stderr
            raise
        finally:
            # Only the two exact processes created by this fixture are eligible.
            if owned_core is not None:
                identity = subprocess.run(["ps", "-p", str(owned_core), "-o", "args="], capture_output=True, text=True)
                if str(core) in identity.stdout:
                    try:
                        os.kill(owned_core, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)
            report["cases"].append(row)
            (root / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            print(json.dumps(row, ensure_ascii=False), flush=True)
finally:
    print("report: " + str(root / "report.json"), flush=True)
