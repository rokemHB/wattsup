use async_trait::async_trait;
use btleplug::api::bleuuid::uuid_from_u16;
use btleplug::api::{Characteristic, Peripheral as _, ValueNotification};
use btleplug::platform::Peripheral;
use std::time::Duration;
use wattsup_core::protocol::ftms::{self, ControlRequest, MachineStatus, ResultCode};
use wattsup_core::session::{TrainerCommand, TrainerSample};

use super::runner::{find, require, write, Ctx, Flow, Protocol, TaskHandle};
use super::{ble_err, BleConfig};
use crate::{Device, DeviceError, DeviceEvent, DeviceId, DeviceKind, EventSender, Result, Trainer};

/// An FTMS smart trainer (KICKR CORE 2 and any other FTMS bike trainer).
pub struct BleTrainer {
    id: DeviceId,
    name: String,
    handle: TaskHandle<TrainerCommand>,
}

impl BleTrainer {
    pub(crate) fn start(id: DeviceId, name: String, p: Peripheral, events: EventSender, config: BleConfig) -> Self {
        let ctx = Ctx {
            id: id.clone(),
            name: name.clone(),
            kind: DeviceKind::Trainer,
            events,
            log_raw: config.log_raw,
        };
        let handle = TaskHandle::spawn(p, Ftms::default(), ctx);
        Self { id, name, handle }
    }
}

#[async_trait]
impl Device for BleTrainer {
    fn id(&self) -> &DeviceId {
        &self.id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn kind(&self) -> DeviceKind {
        DeviceKind::Trainer
    }
    async fn disconnect(&self) -> Result<()> {
        self.handle.stop().await;
        Ok(())
    }
}

#[async_trait]
impl Trainer for BleTrainer {
    async fn send(&self, command: TrainerCommand) -> Result<()> {
        self.handle
            .commands
            .send(command)
            .map_err(|_| DeviceError::NotConnected)
    }
}

#[derive(Default)]
struct Ftms {
    control_point: Option<Characteristic>,
    /// Re-sent after every (re)connect and after regaining control.
    last_command: Option<TrainerCommand>,
}

impl Ftms {
    async fn control(&self, p: &Peripheral, req: ControlRequest, ctx: &Ctx) -> Result<()> {
        let cp = self.control_point.as_ref().ok_or(DeviceError::NotConnected)?;
        let bytes = req.encode();
        if ctx.log_raw {
            ctx.log(format!("control point >> {}", wattsup_core::protocol::hex(&bytes)));
        }
        write(p, cp, &bytes, true).await
    }

    async fn take_control(&self, p: &Peripheral, ctx: &Ctx) -> Result<()> {
        self.control(p, ControlRequest::RequestControl, ctx).await?;
        // FTMS allows one outstanding control procedure; give the indication time to arrive.
        tokio::time::sleep(Duration::from_millis(150)).await;
        self.control(p, ControlRequest::StartOrResume, ctx).await?;
        if let Some(cmd) = self.last_command {
            tokio::time::sleep(Duration::from_millis(150)).await;
            self.control(p, cmd.to_ftms(), ctx).await?;
        }
        Ok(())
    }
}

#[async_trait]
impl Protocol for Ftms {
    type Command = TrainerCommand;

    async fn setup(&mut self, p: &Peripheral, ctx: &Ctx) -> Result<()> {
        let data = require(p, uuid_from_u16(ftms::INDOOR_BIKE_DATA), "FTMS Indoor Bike Data")?;
        let cp = require(p, uuid_from_u16(ftms::CONTROL_POINT), "FTMS Control Point")?;
        if let Some(feature) = find(p, uuid_from_u16(ftms::FEATURE)) {
            match p
                .read(&feature)
                .await
                .map_err(ble_err)
                .and_then(|b| ftms::parse_features(&b).map_err(|e| DeviceError::Bluetooth(e.to_string())))
            {
                Ok(f) => ctx.log(format!(
                    "features: simulation={} target power={} target resistance={} (raw {:08x} {:08x})",
                    f.simulation_supported(),
                    f.power_target_supported(),
                    f.resistance_target_supported(),
                    f.machine,
                    f.target_settings
                )),
                Err(e) => ctx.log(format!("could not read features: {e}")),
            }
        }
        if let Some(range) = find(p, uuid_from_u16(ftms::SUPPORTED_POWER_RANGE)) {
            if let Ok(Ok(r)) = p.read(&range).await.map(|b| ftms::parse_power_range(&b)) {
                ctx.log(format!("power range {}..{} W", r.min_w, r.max_w));
            }
        }
        p.subscribe(&data).await.map_err(ble_err)?;
        p.subscribe(&cp).await.map_err(ble_err)?;
        if let Some(status) = find(p, uuid_from_u16(ftms::MACHINE_STATUS)) {
            p.subscribe(&status).await.map_err(ble_err)?;
        }
        self.control_point = Some(cp);
        self.take_control(p, ctx).await
    }

    async fn on_notification(&mut self, p: &Peripheral, n: ValueNotification, ctx: &Ctx) -> Result<Flow> {
        let parse_err = |e: wattsup_core::protocol::ParseError| DeviceError::Bluetooth(e.to_string());
        if n.uuid == uuid_from_u16(ftms::INDOOR_BIKE_DATA) {
            ctx.raw("indoor bike data", &n.value);
            let d = ftms::parse_indoor_bike_data(&n.value).map_err(parse_err)?;
            ctx.emit(DeviceEvent::Trainer(TrainerSample {
                power_w: d.power_w.map(f64::from),
                cadence_rpm: d.cadence_rpm,
                speed_kmh: d.speed_kmh,
            }));
        } else if n.uuid == uuid_from_u16(ftms::CONTROL_POINT) {
            ctx.raw("control point", &n.value);
            let r = ftms::parse_control_response(&n.value).map_err(parse_err)?;
            if r.result != ResultCode::Success {
                ctx.log(format!(
                    "control point opcode {:#04x} answered {:?}",
                    r.request_opcode, r.result
                ));
            }
            if r.result == ResultCode::ControlNotPermitted {
                self.take_control(p, ctx).await?;
            }
        } else if n.uuid == uuid_from_u16(ftms::MACHINE_STATUS) {
            ctx.raw("machine status", &n.value);
            if let MachineStatus::ControlPermissionLost = ftms::parse_machine_status(&n.value).map_err(parse_err)? {
                ctx.log("another app took control of the trainer; taking it back");
                self.take_control(p, ctx).await?;
            }
        }
        Ok(Flow::Continue)
    }

    async fn on_command(&mut self, p: &Peripheral, cmd: TrainerCommand, ctx: &Ctx) -> Result<()> {
        self.last_command = Some(cmd);
        self.control(p, cmd.to_ftms(), ctx).await
    }
}
