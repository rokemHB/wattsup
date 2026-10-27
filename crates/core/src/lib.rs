//! Pure ride logic for WattsUp.
//!
//! Nothing in this crate touches Bluetooth, files or clocks: devices hand in
//! bytes and timestamps, and get typed values and commands back. That keeps
//! every rule here unit-testable without hardware.

pub mod gearing;
pub mod physics;
pub mod protocol;
pub mod resistance;
pub mod session;
