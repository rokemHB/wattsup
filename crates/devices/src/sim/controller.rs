use async_trait::async_trait;
use std::sync::atomic::{AtomicBool, Ordering};
use wattsup_core::protocol::zwift::{shift_for, Button};

use super::status;
use crate::{ConnectionState, Controller, Device, DeviceError, DeviceEvent, DeviceId, DeviceKind, EventSender, Result};

/// A controller that only presses buttons when told to (from the debug screen).
pub struct SimController {
    id: DeviceId,
    events: EventSender,
    connected: AtomicBool,
}

const NAME: &str = "Simulated controller";

impl SimController {
    pub(crate) fn start(id: DeviceId, events: EventSender) -> Self {
        status(&events, DeviceKind::Controller, &id, NAME, ConnectionState::Connected);
        let _ = events.send(DeviceEvent::Battery {
            kind: DeviceKind::Controller,
            percent: 87,
        });
        Self {
            id,
            events,
            connected: AtomicBool::new(true),
        }
    }
}

#[async_trait]
impl Device for SimController {
    fn id(&self) -> &DeviceId {
        &self.id
    }
    fn name(&self) -> &str {
        NAME
    }
    fn kind(&self) -> DeviceKind {
        DeviceKind::Controller
    }
    async fn disconnect(&self) -> Result<()> {
        if self.connected.swap(false, Ordering::SeqCst) {
            status(
                &self.events,
                DeviceKind::Controller,
                &self.id,
                NAME,
                ConnectionState::Disconnected,
            );
        }
        Ok(())
    }
}

#[async_trait]
impl Controller for SimController {
    /// Emits exactly what a real controller emits for a press.
    async fn inject(&self, button: Button) -> Result<()> {
        if !self.connected.load(Ordering::SeqCst) {
            return Err(DeviceError::NotConnected);
        }
        let _ = self.events.send(DeviceEvent::Button(button));
        if let Some(dir) = shift_for(button) {
            let _ = self.events.send(DeviceEvent::Shift(dir));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wattsup_core::gearing::ShiftDirection;

    #[tokio::test]
    async fn injected_press_becomes_a_shift() {
        let (tx, mut rx) = crate::event_channel();
        let c = SimController::start(DeviceId::new("sim", "controller"), tx);
        assert!(matches!(rx.recv().await, Some(DeviceEvent::Status { .. })));
        assert!(matches!(rx.recv().await, Some(DeviceEvent::Battery { .. })));
        c.inject(Button::ShiftUpRight).await.unwrap();
        assert_eq!(rx.recv().await, Some(DeviceEvent::Button(Button::ShiftUpRight)));
        assert_eq!(rx.recv().await, Some(DeviceEvent::Shift(ShiftDirection::Up)));
        c.disconnect().await.unwrap();
        assert!(c.inject(Button::Minus).await.is_err());
    }
}
