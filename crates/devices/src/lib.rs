//! The device layer: one interface per device role, with real Bluetooth and
//! simulated implementations behind it.
//!
//! A [`DeviceProvider`] scans and connects; connected devices report through
//! a shared [`EventSender`] and take commands through their role trait
//! ([`Trainer`], [`HeartRateMonitor`], [`Controller`]). The rest of the app
//! never knows whether a device is real.

#[cfg(feature = "ble")]
pub mod ble;
pub mod sim;
mod types;

pub use types::*;
