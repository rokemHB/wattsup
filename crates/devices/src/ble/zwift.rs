use std::time::Duration;

use async_trait::async_trait;
use btleplug::api::{Characteristic, Peripheral as _, ValueNotification};
use btleplug::platform::Peripheral;
use uuid::Uuid;
use wattsup_core::protocol::zwift::{self as zp, ButtonEdges, ZwiftDeviceType, ZwiftMessage};

use super::runner::{require, write, Ctx, Flow, Protocol, TaskHandle};
use super::{ble_err, BleConfig};
use crate::{Controller, Device, DeviceError, DeviceEvent, DeviceId, DeviceKind, EventSender, Result};

/// A Zwift Click, Click v2, Play or Ride controller.
pub struct BleZwiftController {
    id: DeviceId,
    name: String,
    handle: TaskHandle<()>,
}

impl BleZwiftController {
    pub(crate) fn start(
        id: DeviceId,
        name: String,
        p: Peripheral,
        device_type: Option<ZwiftDeviceType>,
        events: EventSender,
        config: BleConfig,
    ) -> Self {
        let ctx = Ctx {
            id: id.clone(),
            name: name.clone(),
            kind: DeviceKind::Controller,
            events,
            log_raw: config.log_raw,
        };
        let proto = Zap {
            device_type,
            edges: ButtonEdges::default(),
            watchdog: config.controller_watchdog,
            sync_rx: None,
        };
        let handle = TaskHandle::spawn(p, proto, ctx);
        Self { id, name, handle }
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
        Ok(())
    }

    async fn on_notification(&mut self, _p: &Peripheral, n: ValueNotification, ctx: &Ctx) -> Result<Flow> {
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
                for button in self.edges.update(b) {
                    ctx.emit(DeviceEvent::Button(button));
                    if let Some(dir) = zp::shift_for(button) {
                        ctx.emit(DeviceEvent::Shift(dir));
                    }
                }
            }
            ZwiftMessage::Battery(percent) => ctx.emit(DeviceEvent::Battery {
                kind: DeviceKind::Controller,
                percent,
            }),
            ZwiftMessage::Handshake { variant, .. } => ctx.log(format!("handshake answered ({variant:?})")),
            ZwiftMessage::Stopped => {
                return Ok(Flow::Reconnect(
                    "Click v2 stopped sending buttons (connect it in the Zwift app once to unlock it)".into(),
                ))
            }
            ZwiftMessage::Empty | ZwiftMessage::Other { .. } => {}
        }
        Ok(Flow::Continue)
    }

    fn watchdog(&self) -> Option<Duration> {
        self.watchdog
    }
}
