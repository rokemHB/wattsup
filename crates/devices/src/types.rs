use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use wattsup_core::gearing::ShiftDirection;
use wattsup_core::protocol::zwift::Button;
use wattsup_core::session::{TrainerCommand, TrainerSample};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    Trainer,
    HeartRate,
    Controller,
}

impl fmt::Display for DeviceKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            DeviceKind::Trainer => "trainer",
            DeviceKind::HeartRate => "heart rate",
            DeviceKind::Controller => "controller",
        })
    }
}

/// Stable identifier: `"<provider>:<provider-specific id>"`, e.g. `sim:trainer`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DeviceId(pub String);

impl DeviceId {
    pub fn new(provider: &str, local: &str) -> Self {
        Self(format!("{provider}:{local}"))
    }
    pub fn provider(&self) -> &str {
        self.0.split_once(':').map_or("", |(p, _)| p)
    }
    pub fn local(&self) -> &str {
        self.0.split_once(':').map_or(&self.0, |(_, l)| l)
    }
}

impl fmt::Display for DeviceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DiscoveredDevice {
    pub id: DeviceId,
    pub name: String,
    /// Roles this device can fill, judged from its advertised services.
    pub kinds: Vec<DeviceKind>,
    pub rssi: Option<i16>,
    pub simulated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "detail", rename_all = "snake_case")]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    /// Lost or stalled; the device task is trying to get it back.
    Reconnecting(String),
    Failed(String),
}

/// Everything devices report, on one channel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DeviceEvent {
    Status {
        kind: DeviceKind,
        id: DeviceId,
        name: String,
        state: ConnectionState,
    },
    Trainer(TrainerSample),
    HeartRate {
        bpm: f64,
        rr_intervals_ms: Vec<f64>,
    },
    /// A controller button meant a shift.
    Shift(ShiftDirection),
    /// Any newly pressed controller button (the game will use more than shifting).
    Button(Button),
    Battery {
        kind: DeviceKind,
        percent: u8,
    },
    /// Human-readable diagnostics, e.g. raw packets in hex or control point results.
    Log {
        kind: DeviceKind,
        message: String,
    },
}

pub type EventSender = mpsc::UnboundedSender<DeviceEvent>;
pub type EventReceiver = mpsc::UnboundedReceiver<DeviceEvent>;

pub fn event_channel() -> (EventSender, EventReceiver) {
    mpsc::unbounded_channel()
}

#[derive(Debug, thiserror::Error)]
pub enum DeviceError {
    #[error("no Bluetooth adapter found")]
    NoAdapter,
    #[error("device {0} not found (scan again?)")]
    NotFound(DeviceId),
    #[error("device does not offer {0}")]
    MissingService(String),
    #[error("not supported: {0}")]
    Unsupported(String),
    #[error("Bluetooth error: {0}")]
    Bluetooth(String),
    #[error("timed out: {0}")]
    Timeout(String),
    #[error("not connected")]
    NotConnected,
}

pub type Result<T, E = DeviceError> = std::result::Result<T, E>;

/// What every connected device can do.
#[async_trait]
pub trait Device: Send + Sync {
    fn id(&self) -> &DeviceId;
    fn name(&self) -> &str;
    fn kind(&self) -> DeviceKind;
    /// Stops the device task and releases the connection. Idempotent.
    async fn disconnect(&self) -> Result<()>;
}

/// A smart trainer: reports power/cadence/speed, takes resistance commands.
#[async_trait]
pub trait Trainer: Device {
    async fn send(&self, command: TrainerCommand) -> Result<()>;
}

/// A heart-rate strap. Reporting only.
pub trait HeartRateMonitor: Device {}

/// A shifter / button controller.
#[async_trait]
pub trait Controller: Device {
    /// Acts as if `button` was pressed. Only simulated controllers support this.
    async fn inject(&self, _button: Button) -> Result<()> {
        Err(DeviceError::Unsupported(
            "injecting presses into a real controller".into(),
        ))
    }
}

/// A source of devices: real Bluetooth, the simulator, later maybe ANT+.
#[async_trait]
pub trait DeviceProvider: Send + Sync {
    /// Prefix of every [`DeviceId`] this provider hands out.
    fn name(&self) -> &'static str;
    async fn scan(&self, duration: Duration) -> Result<Vec<DiscoveredDevice>>;
    async fn connect_trainer(&self, id: &DeviceId, events: EventSender) -> Result<Arc<dyn Trainer>>;
    async fn connect_heart_rate(&self, id: &DeviceId, events: EventSender) -> Result<Arc<dyn HeartRateMonitor>>;
    async fn connect_controller(&self, id: &DeviceId, events: EventSender) -> Result<Arc<dyn Controller>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_id_parts() {
        let id = DeviceId::new("ble", "AA:BB:CC:DD:EE:FF");
        assert_eq!(id.provider(), "ble");
        assert_eq!(id.local(), "AA:BB:CC:DD:EE:FF");
        assert_eq!(id.to_string(), "ble:AA:BB:CC:DD:EE:FF");
    }
}
