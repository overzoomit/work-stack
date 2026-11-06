#!/usr/bin/env python3
import json
import subprocess
import time
import os
import sys

BRAIN_DIR = "/home/flavio/.gemini/antigravity-cli/brain/8f4b80a1-fe40-4f44-a050-8cf9a5c42a3b"
SHOTS_DIR = os.path.join(BRAIN_DIR, "shots")
os.makedirs(SHOTS_DIR, exist_ok=True)

test_results = []

def run_app_cmd(cmd_name, args=None):
    cli = ["herdr-app", "do", cmd_name]
    if args:
        for k, v in args.items():
            cli.extend([f"--{k}", str(v) if not isinstance(v, (dict, list)) else json.dumps(v)])
    res = subprocess.run(cli, capture_output=True, text=True)
    out = res.stdout.strip()
    try:
        parsed = json.loads(out)
    except:
        parsed = out
    return res.returncode == 0, parsed

def capture_shot(filename):
    dest = os.path.join(SHOTS_DIR, filename)
    res = subprocess.run(["herdr-app", "shot", dest], capture_output=True, text=True)
    return res.returncode == 0, dest

def log_test(category, name, passed, details, shot_file=None):
    item = {
        "category": category,
        "name": name,
        "passed": passed,
        "details": details,
        "shot": shot_file
    }
    test_results.append(item)
    status_emoji = "✅" if passed else "❌"
    print(f"{status_emoji} [{category}] {name}: {'PASS' if passed else 'FAIL'}")

print("=== STARTING HERDR-APP END-TO-END AUTOMATED TEST SUITE ===")

# Test 1: Baseline inspection
res = subprocess.run(["herdr-app", "status"], capture_output=True, text=True)
status_data = json.loads(res.stdout) if res.returncode == 0 else {}
log_test("System", "Initial App Status Inspection", res.returncode == 0, status_data)

# Test 2: Space Management - Create Space
ok, space_res = run_app_cmd("space.new", {
    "name": "E2E Test Workspace",
    "folder": "/home/flavio/workspace/work-stack"
})
time.sleep(0.5)
shot_ok, shot1 = capture_shot("e2e_01_space_new.png")
log_test("Workspace", "Create Space with PTY", ok, space_res, shot1 if shot_ok else None)

# Test 3: Space Management - Rename Space
space_id = space_res.get("space") if isinstance(space_res, dict) else None
if space_id:
    ok_ren, ren_res = run_app_cmd("space.rename", {"id": space_id, "name": "Work-Stack Competitive Lab"})
    log_test("Workspace", "Rename Space", ok_ren, ren_res)

# Test 4: Tab Management - Add New Tab
ok_tab, tab_res = run_app_cmd("tab.new", {"name": "Build & Diagnostics", "folder": "/home/flavio/workspace/work-stack"})
time.sleep(0.5)
shot_ok, shot2 = capture_shot("e2e_02_new_tab.png")
log_test("Tabs", "Create Tab in Space", ok_tab, tab_res, shot2 if shot_ok else None)

# Test 5: Pane Splitting - Split Right
ok_split_r, split_r = run_app_cmd("pane.split", {"direction": "right"})
time.sleep(0.5)
log_test("Panes", "Split Pane Right", ok_split_r, split_r)

# Test 6: Pane Splitting - Split Down
ok_split_d, split_d = run_app_cmd("pane.split", {"direction": "down"})
time.sleep(0.5)
shot_ok, shot3 = capture_shot("e2e_03_grid_split.png")
log_test("Panes", "Split Pane Down (Grid Layout)", ok_split_d, split_d, shot3 if shot_ok else None)

# Test 7: Terminal Execution via herdr-core (hc)
t_id = split_d.get("terminal") if isinstance(split_d, dict) else "t1"
send_res = subprocess.run(["hc", "send", t_id, "echo 'HERDR E2E TEST: OK'"], capture_output=True, text=True)
time.sleep(0.8)
read_res = subprocess.run(["hc", "read", t_id], capture_output=True, text=True)
has_echo = "HERDR E2E TEST: OK" in read_res.stdout
shot_ok, shot4 = capture_shot("e2e_04_terminal_execution.png")
log_test("Terminal Engine", "Interactive PTY Execution & Read via hc", has_echo, {"read": read_res.stdout[-150:]}, shot4 if shot_ok else None)

# Test 8: Command Palette
run_app_cmd("overlay.close")
ok_pal, pal_res = run_app_cmd("app.palette")
time.sleep(0.4)
shot_ok, shot5 = capture_shot("e2e_05_command_palette.png")
log_test("Navigation", "Open Native Command Palette", ok_pal, pal_res, shot5 if shot_ok else None)
run_app_cmd("overlay.close")

# Test 9: File Explorer Mod as Pane
ok_fmod, fmod_res = run_app_cmd("tab.new", {"name": "File Explorer", "mod": "files"})
time.sleep(0.5)
shot_ok, shot6 = capture_shot("e2e_06_files_mod_tab.png")
log_test("Mods & UI", "Load Files Mod as Dedicated Tab", ok_fmod, fmod_res, shot6 if shot_ok else None)

# Test 10: Git Changes Mod Overlay
ok_chg, chg_res = run_app_cmd("mod.open", {"name": "changes"})
time.sleep(0.5)
shot_ok, shot7 = capture_shot("e2e_07_git_changes.png")
log_test("Git Integration", "Open Git Changes / Diff Inspector", ok_chg, chg_res, shot7 if shot_ok else None)
run_app_cmd("overlay.close")

# Test 11: Git Worktree Mod Overlay
ok_wt, wt_res = run_app_cmd("mod.open", {"name": "worktree"})
time.sleep(0.5)
shot_ok, shot8 = capture_shot("e2e_08_git_worktree.png")
log_test("Git Integration", "Open Git Worktree Manager", ok_wt, wt_res, shot8 if shot_ok else None)
run_app_cmd("overlay.close")

# Test 12: Agents Mod Overlay
ok_ag, ag_res = run_app_cmd("mod.open", {"name": "agents"})
time.sleep(0.5)
shot_ok, shot9 = capture_shot("e2e_09_agents_orchestration.png")
log_test("Agent System", "Open AI Agents Management Panel", ok_ag, ag_res, shot9 if shot_ok else None)
run_app_cmd("overlay.close")

# Test 13: Remote Machine Add Mod
ok_mac, mac_res = run_app_cmd("mod.open", {"name": "machine-add"})
time.sleep(0.5)
shot_ok, shot10 = capture_shot("e2e_10_remote_machines.png")
log_test("Remote Infrastructure", "Open SSH / Cloud Remote Machine Config", ok_mac, mac_res, shot10 if shot_ok else None)
run_app_cmd("overlay.close")

# Test 14: Theme Switching (Atom One Dark)
ok_th1, th1_res = run_app_cmd("app.theme", {"name": "atom-one-dark"})
time.sleep(0.3)
shot_ok, shot11 = capture_shot("e2e_11_theme_atom_dark.png")
log_test("Customization", "Apply Theme 'atom-one-dark'", ok_th1, th1_res, shot11 if shot_ok else None)

# Test 15: Theme Switching (Retro Win98)
ok_th2, th2_res = run_app_cmd("app.theme", {"name": "win98"})
time.sleep(0.3)
shot_ok, shot12 = capture_shot("e2e_12_theme_win98.png")
log_test("Customization", "Apply Theme 'win98' Retro 3D Styling", ok_th2, th2_res, shot12 if shot_ok else None)

# Test 16: Restore Default Theme
run_app_cmd("app.theme", {"name": "atom-one-dark"})

# Test 17: Zoom In and Zoom Reset
ok_z1, _ = run_app_cmd("app.zoom_in")
ok_zr, _ = run_app_cmd("app.zoom_reset")
log_test("UI Framework", "Zoom In and Reset Controls", ok_z1 and ok_zr, {"zoom_in": ok_z1, "zoom_reset": ok_zr})

# Test 18: Terminal Search Bar
run_app_cmd("tab.select", {"index": 1})
ok_s, s_res = run_app_cmd("terminal.search")
time.sleep(0.4)
shot_ok, shot13 = capture_shot("e2e_13_terminal_search.png")
log_test("Terminal Engine", "Terminal In-Buffer Search Bar", ok_s, s_res, shot13 if shot_ok else None)

# Test 19: Settings Screen
run_app_cmd("overlay.close")
ok_set, set_res = run_app_cmd("app.settings")
time.sleep(0.4)
shot_ok, shot14 = capture_shot("e2e_14_settings_panel.png")
log_test("Settings", "App Configuration & Settings Panel", ok_set, set_res, shot14 if shot_ok else None)
run_app_cmd("overlay.close")

# Test 20: Keyboard Shortcuts Help
ok_hlp, hlp_res = run_app_cmd("app.help")
time.sleep(0.4)
shot_ok, shot15 = capture_shot("e2e_15_keyboard_help.png")
log_test("Help & Onboarding", "Keyboard Shortcuts & Keymap Dialog", ok_hlp, hlp_res, shot15 if shot_ok else None)
run_app_cmd("overlay.close")

# Save detailed results JSON
results_path = os.path.join(BRAIN_DIR, "herdr_e2e_results.json")
with open(results_path, "w") as f:
    json.dump({
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "total": len(test_results),
        "passed": sum(1 for r in test_results if r["passed"]),
        "tests": test_results
    }, f, indent=2)

print(f"\n=== COMPLETED: {sum(1 for r in test_results if r['passed'])}/{len(test_results)} PASSED ===")
print(f"Results saved in: {results_path}")
