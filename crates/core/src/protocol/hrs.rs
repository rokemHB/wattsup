//! Heart Rate Service (Bluetooth SIG service 0x180D), Heart Rate Measurement characteristic.

use serde::{Deserialize, Serialize};

use super::{ParseError, Reader};

pub const SERVICE: u16 = 0x180D;
pub const MEASUREMENT: u16 = 0x2A37;
pub const BODY_SENSOR_LOCATION: u16 = 0x2A38;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct HeartRateMeasurement {
    pub bpm: u16,
    /// `None` when the strap does not report skin contact at all.
    pub sensor_contact: Option<bool>,
    pub energy_expended_kj: Option<u16>,
    /// Beat-to-beat intervals in milliseconds (sent in 1/1024 s units).
    pub rr_intervals_ms: Vec<f64>,
}

/// Parses a Heart Rate Measurement (0x2A37) notification.
pub fn parse_measurement(bytes: &[u8]) -> Result<HeartRateMeasurement, ParseError> {
    if bytes.is_empty() {
        return Err(ParseError::Empty);
    }
    let mut r = Reader::new(bytes);
    let flags = r.u8("flags")?;
    let bpm = if flags & 0x01 != 0 {
        r.u16("heart rate (16 bit)")?
    } else {
        r.u8("heart rate")? as u16
    };
    // Bits 1-2: 0b10 = supported but no contact, 0b11 = supported and in contact.
    let sensor_contact = match (flags >> 1) & 0b11 {
        0b10 => Some(false),
        0b11 => Some(true),
        _ => None,
    };
    let energy_expended_kj = if flags & 0x08 != 0 {
        Some(r.u16("energy expended")?)
    } else {
        None
    };
    let mut rr_intervals_ms = Vec::new();
    if flags & 0x10 != 0 {
        while r.remaining() >= 2 {
            rr_intervals_ms.push(r.u16("rr interval")? as f64 * 1000.0 / 1024.0);
        }
    }
    Ok(HeartRateMeasurement {
        bpm,
        sensor_contact,
        energy_expended_kj,
        rr_intervals_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::from_hex;

    #[test]
    fn simplest_8_bit_value() {
        // flags 0x00, 72 bpm: what most cheap straps send.
        let m = parse_measurement(&from_hex("00 48")).unwrap();
        assert_eq!(
            m,
            HeartRateMeasurement {
                bpm: 72,
                ..Default::default()
            }
        );
    }

    #[test]
    fn chest_strap_with_contact_and_rr() {
        // flags 0x16 = contact supported + detected (0b110) + RR present (0x10).
        // 0x8c = 140 bpm; RR 0x01b4 = 436/1024 s = 425.8 ms, 0x01b8 = 440/1024 s = 429.7 ms.
        // Polar H10 / Garmin HRM-Dual send this layout.
        let m = parse_measurement(&from_hex("16 8c b4 01 b8 01")).unwrap();
        assert_eq!(m.bpm, 140);
        assert_eq!(m.sensor_contact, Some(true));
        assert_eq!(m.energy_expended_kj, None);
        assert_eq!(m.rr_intervals_ms.len(), 2);
        assert!((m.rr_intervals_ms[0] - 425.78).abs() < 0.01);
        assert!((m.rr_intervals_ms[1] - 429.69).abs() < 0.01);
    }

    #[test]
    fn sixteen_bit_value_with_energy_and_no_contact() {
        // flags 0x0d = 16-bit HR (0x01) + contact supported, not detected (0b100) + energy (0x08)
        // HR 0x00b4 = 180 | energy 0x0123 = 291 kJ
        let m = parse_measurement(&from_hex("0d b4 00 23 01")).unwrap();
        assert_eq!(m.bpm, 180);
        assert_eq!(m.sensor_contact, Some(false));
        assert_eq!(m.energy_expended_kj, Some(291));
        assert!(m.rr_intervals_ms.is_empty());
    }

    #[test]
    fn odd_trailing_byte_is_ignored_and_short_packets_fail() {
        let m = parse_measurement(&from_hex("10 50 00 04 ff")).unwrap();
        assert_eq!(m.rr_intervals_ms, vec![1000.0]);
        assert!(parse_measurement(&from_hex("01 48")).is_err());
        assert_eq!(parse_measurement(&[]).unwrap_err(), ParseError::Empty);
    }
}
