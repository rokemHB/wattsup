//! Real Bluetooth LE devices through btleplug (BlueZ on Linux, CoreBluetooth
//! on macOS, WinRT on Windows).
//!
//! Every connected device runs one task (see [`runner`]) that connects,
//! sets the device up, pumps notifications and reconnects when the link
//! drops. The role-specific parts live in `trainer`, `heart_rate` and `zwift`.

mod heart_rate;
mod runner;
mod trainer;
mod zwift;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use btleplug::api::bleuuid::uuid_from_u16;
use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter};
use btleplug::platform::{Adapter, Manager, Peripheral};
use tokio::sync::{Mutex, OnceCell};
use uuid::Uuid;
use wattsup_core::protocol::{ftms, hrs, zwift as zp};

use crate::{
    Controller, DeviceError, DeviceId, DeviceKind, DeviceProvider, DiscoveredDevice, EventSender, HeartRateMonitor,
    Result, Trainer,
};

pub const PROVIDER: &str = "ble";

#[derive(Clone, Debug, Default)]
pub struct BleConfig {
    /// Log every received packet as hex (for HARDWARE_TESTING.md and bug reports).
    pub log_raw: bool,
    /// Reconnect a Zwift controller after this long without any packet.
    /// Off by default: it is not known yet whether every model sends keep-alives.
    pub controller_watchdog: Option<Duration>,
}

pub struct BleProvider {
    config: BleConfig,
    adapter: OnceCell<Adapter>,
    seen: Mutex<HashMap<String, Peripheral>>,
}

impl BleProvider {
    pub fn new(config: BleConfig) -> Self {
        Self {
            config,
            adapter: OnceCell::new(),
            seen: Mutex::new(HashMap::new()),
        }
    }

    async fn adapter(&self) -> Result<&Adapter> {
        self.adapter
            .get_or_try_init(|| async {
                let manager = Manager::new().await.map_err(ble_err)?;
                manager
                    .adapters()
                    .await
                    .map_err(ble_err)?
                    .into_iter()
                    .next()
                    .ok_or(DeviceError::NoAdapter)
            })
            .await
    }

    /// Human-readable adapter description, for the debug screen.
    pub async fn adapter_info(&self) -> Result<String> {
        self.adapter().await?.adapter_info().await.map_err(ble_err)
    }

    async fn peripheral(&self, id: &DeviceId) -> Result<Peripheral> {
        if let Some(p) = self.seen.lock().await.get(id.local()) {
            return Ok(p.clone());
        }
        let adapter = self.adapter().await?;
        for p in adapter.peripherals().await.map_err(ble_err)? {
            if p.id().to_string() == id.local() {
                return Ok(p);
            }
        }
        Err(DeviceError::NotFound(id.clone()))
    }

    async fn name_of(p: &Peripheral) -> String {
        match p.properties().await {
            Ok(Some(props)) => props
                .local_name
                .or(props.advertisement_name)
                .unwrap_or_else(|| p.id().to_string()),
            _ => p.id().to_string(),
        }
    }
}

pub(crate) fn ble_err(e: btleplug::Error) -> DeviceError {
    DeviceError::Bluetooth(e.to_string())
}

pub(crate) fn zwift_service() -> Uuid {
    Uuid::parse_str(zp::SERVICE_UUID).expect("valid uuid")
}

/// Which roles an advertisement can fill.
pub fn classify(services: &[Uuid], manufacturer_data: &HashMap<u16, Vec<u8>>) -> Vec<DeviceKind> {
    let mut kinds = Vec::new();
    if services.contains(&uuid_from_u16(ftms::SERVICE)) {
        kinds.push(DeviceKind::Trainer);
    }
    if services.contains(&uuid_from_u16(hrs::SERVICE)) {
        kinds.push(DeviceKind::HeartRate);
    }
    let zwift_type = manufacturer_data
        .get(&zp::MANUFACTURER_ID)
        .and_then(|d| zp::ZwiftDeviceType::from_manufacturer_data(d));
    if zwift_type.is_some() || services.contains(&zwift_service()) {
        kinds.push(DeviceKind::Controller);
    }
    kinds
}

#[async_trait]
impl DeviceProvider for BleProvider {
    fn name(&self) -> &'static str {
        PROVIDER
    }

    async fn scan(&self, duration: Duration) -> Result<Vec<DiscoveredDevice>> {
        let adapter = self.adapter().await?;
        if let Err(e) = adapter.start_scan(ScanFilter::default()).await {
            // The previous scan is kept running (see below): BlueZ answers a second
            // StartDiscovery with "Operation already in progress", which is fine.
            if !e.to_string().to_lowercase().contains("already in progress") {
                return Err(ble_err(e));
            }
        }
        tokio::time::sleep(duration).await;
        // Keep the scan running on purpose: some stacks forget peripherals after stop_scan.
        let mut found = Vec::new();
        let mut seen = self.seen.lock().await;
        for p in adapter.peripherals().await.map_err(ble_err)? {
            let Ok(Some(props)) = p.properties().await else {
                continue;
            };
            let kinds = classify(&props.services, &props.manufacturer_data);
            if kinds.is_empty() {
                continue;
            }
            let local = p.id().to_string();
            found.push(DiscoveredDevice {
                id: DeviceId::new(PROVIDER, &local),
                name: props
                    .local_name
                    .clone()
                    .or(props.advertisement_name.clone())
                    .unwrap_or_else(|| local.clone()),
                kinds,
                rssi: props.rssi,
                simulated: false,
            });
            seen.insert(local, p);
        }
        found.sort_by_key(|d| std::cmp::Reverse(d.rssi.unwrap_or(i16::MIN)));
        Ok(found)
    }

    async fn connect_trainer(&self, id: &DeviceId, events: EventSender) -> Result<Arc<dyn Trainer>> {
        let p = self.peripheral(id).await?;
        let name = Self::name_of(&p).await;
        Ok(Arc::new(trainer::BleTrainer::start(
            id.clone(),
            name,
            p,
            events,
            self.config.clone(),
        )))
    }

    async fn connect_heart_rate(&self, id: &DeviceId, events: EventSender) -> Result<Arc<dyn HeartRateMonitor>> {
        let p = self.peripheral(id).await?;
        let name = Self::name_of(&p).await;
        Ok(Arc::new(heart_rate::BleHeartRate::start(
            id.clone(),
            name,
            p,
            events,
            self.config.clone(),
        )))
    }

    async fn connect_controller(&self, id: &DeviceId, events: EventSender) -> Result<Arc<dyn Controller>> {
        let p = self.peripheral(id).await?;
        let name = Self::name_of(&p).await;
        let device_type = match p.properties().await {
            Ok(Some(props)) => props
                .manufacturer_data
                .get(&zp::MANUFACTURER_ID)
                .and_then(|d| zp::ZwiftDeviceType::from_manufacturer_data(d)),
            _ => None,
        };
        Ok(Arc::new(zwift::BleZwiftController::start(
            id.clone(),
            name,
            p,
            device_type,
            events,
            self.config.clone(),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_service_and_manufacturer_data() {
        let none = HashMap::new();
        assert_eq!(classify(&[uuid_from_u16(0x1826)], &none), vec![DeviceKind::Trainer]);
        assert_eq!(classify(&[uuid_from_u16(0x180D)], &none), vec![DeviceKind::HeartRate]);
        assert_eq!(
            classify(&[uuid_from_u16(0x1826), uuid_from_u16(0x180D)], &none),
            vec![DeviceKind::Trainer, DeviceKind::HeartRate]
        );
        let click = HashMap::from([(0x094A, vec![0x0A])]);
        assert_eq!(classify(&[], &click), vec![DeviceKind::Controller]);
        assert_eq!(classify(&[zwift_service()], &none), vec![DeviceKind::Controller]);
        let unknown_zwift = HashMap::from([(0x094A, vec![0x42])]);
        assert!(classify(&[uuid_from_u16(0x1818)], &unknown_zwift).is_empty());
    }
}
