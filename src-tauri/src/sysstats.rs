// Machine load for the status bar: system CPU and RAM, plus Work's own
// processes. CPU is measured between two calls, so the first one reads 0.
use serde_json::{json, Value};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

// Work's processes: its own and, on Linux, the WebKit ones it starts (not the
// shells and agents running in its terminals).
// ponytail: on macOS WebKit runs as XPC services owned by launchd, so only
// Work's own process is counted; the responsible-pid API would find them.
fn work_pids(sys: &mut System) -> Vec<Pid> {
    let me = sysinfo::get_current_pid().ok();
    let mut pids: Vec<Pid> = me.into_iter().collect();
    if cfg!(target_os = "linux") {
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        pids.extend(sys.processes().iter().filter(|(_, p)| p.parent() == me && p.name().to_string_lossy().starts_with("WebKit")).map(|(pid, _)| *pid));
    }
    pids
}

pub fn sample(sys: &mut System) -> Value {
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    let cores = sys.cpus().len().max(1);
    let pids = work_pids(sys);
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&pids), true, ProcessRefreshKind::nothing().with_cpu().with_memory());
    let procs: Vec<_> = pids.iter().filter_map(|p| sys.process(*p)).collect();
    let load = System::load_average();
    json!({
        "cpu": sys.global_cpu_usage() as f64 / 100.0,
        "memUsed": sys.used_memory(),
        "memTotal": sys.total_memory(),
        "load": [load.one, load.five, load.fifteen],
        "cores": cores,
        "work": {
            "mem": procs.iter().map(|p| p.memory()).sum::<u64>(),
            // cpu_usage is per core: spread it over all of them, like `cpu`.
            "cpu": procs.iter().map(|p| p.cpu_usage() as f64).sum::<f64>() / 100.0 / cores as f64,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_reads_the_machine_and_work_itself() {
        let mut sys = System::new();
        sample(&mut sys);
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        let s = sample(&mut sys);
        let (used, total) = (s["memUsed"].as_u64().unwrap(), s["memTotal"].as_u64().unwrap());
        assert!(used > 0 && used <= total);
        assert!((0.0..=1.0).contains(&s["cpu"].as_f64().unwrap()));
        assert!(s["work"]["mem"].as_u64().unwrap() > 0, "this test process is Work here");
        assert_eq!(s["load"].as_array().unwrap().len(), 3);
    }
}
