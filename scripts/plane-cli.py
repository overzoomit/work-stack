#!/usr/bin/env python3
"""
Plane CLI — Integrazione con Plane self-hosted per Work Stack e Agenti AI.
Legge le credenziali da ~/.config/it.overzoom.work/settings.json o dalle variabili d'ambiente.
"""
import os
import sys
import json
import urllib.request
import urllib.error
import time
from pathlib import Path

def load_settings():
    base_url = "https://plane.overzoom.it"
    workspace = "overzoom"
    api_key = ""

    # 1. Da ~/.config/it.overzoom.work/settings.json
    cfg_base = os.getenv("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    cfg_path = Path(cfg_base) / "it.overzoom.work" / "settings.json"
    if cfg_path.is_file():
        try:
            data = json.loads(cfg_path.read_text(encoding="utf-8"))
            if data.get("plane_base_url"):
                base_url = data["plane_base_url"].strip().rstrip("/")
            if data.get("plane_workspace"):
                workspace = data["plane_workspace"].strip()
            if data.get("plane_api_key"):
                api_key = data["plane_api_key"].strip()
        except Exception:
            pass

    # 2. Variabili d'ambiente (sovrascrivono se impostate)
    if os.getenv("PLANE_BASE_URL"):
        base_url = os.environ["PLANE_BASE_URL"].strip().rstrip("/")
    if os.getenv("PLANE_WORKSPACE_SLUG"):
        workspace = os.environ["PLANE_WORKSPACE_SLUG"].strip()
    elif os.getenv("PLANE_WORKSPACE"):
        workspace = os.environ["PLANE_WORKSPACE"].strip()
    if os.getenv("PLANE_API_KEY"):
        api_key = os.environ["PLANE_API_KEY"].strip()

    # 3. Fallback a ~/.claude/settings.json
    if not api_key:
        claude_cfg = Path.home() / ".claude" / "settings.json"
        if claude_cfg.is_file():
            try:
                cdata = json.loads(claude_cfg.read_text(encoding="utf-8"))
                env = cdata.get("env", {})
                if env.get("PLANE_API_KEY"):
                    api_key = env["PLANE_API_KEY"].strip()
            except Exception:
                pass

    return base_url, workspace, api_key

PLANE_BASE_URL, WORKSPACE_SLUG, API_KEY = load_settings()

def get_headers():
    if not API_KEY:
        sys.stderr.write("❌ Nessuna Plane API Key trovata. Configurala in Work Stack (Impostazioni) o imposta la variabile d'ambiente PLANE_API_KEY.\n")
        sys.exit(1)
    return {
        "X-API-Key": API_KEY,
        "Content-Type": "application/json",
        "User-Agent": "WorkStack-Plane-CLI/1.0"
    }

def http_request(method: str, url: str, payload: dict = None):
    headers = get_headers()
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    for attempt in range(4):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as resp:
                body = resp.read().decode("utf-8")
                return resp.status, json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                wait_s = 15 * (attempt + 1)
                print(f"⏳ Rate limit Plane (429), attendo {wait_s}s e riprovo...")
                time.sleep(wait_s)
                continue
            err_body = e.read().decode("utf-8", errors="replace")
            print(f"❌ HTTP Error {e.code} su {url}: {err_body}")
            sys.exit(1)
        except urllib.error.URLError as e:
            print(f"❌ Errore di connessione a {url}: {e.reason}")
            sys.exit(1)

def get_project_id() -> str:
    """Cerca .plane.json nella directory corrente per capire su quale progetto stiamo lavorando."""
    local_cfg = Path.cwd() / ".plane.json"
    if local_cfg.exists():
        data = json.loads(local_cfg.read_text(encoding="utf-8"))
        return data.get("project_id")
    env_proj = os.getenv("PLANE_PROJECT_ID")
    if env_proj:
        return env_proj
    print("❌ Nessun project_id trovato. Crea un file .plane.json nel progetto o usa 'projects' per vedere gli ID.")
    sys.exit(1)

def api_url(endpoint: str, project_id: str = None) -> str:
    if project_id:
        return f"{PLANE_BASE_URL}/api/v1/workspaces/{WORKSPACE_SLUG}/projects/{project_id}/{endpoint.lstrip('/')}"
    return f"{PLANE_BASE_URL}/api/v1/workspaces/{WORKSPACE_SLUG}/{endpoint.lstrip('/')}"

def list_projects():
    """Elenca tutti i progetti nel workspace e i relativi UUID."""
    _, data = http_request("GET", api_url("projects/"))
    projects = data.get("results", data) if isinstance(data, dict) else data
    print(f"=== Progetti su {PLANE_BASE_URL}/{WORKSPACE_SLUG} ===")
    for p in projects:
        print(f"• {p.get('name')} ({p.get('identifier')}) -> project_id: {p.get('id')}")

def get_states(project_id: str):
    _, data = http_request("GET", api_url("states/", project_id))
    results = data.get("results", data) if isinstance(data, dict) else data
    return {s["name"].lower(): s["id"] for s in results}, {s["id"]: s["name"] for s in results}

def list_issues(show_cancelled: bool = False):
    pid = get_project_id()
    _, state_names = get_states(pid)
    _, data = http_request("GET", api_url("issues/", pid))
    issues = data.get("results", data) if isinstance(data, dict) else data
    issues_sorted = sorted(issues, key=lambda x: x.get("sequence_id") or 0)
    for i in issues_sorted:
        st_name = state_names.get(i.get("state"), "Unknown")
        if not show_cancelled and st_name.lower() == "cancelled":
            continue
        print(f"[{i.get('sequence_id')}] [{st_name}] ({i.get('priority')}) {i.get('name')} | UUID: {i.get('id')}")

def get_issue_detail(issue_id: str):
    pid = get_project_id()
    _, state_names = get_states(pid)
    _, i = http_request("GET", api_url(f"issues/{issue_id}/", pid))
    st_name = state_names.get(i.get("state"), "Unknown")
    print(f"SEQ: DUPEGO-{i.get('sequence_id')} | STATE: {st_name} | PRIORITY: {i.get('priority')}")
    print(f"TITLE: {i.get('name')}\nDESCRIPTION:\n{i.get('description_html')}")
    _, c_data = http_request("GET", api_url(f"issues/{issue_id}/comments/", pid))
    comments = c_data.get("results", c_data) if isinstance(c_data, dict) else c_data
    if comments:
        print("\nCOMMENTS:")
        for c in comments:
            print(f"- [{c.get('created_at')}] {c.get('comment_html')}")

def show_all_issues():
    pid = get_project_id()
    _, state_names = get_states(pid)
    _, data = http_request("GET", api_url("issues/", pid))
    issues = data.get("results", data) if isinstance(data, dict) else data
    issues_sorted = sorted(issues, key=lambda x: x.get("sequence_id") or 0)
    for i in issues_sorted:
        st_name = state_names.get(i.get("state"), "Unknown")
        if st_name.lower() == "cancelled":
            continue
        print(f"=== DUPEGO-{i.get('sequence_id')} [{st_name}] ({i.get('priority')}) | UUID: {i.get('id')} ===")
        print(f"TITLE: {i.get('name')}")
        print(f"DESCRIPTION: {i.get('description_html')}\n")

def edit_issue(issue_id: str, json_source: str):
    """Aggiorna titolo, descrizione_html e/o priorità di un ticket esistente."""
    pid = get_project_id()
    p = Path(json_source)
    data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else json.loads(json_source)
    payload = {}
    if "title" in data:
        payload["name"] = data["title"]
    if "name" in data:
        payload["name"] = data["name"]
    if "description_html" in data:
        payload["description_html"] = data["description_html"]
    if "priority" in data:
        payload["priority"] = data["priority"]
    http_request("PATCH", api_url(f"issues/{issue_id}/", pid), payload)
    print(f"✏️ Issue {issue_id} aggiornata con successo.")

def batch_edit_issues(json_file: str):
    """Aggiorna in blocco una lista di ticket esistenti."""
    pid = get_project_id()
    items = json.loads(Path(json_file).read_text(encoding="utf-8"))
    for item in items:
        issue_id = item["uuid"]
        payload = {}
        if "title" in item:
            payload["name"] = item["title"]
        if "description_html" in item:
            payload["description_html"] = item["description_html"]
        if "priority" in item:
            payload["priority"] = item["priority"]
        http_request("PATCH", api_url(f"issues/{issue_id}/", pid), payload)
        print(f"✏️ Aggiornato: {item.get('title', issue_id)}")

def import_backlog(json_file: str):
    pid = get_project_id()
    states_map, _ = get_states(pid)
    todo_id = states_map.get("todo") or states_map.get("backlog")
    tasks = json.loads(Path(json_file).read_text(encoding="utf-8"))
    for t in tasks:
        payload = {
            "name": t["title"],
            "description_html": t["description_html"],
            "priority": t.get("priority", "high")
        }
        if todo_id:
            payload["state"] = todo_id
        status, _ = http_request("POST", api_url("issues/", pid), payload)
        if status in (200, 201):
            print(f"✅ Creato: {t['title']}")

def update_issue(issue_id: str, new_state: str, comment: str = None):
    pid = get_project_id()
    states_map, _ = get_states(pid)
    target_id = states_map.get(new_state.lower())
    if not target_id:
        print(f"❌ Stato '{new_state}' non valido. Disponibili: {list(states_map.keys())}")
        sys.exit(1)
    http_request("PATCH", api_url(f"issues/{issue_id}/", pid), {"state": target_id})
    print(f"🔄 Issue {issue_id} -> {new_state}")
    if comment:
        http_request("POST", api_url(f"issues/{issue_id}/comments/", pid), {"comment_html": f"<p>{comment}</p>"})
        print("💬 Commento registrato su Plane.")

def inspect_project(project_id: str, out_file: str = None):
    """Ispeziona la struttura completa di un progetto su Plane."""
    _, proj = http_request("GET", api_url(f"projects/{project_id}/"))
    result = {
        "project": {k: proj.get(k) for k in ("id", "name", "identifier", "description", "network", "cycle_view", "module_view", "issue_views_view", "page_view", "inbox_view", "estimate")},
        "states": [],
        "labels": [],
        "modules": [],
        "cycles": [],
        "issues": []
    }
    for ep in ("states", "labels", "modules", "cycles"):
        try:
            _, d = http_request("GET", api_url(f"{ep}/", project_id))
            res = d.get("results", d) if isinstance(d, dict) else d
            result[ep] = res
        except SystemExit:
            pass
    for m in result["modules"]:
        mid = m.get("id")
        try:
            _, mi = http_request("GET", api_url(f"modules/{mid}/module-issues/", project_id))
            m["module_issues"] = mi.get("results", mi) if isinstance(mi, dict) else mi
        except SystemExit:
            pass
    for c in result["cycles"]:
        cid = c.get("id")
        try:
            _, ci = http_request("GET", api_url(f"cycles/{cid}/cycle-issues/", project_id))
            c["cycle_issues"] = ci.get("results", ci) if isinstance(ci, dict) else ci
        except SystemExit:
            pass
    _, i_data = http_request("GET", api_url("issues/", project_id))
    issues = i_data.get("results", i_data) if isinstance(i_data, dict) else i_data
    result["issues"] = sorted(issues, key=lambda x: x.get("sequence_id") or 0)
    if out_file:
        Path(out_file).write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"✅ Dump salvato in {out_file} (states={len(result['states'])}, labels={len(result['labels'])}, modules={len(result['modules'])}, cycles={len(result['cycles'])}, issues={len(result['issues'])})")
    else:
        print(json.dumps(result, indent=2, ensure_ascii=False))

def sync_structure(config_file: str):
    """Sincronizza in modo idempotente descrizione progetto, labels, modules, cycles e issues."""
    pid = get_project_id()
    cfg = json.loads(Path(config_file).read_text(encoding="utf-8"))
    states_map, _ = get_states(pid)

    if "project" in cfg:
        http_request("PATCH", api_url(f"projects/{pid}/"), cfg["project"])
        print("✅ Metadati progetto aggiornati.")

    _, l_data = http_request("GET", api_url("labels/", pid))
    current_labels = l_data.get("results", l_data) if isinstance(l_data, dict) else l_data
    target_label_names = {l["name"].lower() for l in cfg.get("labels", [])}
    if cfg.get("prune_labels"):
        for cl in current_labels:
            if cl["name"].lower() not in target_label_names:
                http_request("DELETE", api_url(f"labels/{cl['id']}/", pid))
                print(f"🗑️ Rimossa vecchia label: {cl['name']}")
    _, l_data = http_request("GET", api_url("labels/", pid))
    existing_labels = {l["name"].lower(): l["id"] for l in (l_data.get("results", l_data) if isinstance(l_data, dict) else l_data)}
    label_map = dict(existing_labels)
    for lbl in cfg.get("labels", []):
        lname = lbl["name"].lower()
        if lname not in label_map:
            _, created = http_request("POST", api_url("labels/", pid), lbl)
            label_map[lname] = created["id"]
            print(f"🏷️ Creata label: {lbl['name']} ({created['id']})")
        else:
            http_request("PATCH", api_url(f"labels/{label_map[lname]}/", pid), lbl)
            print(f"🏷️ Aggiornata label: {lbl['name']}")

    for item in cfg.get("issues", []):
        issue_id = item["uuid"]
        payload = {
            "name": item["title"],
            "description_html": item["description_html"],
            "priority": item["priority"],
        }
        if "label_names" in item:
            payload["labels"] = [label_map[n.lower()] for n in item["label_names"] if n.lower() in label_map]
        if "state" in item and item["state"].lower() in states_map:
            payload["state"] = states_map[item["state"].lower()]
        http_request("PATCH", api_url(f"issues/{issue_id}/", pid), payload)
        if item.get("comment"):
            http_request("POST", api_url(f"issues/{issue_id}/comments/", pid), {"comment_html": f"<p>{item['comment']}</p>"})
        print(f"✏️ Aggiornato ticket: {item['title']}")

    _, i_data = http_request("GET", api_url("issues/", pid))
    existing_issues = {i["name"]: i["id"] for i in (i_data.get("results", i_data) if isinstance(i_data, dict) else i_data)}
    for doc in cfg.get("doc_issues", []):
        st_id = states_map.get(doc.get("state", "done").lower())
        lbl_ids = [label_map[n.lower()] for n in doc.get("label_names", []) if n.lower() in label_map]
        payload = {
            "name": doc["title"],
            "description_html": doc["description_html"],
            "priority": doc.get("priority", "high"),
            "labels": lbl_ids,
        }
        if st_id:
            payload["state"] = st_id
        target_uuid = doc.get("uuid") or existing_issues.get(doc["title"])
        if not target_uuid:
            _, created = http_request("POST", api_url("issues/", pid), payload)
            existing_issues[doc["title"]] = created["id"]
            print(f"🆕 Creato ticket: {doc['title']} (DUPEGO-{created.get('sequence_id')})")
        else:
            http_request("PATCH", api_url(f"issues/{target_uuid}/", pid), payload)
            existing_issues[doc["title"]] = target_uuid
            print(f"📄 Aggiornato ticket: {doc['title']}")

    _, m_data = http_request("GET", api_url("modules/", pid))
    current_modules = m_data.get("results", m_data) if isinstance(m_data, dict) else m_data
    target_mod_names = {m["name"].lower() for m in cfg.get("modules", [])}
    if cfg.get("prune_modules"):
        for cm in current_modules:
            if cm["name"].lower() not in target_mod_names:
                http_request("DELETE", api_url(f"modules/{cm['id']}/", pid))
                print(f"🗑️ Rimosso vecchio modulo: {cm['name']}")
    _, m_data = http_request("GET", api_url("modules/", pid))
    existing_modules = {m["name"].lower(): m["id"] for m in (m_data.get("results", m_data) if isinstance(m_data, dict) else m_data)}
    for mod in cfg.get("modules", []):
        mname = mod["name"].lower()
        mpayload = {
            "name": mod["name"],
            "description": mod["description"],
            "status": mod.get("status", "planned"),
        }
        if "sort_order" in mod:
            mpayload["sort_order"] = mod["sort_order"]
        if mname not in existing_modules:
            _, created = http_request("POST", api_url("modules/", pid), mpayload)
            mid = created["id"]
            existing_modules[mname] = mid
            print(f"📦 Creato modulo: {mod['name']} ({mid})")
        else:
            mid = existing_modules[mname]
            http_request("PATCH", api_url(f"modules/{mid}/", pid), mpayload)
            print(f"📦 Aggiornato modulo: {mod['name']}")
        issue_uuids = list(mod.get("issue_uuids", []))
        for doc_title in mod.get("issue_titles", []) + mod.get("doc_titles", []):
            if doc_title in existing_issues:
                issue_uuids.append(existing_issues[doc_title])
        if issue_uuids:
            http_request("POST", api_url(f"modules/{mid}/module-issues/", pid), {"issues": issue_uuids})
            print(f"   🔗 Collegati {len(issue_uuids)} ticket al modulo '{mod['name']}'")

    _, c_data = http_request("GET", api_url("cycles/", pid))
    current_cycles = c_data.get("results", c_data) if isinstance(c_data, dict) else c_data
    target_cyc_names = {c["name"].lower() for c in cfg.get("cycles", [])}
    if cfg.get("prune_cycles"):
        for cc in current_cycles:
            if cc["name"].lower() not in target_cyc_names:
                http_request("DELETE", api_url(f"cycles/{cc['id']}/", pid))
                print(f"🗑️ Rimosso vecchio ciclo: {cc['name']}")
    _, c_data = http_request("GET", api_url("cycles/", pid))
    existing_cycles = {c["name"].lower(): c["id"] for c in (c_data.get("results", c_data) if isinstance(c_data, dict) else c_data)}
    for cyc in cfg.get("cycles", []):
        cname = cyc["name"].lower()
        cpayload = {
            "name": cyc["name"],
            "description": cyc["description"],
            "project_id": pid,
            "owned_by": cyc.get("owned_by", "be00e50a-e420-4165-a2ac-801a840c9e4e"),
        }
        if "start_date" in cyc:
            cpayload["start_date"] = cyc["start_date"]
        if "end_date" in cyc:
            cpayload["end_date"] = cyc["end_date"]
        if "sort_order" in cyc:
            cpayload["sort_order"] = cyc["sort_order"]
        if cname not in existing_cycles:
            _, created = http_request("POST", api_url("cycles/", pid), cpayload)
            cid = created["id"]
            existing_cycles[cname] = cid
            print(f"🔄 Creato ciclo: {cyc['name']} ({cid})")
        else:
            cid = existing_cycles[cname]
            http_request("PATCH", api_url(f"cycles/{cid}/", pid), cpayload)
            print(f"🔄 Aggiornato ciclo: {cyc['name']}")
        c_uuids = list(cyc.get("issue_uuids", []))
        for t in cyc.get("issue_titles", []):
            if t in existing_issues:
                c_uuids.append(existing_issues[t])
        if c_uuids:
            http_request("POST", api_url(f"cycles/{cid}/cycle-issues/", pid), {"issues": c_uuids})
            print(f"   🔗 Collegati {len(c_uuids)} ticket al ciclo '{cyc['name']}'")

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "projects":
        list_projects()
    elif cmd == "inspect-project" and len(sys.argv) > 2:
        inspect_project(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    elif cmd == "sync-structure" and len(sys.argv) > 2:
        sync_structure(sys.argv[2])
    elif cmd == "list":
        list_issues(show_cancelled="--all" in sys.argv)
    elif cmd == "show-all":
        show_all_issues()
    elif cmd == "show" and len(sys.argv) > 2:
        get_issue_detail(sys.argv[2])
    elif cmd == "edit" and len(sys.argv) > 3:
        edit_issue(sys.argv[2], sys.argv[3])
    elif cmd == "batch-edit" and len(sys.argv) > 2:
        batch_edit_issues(sys.argv[2])
    elif cmd == "import" and len(sys.argv) > 2:
        import_backlog(sys.argv[2])
    elif cmd == "update" and len(sys.argv) >= 4:
        update_issue(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None)
    else:
        print("Uso: plane-cli.py [projects | inspect-project <pid> [out] | sync-structure <cfg.json> | list [--all] | show-all | show <uuid> | edit <uuid> <json> | batch-edit <file.json> | import <file.json> | update <uuid> <state> [comment]]")
