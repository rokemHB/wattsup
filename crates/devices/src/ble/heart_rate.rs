use async_trait::async_trait;
use btleplug::api::bleuuid::uuid_from_u16;
use btleplug::api::{Peripheral as _, ValueNotification};
use btleplug::platform::Peripheral;
use wattsup_core::protocol::hrs;

use super::runner::{find, require, Ctx, Flow, Protocol, TaskHandle};
use super::{ble_err, BleConfig};
use crate::{Device, DeviceError, DeviceEvent, DeviceId, DeviceKind, EventSender, HeartRateMonitor, Result};

const BATTERY_LEVEL: u16 = 0x2A19;

/// A standard Bluetooth heart-rate strap.
pub struct BleHeartRate {
    id: DeviceId,
    name: String,
    handle: TaskHandle<()>,
}

impl BleHeartRate {
    pub(crate) fn start(id: DeviceId, name: String, p: Peripheral, events: EventSender, config: BleConfig) -> Self {
        let ctx = Ctx {
            id: id.clone(),
            name: name.clone(),
            kind: DeviceKind::HeartRate,
            events,
            log_raw: config.log_raw,
        };
        let handle = TaskHandle::spawn(p, Hrs, ctx);
        Self { id, name, handle }
    }
}

#[async_trait]
impl Device for BleHeartRate {
    fn id(&self) -> &DeviceId {
        &self.id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn kind(&self) -> DeviceKind {
        DeviceKind::HeartRate
    }
    async fn disconnect(&self) -> Result<()> {
        self.handle.stop().await;
        Ok(())
    }
}

impl HeartRateMonitor for BleHeartRate {}

struct Hrs;

#[async_trait]
impl Protocol for Hrs {
    type Command = ();

    async fn setup(&mut self, p: &Peripheral, ctx: &Ctx) -> Result<()> {
        let m = require(p, uuid_from_u16(hrs::MEASUREMENT), "Heart Rate Measurement")?;
        p.subscribe(&m).await.map_err(ble_err)?;
        if let Some(battery) = find(p, uuid_from_u16(BATTERY_LEVEL)) {
            if let Ok(b) = p.read(&battery).await {
                if let Some(&percent) = b.first() {
                    ctx.emit(DeviceEvent::Battery {
                        kind: DeviceKind::HeartRate,
                        percent,
                    });
                }
            }
        }
        Ok(())
    }

    async fn on_notification(&mut self, _p: &Peripheral, n: ValueNotification, ctx: &Ctx) -> Result<Flow> {
        if n.uuid == uuid_from_u16(hrs::MEASUREMENT) {
            ctx.raw("heart rate", &n.value);
            let m = hrs::parse_measurement(&n.value).map_err(|e| DeviceError::Bluetooth(e.to_string()))?;
            // 0 bpm is what straps send while not on skin.
            if m.bpm > 0 && m.sensor_contact != Some(false) {
                ctx.emit(DeviceEvent::HeartRate {
                    bpm: m.bpm as f64,
                    rr_intervals_ms: m.rr_intervals_ms,
                });
            }
        }
        Ok(Flow::Continue)
    }
}
