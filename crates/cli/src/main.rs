//! `wattsup-cli scan` lists devices; `wattsup-cli ride` connects and prints
//! live values once a second while you type commands. See HARDWARE_TESTING.md.

use std::time::Duration;

use clap::{Parser, Subcommand};
use tokio::io::{AsyncBufReadExt, BufReader};
use wattsup_core::gearing::ShiftDirection;
use wattsup_core::session::{ControlMode, TrainerCommand};
use wattsup_devices::{ConnectionState, DeviceId, DeviceKind};
use wattsup_engine::{Engine, EngineConfig, EngineSnapshot};

#[derive(Parser)]
#[command(
    name = "wattsup-cli",
    about = "WattsUp without the UI: scan, connect, ride, log raw packets"
)]
struct Cli {
    /// Offer only simulated devices (no Bluetooth needed).
    #[arg(long, global = true)]
    sim_only: bool,
    /// Do not offer simulated devices.
    #[arg(long, global = true)]
    no_sim: bool,
    /// Log every Bluetooth packet as hex.
    #[arg(long, global = true)]
    raw: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Scan and list trainers, heart-rate straps and controllers.
    Scan {
        #[arg(long, default_value_t = 8)]
        secs: u64,
    },
    /// Connect devices and ride. Type u/d (shift), auto <rpm>, manual, erg <W>, sim, grade <%>, q.
    Ride {
        /// Device id from `scan`, e.g. ble:XX:XX:.. or sim:trainer
        #[arg(long)]
        trainer: Option<String>,
        #[arg(long)]
        hr: Option<String>,
        #[arg(long)]
        controller: Option<String>,
        /// Scan time before connecting (Bluetooth stacks only connect to devices they have seen).
        #[arg(long, default_value_t = 6)]
        scan_secs: u64,
    },
}

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let cli = Cli::parse();
    let mut config = EngineConfig {
        ble: !cli.sim_only,
        sim: !cli.no_sim,
        ..EngineConfig::default()
    };
    config.ble_config.log_raw = cli.raw;
    let engine = Engine::start(config);

    match cli.command {
        Command::Scan { secs } => {
            println!("scanning for {secs} s...");
            let result = engine.scan(Duration::from_secs(secs)).await;
            for e in &result.errors {
                eprintln!("  ! {e}");
            }
            if result.devices.is_empty() {
                println!("no devices found");
            }
            for d in result.devices {
                let kinds: Vec<String> = d.kinds.iter().map(|k| k.to_string()).collect();
                let rssi = d.rssi.map_or(String::new(), |r| format!("  {r} dBm"));
                println!(
                    "  {:<42} {:<28} [{}]{}",
                    d.id.to_string(),
                    d.name,
                    kinds.join(", "),
                    rssi
                );
            }
        }
        Command::Ride {
            trainer,
            hr,
            controller,
            scan_secs,
        } => {
            if [&trainer, &hr, &controller]
                .iter()
                .any(|d| d.as_ref().is_some_and(|id| id.starts_with("ble:")))
            {
                println!("scanning for {scan_secs} s...");
                engine.scan(Duration::from_secs(scan_secs)).await;
            }
            for (id, kind) in [
                (trainer, DeviceKind::Trainer),
                (hr, DeviceKind::HeartRate),
                (controller, DeviceKind::Controller),
            ] {
                if let Some(id) = id {
                    if let Err(e) = engine.connect(&DeviceId(id.clone()), kind).await {
                        eprintln!("could not connect {kind} {id}: {e}");
                    }
                }
            }
            println!("commands: u = shift up, d = shift down, auto <rpm> = shift automatically, manual, erg <W>, sim, grade <%>, q = quit");
            ride(engine).await;
        }
    }
}

async fn ride(engine: Engine) {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    let mut log_seq = 0;
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                let snap = engine.snapshot();
                let since = log_seq;
                for line in snap.log.iter().filter(|l| l.seq > since) {
                    println!("  [{}] {}", line.source, line.message);
                    log_seq = line.seq;
                }
                println!("{}", status_line(&snap));
            }
            line = lines.next_line() => {
                let Ok(Some(line)) = line else { break };
                let mut words = line.split_whitespace();
                match (words.next(), words.next().and_then(|w| w.parse::<f64>().ok())) {
                    (Some("u" | "+"), _) => engine.shift(ShiftDirection::Up).await,
                    (Some("d" | "-"), _) => engine.shift(ShiftDirection::Down).await,
                    (Some("erg"), Some(w)) => {
                        engine.set_erg_target(w).await;
                        engine.set_mode(ControlMode::Erg).await;
                    }
                    (Some("sim"), _) => engine.set_mode(ControlMode::Sim).await,
                    (Some("auto"), rpm) => {
                        if let Some(rpm) = rpm {
                            engine.set_target_cadence(rpm);
                        }
                        engine.set_auto_shift(true);
                    }
                    (Some("manual"), _) => engine.set_auto_shift(false),
                    (Some("grade"), Some(g)) => engine.set_road_grade(g).await,
                    (Some("q"), _) => break,
                    (None, _) => {}
                    _ => println!("? u, d, auto <rpm>, manual, erg <W>, sim, grade <%>, q"),
                }
            }
            _ = tokio::signal::ctrl_c() => break,
        }
    }
    for kind in [DeviceKind::Trainer, DeviceKind::HeartRate, DeviceKind::Controller] {
        engine.disconnect(kind).await;
    }
}

fn status_line(s: &EngineSnapshot) -> String {
    let r = &s.session;
    let opt = |v: Option<f64>, digits: usize| v.map_or("-".to_string(), |v| format!("{v:.digits$}"));
    let sent = match r.last_command {
        Some(TrainerCommand::Simulation(t)) => {
            format!(
                "grade {:+.2}%{}",
                t.grade_pct,
                if t.clamped.is_some() { " (clamped)" } else { "" }
            )
        }
        Some(TrainerCommand::TargetPower { watts }) => format!("ERG {watts} W"),
        None => "-".into(),
    };
    let devices: Vec<String> = s
        .devices
        .iter()
        .map(|d| {
            let state = match &d.state {
                ConnectionState::Connected => "ok",
                ConnectionState::Connecting => "...",
                ConnectionState::Reconnecting(_) => "retry",
                ConnectionState::Failed(_) => "FAIL",
                ConnectionState::Disconnected => "-",
            };
            format!("{}:{state}", d.kind)
        })
        .collect();
    format!(
        "{:>6.0}s  {:>4} W (model {:>3.0})  {:>5} rpm  {:>5} km/h trainer  {:>5.1} km/h virtual  HR {:>3}  gear {:>2}/{} ({:.2}){}  drive {}  sent {}  [{}]",
        r.elapsed_s,
        opt(r.power_w, 0),
        r.model_power_w,
        opt(r.cadence_rpm, 1),
        opt(r.trainer_speed_kmh, 1),
        r.virtual_speed_kmh,
        opt(r.heart_rate_bpm, 0),
        r.gear,
        r.gear_count,
        r.gear_ratio,
        if r.auto_shift {
            format!(" auto {:.0}", r.target_cadence_rpm)
        } else {
            String::new()
        },
        opt(r.measured_drive_ratio, 2),
        sent,
        devices.join(" ")
    )
}
