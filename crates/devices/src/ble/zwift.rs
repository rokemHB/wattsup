use std::time::Duration;

use async_trait::async_trait;
use btleplug::api::{Characteristic, Peripheral as _, ValueNotification};
use btleplug::platform::Peripheral;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

use wattsup_core::protocol::zwift::{self as zp, ButtonEdges, PressFilter, ZwiftDeviceType, ZwiftMessage};

use super::runner::{require, write, Ctx, Flow, Protocol, TaskHandle};
use super::{ble_err, BleConfig};
use crate::{Controller, Device, DeviceError, DeviceEvent, DeviceId, DeviceKind, EventSender, Result};

/// A Zwift Click, Click v2, Play or Ride controller. A two-part one (Click v2: a puck per
/// hand, each its own BLE device) runs the other puck alongside when it is in range: the
/// right Click v2 puck keeps sending buttons without a Zwift unlock, the left one does not.
pub struct BleZwiftController {
    id: DeviceId,
    name: String,
    handle: TaskHandle<()>,
    sibling: Option<TaskHandle<()>>,
}

impl BleZwiftController {
    pub(crate) fn start(
        id: DeviceId,
        name: String,
        p: Peripheral,
        device_type: Option<ZwiftDeviceType>,
        sibling: Option<(Peripheral, ZwiftDeviceType)>,
        events: EventSender,
        config: BleConfig,
    ) -> Self {
        let presses = Arc::new(Mutex::new(PressFilter::default()));
        let epoch = std::time::Instant::now();
        let spawn = |p: Peripheral, device_type: Option<ZwiftDeviceType>, report_status: bool, events: EventSender| {
            let ctx = Ctx {
                id: id.clone(),
                name: name.clone(),
                kind: DeviceKind::Controller,
                events,
                log_raw: config.log_raw,
                report_status,
                part: device_type
                    .filter(|d| d.sibling().is_some())
                    .map(|d| if d.is_left() { "left" } else { "right" }),
            };
            let proto = Zap {
                device_type,
                edges: ButtonEdges::default(),
                watchdog: config
                    .controller_watchdog
                    .or(Some(Duration::from_secs_f64(zp::RECONNECT_AFTER_S))),
                sync_rx: None,
                last_button: std::time::Instant::now(),
                presses: presses.clone(),
                epoch,
            };
            TaskHandle::spawn(p, proto, ctx)
        };
        let sibling = sibling.map(|(sp, st)| spawn(sp, Some(st), false, events.clone()));
        let handle = spawn(p, device_type, true, events);
        Self {
            id,
            name,
            handle,
            sibling,
        }
    }
}

#[async_trait]
impl Device for BleZwiftController {
    fn id(&self) -> &DeviceId {
        &self.id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn kind(&self) -> DeviceKind {
        DeviceKind::Controller
    }
    async fn disconnect(&self) -> Result<()> {
        if let Some(s) = &self.sibling {
            s.stop().await;
        }
        self.handle.stop().await;
        Ok(())
    }
}

impl Controller for BleZwiftController {}

struct Zap {
    device_type: Option<ZwiftDeviceType>,
    edges: ButtonEdges,
    watchdog: Option<Duration>,
    sync_rx: Option<Characteristic>,
    /// When a button last changed (or the session began): a left Click v2 puck is restarted
    /// after [`zp::LEFT_RESET_IDLE_S`] of this, while the rider is not pressing.
    last_button: std::time::Instant,
    /// Shared by both pucks of a pair, so one press makes one event.
    presses: Arc<Mutex<PressFilter>>,
    epoch: std::time::Instant,
}

impl Zap {
    fn is_left_click_v2(&self) -> bool {
        self.device_type.is_some_and(|d| d.is_click_v2() && d.is_left())
    }

    async fn ride_on(&self, p: &Peripheral) -> Result<()> {
        if let Some(rx) = &self.sync_rx {
            write(p, rx, &zp::RIDE_ON, false).await?;
        }
        Ok(())
    }
}

fn uuid(s: &str) -> Uuid {
    Uuid::parse_str(s).expect("valid uuid")
}

#[async_trait]
impl Protocol for Zap {
    type Command = ();

    async fn setup(&mut self, p: &Peripheral, ctx: &Ctx) -> Result<()> {
        let missing = |_| {
            DeviceError::MissingService("Zwift controller service (update its firmware in Zwift Companion?)".into())
        };
        let async_char = require(p, uuid(zp::ASYNC_UUID), "").map_err(missing)?;
        let sync_rx = require(p, uuid(zp::SYNC_RX_UUID), "").map_err(missing)?;
        let sync_tx = require(p, uuid(zp::SYNC_TX_UUID), "").map_err(missing)?;
        p.subscribe(&async_char).await.map_err(ble_err)?;
        p.subscribe(&sync_tx).await.map_err(ble_err)?;
        self.edges = ButtonEdges::default();
        for bytes in zp::handshake(self.device_type) {
            write(p, &sync_rx, &bytes, false).await?;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        ctx.log(format!("handshake sent ({:?})", self.device_type));
        self.sync_rx = Some(sync_rx);
        self.last_button = std::time::Instant::now();
        Ok(())
    }

    async fn on_notification(&mut self, p: &Peripheral, n: ValueNotification, ctx: &Ctx) -> Result<Flow> {
        ctx.raw(
            if n.uuid == uuid(zp::ASYNC_UUID) {
                "async"
            } else {
                "sync tx"
            },
            &n.value,
        );
        match zp::parse_message(&n.value).map_err(|e| DeviceError::Bluetooth(e.to_string()))? {
            ZwiftMessage::Buttons(b) => {
                let changed = self.edges.update(b);
                if !changed.is_empty() {
                    self.last_button = std::time::Instant::now();
                }
                for button in changed {
                    let now = self.epoch.elapsed().as_secs_f64();
                    let (fresh, shift) = self.presses.lock().unwrap().press(button, now);
                    let side = ctx.part.unwrap_or("");
                    if !fresh {
                        ctx.log(format!(
                            "{button:?} again from the {side} puck: the same press, ignored"
                        ));
                        continue;
                    }
                    ctx.log(format!(
                        "{button:?} pressed ({side} puck){}",
                        if shift.is_some() { ": shift" } else { "" }
                    ));
                    ctx.emit(DeviceEvent::Button(button));
                    if let Some(dir) = shift {
                        ctx.emit(DeviceEvent::Shift(dir));
                    }
                }
            }
            ZwiftMessage::Battery(percent) => {
                ctx.emit(DeviceEvent::Battery {
                    kind: DeviceKind::Controller,
                    percent,
                });
                if let Some(part) = ctx.part {
                    ctx.emit(DeviceEvent::PartBattery {
                        kind: DeviceKind::Controller,
                        part,
                        percent,
                    });
                }
            }
            ZwiftMessage::Handshake { variant, .. } => ctx.log(format!("handshake answered ({variant:?})")),
            ZwiftMessage::Challenge => {
                // A locked puck's unlock challenge: acknowledged, which keeps it going.
                if let Some(rx) = &self.sync_rx {
                    write(p, rx, &zp::CHALLENGE_ACK, false).await?;
                }
            }
            ZwiftMessage::Stopped => {
                // Locked (no Zwift unlock in the last day): restart the puck, which comes back
                // and sends buttons for another minute, and reconnect to it.
                if let Some(rx) = &self.sync_rx {
                    let _ = write(p, rx, &zp::RESET, false).await;
                }
                return Ok(Flow::Reconnect(
                    "Click v2 left puck locked: restarting it (unlock it in the Zwift app to stop this)".into(),
                ));
            }
            ZwiftMessage::Empty | ZwiftMessage::Other { .. } => {}
        }
        Ok(Flow::Continue)
    }

    fn watchdog(&self) -> Option<Duration> {
        self.watchdog
    }

    fn tick_every(&self) -> Option<Duration> {
        Some(Duration::from_secs_f64(zp::KEEPALIVE_S))
    }

    /// Every few seconds: RideOn, which keeps the puck sending (zwiftboard). A left Click v2
    /// puck that has gone a while without a press is restarted now, while the rider is not
    /// pressing, rather than when its own watchdog cuts it off.
    async fn on_tick(&mut self, p: &Peripheral, ctx: &Ctx) -> Result<Flow> {
        if self.is_left_click_v2() && self.last_button.elapsed().as_secs_f64() >= zp::LEFT_RESET_IDLE_S {
            if let Some(rx) = &self.sync_rx {
                let _ = write(p, rx, &zp::RESET, false).await;
            }
            ctx.log("left puck idle: restarting it before it locks");
            return Ok(Flow::Reconnect("left puck restarted on schedule".into()));
        }
        self.ride_on(p).await?;
        Ok(Flow::Continue)
    }
}
