//! The connect → set up → listen → reconnect loop shared by all BLE devices.

use std::time::Duration;

use async_trait::async_trait;
use btleplug::api::{Characteristic, Peripheral as _, ValueNotification, WriteType};
use btleplug::platform::Peripheral;
use futures::StreamExt;
use tokio::sync::{mpsc, watch};
use tokio::time::{sleep, timeout, Instant};
use uuid::Uuid;
use wattsup_core::protocol::hex;

use super::ble_err;
use crate::{ConnectionState, DeviceError, DeviceEvent, DeviceId, DeviceKind, EventSender, Result};

/// What a running device task can use.
pub(crate) struct Ctx {
    pub id: DeviceId,
    pub name: String,
    pub kind: DeviceKind,
    pub events: EventSender,
    pub log_raw: bool,
}

impl Ctx {
    pub fn emit(&self, event: DeviceEvent) {
        let _ = self.events.send(event);
    }
    pub fn status(&self, state: ConnectionState) {
        self.emit(DeviceEvent::Status {
            kind: self.kind,
            id: self.id.clone(),
            name: self.name.clone(),
            state,
        });
    }
    pub fn log(&self, message: impl Into<String>) {
        let message = message.into();
        log::info!("[{} {}] {}", self.kind, self.name, message);
        self.emit(DeviceEvent::Log {
            kind: self.kind,
            message,
        });
    }
    pub fn raw(&self, what: &str, bytes: &[u8]) {
        if self.log_raw {
            self.log(format!("{what} << {}", hex(bytes)));
        }
    }
}

pub(crate) enum Flow {
    Continue,
    Reconnect(String),
}

/// The role-specific half of a BLE device.
#[async_trait]
pub(crate) trait Protocol: Send + 'static {
    type Command: Send + 'static;

    /// Runs after connect + service discovery: find characteristics, subscribe, handshake.
    async fn setup(&mut self, p: &Peripheral, ctx: &Ctx) -> Result<()>;
    async fn on_notification(&mut self, p: &Peripheral, n: ValueNotification, ctx: &Ctx) -> Result<Flow>;
    async fn on_command(&mut self, _p: &Peripheral, _cmd: Self::Command, _ctx: &Ctx) -> Result<()> {
        Ok(())
    }
    /// Reconnect if nothing arrives for this long.
    fn watchdog(&self) -> Option<Duration> {
        None
    }
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const LINK_CHECK: Duration = Duration::from_secs(2);

pub(crate) async fn run<P: Protocol>(
    peripheral: Peripheral,
    mut proto: P,
    ctx: Ctx,
    mut commands: mpsc::UnboundedReceiver<P::Command>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut attempt: u32 = 0;
    let mut reason = String::new();
    while !*shutdown.borrow() {
        ctx.status(if attempt == 0 {
            ConnectionState::Connecting
        } else {
            ConnectionState::Reconnecting(reason.clone())
        });
        match session(&peripheral, &mut proto, &ctx, &mut commands, &mut shutdown).await {
            Ok(None) => break,
            Ok(Some(why)) => {
                reason = why;
                attempt = 1;
            }
            Err(e) => {
                reason = e.to_string();
                attempt += 1;
                ctx.log(format!("connection attempt failed: {reason}"));
            }
        }
        let _ = peripheral.disconnect().await;
        let backoff = Duration::from_secs(2u64.saturating_pow(attempt.min(4)).min(15));
        tokio::select! {
            _ = sleep(backoff) => {}
            _ = shutdown.changed() => break,
        }
    }
    let _ = peripheral.disconnect().await;
    ctx.status(ConnectionState::Disconnected);
}

/// One connected stretch. `Ok(None)` = shut down on request, `Ok(Some(reason))` = reconnect.
async fn session<P: Protocol>(
    p: &Peripheral,
    proto: &mut P,
    ctx: &Ctx,
    commands: &mut mpsc::UnboundedReceiver<P::Command>,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<Option<String>> {
    if !p.is_connected().await.map_err(ble_err)? {
        timeout(CONNECT_TIMEOUT, p.connect())
            .await
            .map_err(|_| DeviceError::Timeout("connect".into()))?
            .map_err(ble_err)?;
    }
    p.discover_services().await.map_err(ble_err)?;
    let mut notifications = p.notifications().await.map_err(ble_err)?;
    proto.setup(p, ctx).await?;
    ctx.status(ConnectionState::Connected);

    let watchdog = proto.watchdog();
    let mut last_packet = Instant::now();
    let mut link_check = tokio::time::interval(LINK_CHECK);
    loop {
        let deadline = last_packet + watchdog.unwrap_or(Duration::from_secs(3600));
        tokio::select! {
            _ = shutdown.changed() => return Ok(None),
            n = notifications.next() => match n {
                Some(n) => {
                    last_packet = Instant::now();
                    match proto.on_notification(p, n, ctx).await {
                        Ok(Flow::Continue) => {}
                        Ok(Flow::Reconnect(why)) => return Ok(Some(why)),
                        Err(e) => ctx.log(format!("bad packet: {e}")),
                    }
                }
                None => return Ok(Some("notification stream ended".into())),
            },
            cmd = commands.recv() => match cmd {
                Some(cmd) => if let Err(e) = proto.on_command(p, cmd, ctx).await {
                    ctx.log(format!("command failed: {e}"));
                },
                None => return Ok(None),
            },
            _ = link_check.tick() => {
                if !p.is_connected().await.unwrap_or(false) {
                    return Ok(Some("link lost".into()));
                }
            }
            _ = tokio::time::sleep_until(deadline), if watchdog.is_some() => {
                return Ok(Some(format!("no data for {} s", watchdog.unwrap_or_default().as_secs())));
            }
        }
    }
}

/// Finds a characteristic by UUID across all discovered services.
pub(crate) fn find(p: &Peripheral, uuid: Uuid) -> Option<Characteristic> {
    p.characteristics().into_iter().find(|c| c.uuid == uuid)
}

pub(crate) fn require(p: &Peripheral, uuid: Uuid, what: &str) -> Result<Characteristic> {
    find(p, uuid).ok_or_else(|| DeviceError::MissingService(what.into()))
}

pub(crate) async fn write(p: &Peripheral, c: &Characteristic, bytes: &[u8], with_response: bool) -> Result<()> {
    let kind = if with_response {
        WriteType::WithResponse
    } else {
        WriteType::WithoutResponse
    };
    p.write(c, bytes, kind).await.map_err(ble_err)
}

/// Handle shared by the public device structs: commands in, shutdown, task.
pub(crate) struct TaskHandle<C> {
    pub commands: mpsc::UnboundedSender<C>,
    shutdown: watch::Sender<bool>,
    task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl<C: Send + 'static> TaskHandle<C> {
    pub fn spawn<P: Protocol<Command = C>>(peripheral: Peripheral, proto: P, ctx: Ctx) -> Self {
        let (commands, rx) = mpsc::unbounded_channel();
        let (shutdown, shutdown_rx) = watch::channel(false);
        let task = tokio::spawn(run(peripheral, proto, ctx, rx, shutdown_rx));
        Self {
            commands,
            shutdown,
            task: std::sync::Mutex::new(Some(task)),
        }
    }

    pub async fn stop(&self) {
        let _ = self.shutdown.send(true);
        let task = self.task.lock().unwrap().take();
        if let Some(task) = task {
            if timeout(Duration::from_secs(5), task).await.is_err() {
                log::warn!("device task did not stop in time");
            }
        }
    }
}

impl<C> Drop for TaskHandle<C> {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}
