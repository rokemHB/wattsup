//! Fitness Machine Service (FTMS, Bluetooth SIG service 0x1826), indoor bike parts.
//!
//! Field layouts follow the FTMS 1.0 specification, section 4.9 (Indoor Bike
//! Data), 4.16 (Control Point) and 4.17 (Machine Status). All multi-byte
//! fields are little-endian.

use serde::{Deserialize, Serialize};

use super::{ParseError, Reader};

pub const SERVICE: u16 = 0x1826;
pub const FEATURE: u16 = 0x2ACC;
pub const INDOOR_BIKE_DATA: u16 = 0x2AD2;
pub const TRAINING_STATUS: u16 = 0x2AD3;
pub const SUPPORTED_RESISTANCE_LEVEL_RANGE: u16 = 0x2AD6;
pub const SUPPORTED_POWER_RANGE: u16 = 0x2AD8;
pub const CONTROL_POINT: u16 = 0x2AD9;
pub const MACHINE_STATUS: u16 = 0x2ADA;

/// One Indoor Bike Data notification. Fields the trainer did not include are `None`.
///
/// Trainers may split one sample over several notifications (the "More Data"
/// flag), so callers should merge by field rather than replace whole samples.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct IndoorBikeData {
    pub speed_kmh: Option<f64>,
    pub average_speed_kmh: Option<f64>,
    pub cadence_rpm: Option<f64>,
    pub average_cadence_rpm: Option<f64>,
    pub total_distance_m: Option<u32>,
    pub resistance_level: Option<i16>,
    pub power_w: Option<i16>,
    pub average_power_w: Option<i16>,
    pub total_energy_kcal: Option<u16>,
    pub energy_per_hour_kcal: Option<u16>,
    pub energy_per_minute_kcal: Option<u8>,
    pub heart_rate_bpm: Option<u8>,
    pub metabolic_equivalent: Option<f64>,
    pub elapsed_time_s: Option<u16>,
    pub remaining_time_s: Option<u16>,
}

mod flag {
    /// Set means instantaneous speed is NOT in this packet (inverted on purpose by the spec).
    pub const MORE_DATA: u16 = 1 << 0;
    pub const AVERAGE_SPEED: u16 = 1 << 1;
    pub const INSTANTANEOUS_CADENCE: u16 = 1 << 2;
    pub const AVERAGE_CADENCE: u16 = 1 << 3;
    pub const TOTAL_DISTANCE: u16 = 1 << 4;
    pub const RESISTANCE_LEVEL: u16 = 1 << 5;
    pub const INSTANTANEOUS_POWER: u16 = 1 << 6;
    pub const AVERAGE_POWER: u16 = 1 << 7;
    pub const EXPENDED_ENERGY: u16 = 1 << 8;
    pub const HEART_RATE: u16 = 1 << 9;
    pub const METABOLIC_EQUIVALENT: u16 = 1 << 10;
    pub const ELAPSED_TIME: u16 = 1 << 11;
    pub const REMAINING_TIME: u16 = 1 << 12;
}

/// Parses an Indoor Bike Data (0x2AD2) notification.
pub fn parse_indoor_bike_data(bytes: &[u8]) -> Result<IndoorBikeData, ParseError> {
    if bytes.is_empty() {
        return Err(ParseError::Empty);
    }
    let mut r = Reader::new(bytes);
    let flags = r.u16("flags")?;
    let has = |f: u16| flags & f != 0;
    let mut d = IndoorBikeData::default();

    if !has(flag::MORE_DATA) {
        d.speed_kmh = Some(r.u16("instantaneous speed")? as f64 / 100.0);
    }
    if has(flag::AVERAGE_SPEED) {
        d.average_speed_kmh = Some(r.u16("average speed")? as f64 / 100.0);
    }
    if has(flag::INSTANTANEOUS_CADENCE) {
        d.cadence_rpm = Some(r.u16("instantaneous cadence")? as f64 / 2.0);
    }
    if has(flag::AVERAGE_CADENCE) {
        d.average_cadence_rpm = Some(r.u16("average cadence")? as f64 / 2.0);
    }
    if has(flag::TOTAL_DISTANCE) {
        d.total_distance_m = Some(r.u24("total distance")?);
    }
    if has(flag::RESISTANCE_LEVEL) {
        d.resistance_level = Some(r.i16("resistance level")?);
    }
    if has(flag::INSTANTANEOUS_POWER) {
        d.power_w = Some(r.i16("instantaneous power")?);
    }
    if has(flag::AVERAGE_POWER) {
        d.average_power_w = Some(r.i16("average power")?);
    }
    if has(flag::EXPENDED_ENERGY) {
        d.total_energy_kcal = Some(r.u16("total energy")?);
        d.energy_per_hour_kcal = Some(r.u16("energy per hour")?);
        d.energy_per_minute_kcal = Some(r.u8("energy per minute")?);
    }
    if has(flag::HEART_RATE) {
        d.heart_rate_bpm = Some(r.u8("heart rate")?);
    }
    if has(flag::METABOLIC_EQUIVALENT) {
        d.metabolic_equivalent = Some(r.u8("metabolic equivalent")? as f64 / 10.0);
    }
    if has(flag::ELAPSED_TIME) {
        d.elapsed_time_s = Some(r.u16("elapsed time")?);
    }
    if has(flag::REMAINING_TIME) {
        d.remaining_time_s = Some(r.u16("remaining time")?);
    }
    Ok(d)
}

/// Fitness Machine Feature (0x2ACC): two 32-bit bit fields.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Features {
    pub machine: u32,
    pub target_settings: u32,
}

impl Features {
    pub fn cadence_supported(&self) -> bool {
        self.machine & (1 << 1) != 0
    }
    pub fn power_measurement_supported(&self) -> bool {
        self.machine & (1 << 14) != 0
    }
    pub fn resistance_target_supported(&self) -> bool {
        self.target_settings & (1 << 2) != 0
    }
    pub fn power_target_supported(&self) -> bool {
        self.target_settings & (1 << 3) != 0
    }
    pub fn simulation_supported(&self) -> bool {
        self.target_settings & (1 << 13) != 0
    }
}

pub fn parse_features(bytes: &[u8]) -> Result<Features, ParseError> {
    let mut r = Reader::new(bytes);
    Ok(Features {
        machine: r.u32("machine features")?,
        target_settings: r.u32("target setting features")?,
    })
}

/// Supported Power Range (0x2AD8).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PowerRange {
    pub min_w: i16,
    pub max_w: i16,
    pub increment_w: u16,
}

pub fn parse_power_range(bytes: &[u8]) -> Result<PowerRange, ParseError> {
    let mut r = Reader::new(bytes);
    Ok(PowerRange {
        min_w: r.i16("minimum power")?,
        max_w: r.i16("maximum power")?,
        increment_w: r.u16("increment")?,
    })
}

mod opcode {
    pub const REQUEST_CONTROL: u8 = 0x00;
    pub const RESET: u8 = 0x01;
    pub const SET_TARGET_RESISTANCE: u8 = 0x04;
    pub const SET_TARGET_POWER: u8 = 0x05;
    pub const START_OR_RESUME: u8 = 0x07;
    pub const STOP_OR_PAUSE: u8 = 0x08;
    pub const SET_INDOOR_BIKE_SIMULATION: u8 = 0x11;
    pub const RESPONSE_CODE: u8 = 0x80;
}

/// A write to the Fitness Machine Control Point (0x2AD9).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum ControlRequest {
    /// Must be the first write; the trainer ignores others until granted.
    RequestControl,
    Reset,
    /// Unitless resistance level, resolution 0.1.
    SetTargetResistance(f64),
    /// ERG mode: hold this many watts whatever the cadence.
    SetTargetPower(i16),
    StartOrResume,
    Stop,
    Pause,
    /// SIM mode: the trainer models a road with these parameters.
    SetIndoorBikeSimulation {
        wind_mps: f64,
        grade_pct: f64,
        crr: f64,
        cw_kg_per_m: f64,
    },
}

fn scaled_i16(value: f64, scale: f64) -> [u8; 2] {
    ((value * scale).round().clamp(i16::MIN as f64, i16::MAX as f64) as i16).to_le_bytes()
}

fn scaled_u8(value: f64, scale: f64) -> u8 {
    (value * scale).round().clamp(0.0, u8::MAX as f64) as u8
}

impl ControlRequest {
    pub fn encode(&self) -> Vec<u8> {
        match *self {
            ControlRequest::RequestControl => vec![opcode::REQUEST_CONTROL],
            ControlRequest::Reset => vec![opcode::RESET],
            ControlRequest::SetTargetResistance(level) => vec![opcode::SET_TARGET_RESISTANCE, scaled_u8(level, 10.0)],
            ControlRequest::SetTargetPower(w) => {
                let b = w.to_le_bytes();
                vec![opcode::SET_TARGET_POWER, b[0], b[1]]
            }
            ControlRequest::StartOrResume => vec![opcode::START_OR_RESUME],
            ControlRequest::Stop => vec![opcode::STOP_OR_PAUSE, 0x01],
            ControlRequest::Pause => vec![opcode::STOP_OR_PAUSE, 0x02],
            ControlRequest::SetIndoorBikeSimulation {
                wind_mps,
                grade_pct,
                crr,
                cw_kg_per_m,
            } => {
                let w = scaled_i16(wind_mps, 1000.0);
                let g = scaled_i16(grade_pct, 100.0);
                vec![
                    opcode::SET_INDOOR_BIKE_SIMULATION,
                    w[0],
                    w[1],
                    g[0],
                    g[1],
                    scaled_u8(crr, 10_000.0),
                    scaled_u8(cw_kg_per_m, 100.0),
                ]
            }
        }
    }

    pub fn opcode(&self) -> u8 {
        self.encode()[0]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResultCode {
    Success,
    NotSupported,
    InvalidParameter,
    OperationFailed,
    ControlNotPermitted,
    Unknown(u8),
}

impl From<u8> for ResultCode {
    fn from(b: u8) -> Self {
        match b {
            0x01 => ResultCode::Success,
            0x02 => ResultCode::NotSupported,
            0x03 => ResultCode::InvalidParameter,
            0x04 => ResultCode::OperationFailed,
            0x05 => ResultCode::ControlNotPermitted,
            other => ResultCode::Unknown(other),
        }
    }
}

/// The trainer's indication answering a control point write.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlResponse {
    pub request_opcode: u8,
    pub result: ResultCode,
}

pub fn parse_control_response(bytes: &[u8]) -> Result<ControlResponse, ParseError> {
    let mut r = Reader::new(bytes);
    let code = r.u8("response opcode")?;
    if code != opcode::RESPONSE_CODE {
        return Err(ParseError::Unexpected(format!(
            "control point indication starts with {code:#04x}, not 0x80"
        )));
    }
    Ok(ControlResponse {
        request_opcode: r.u8("request opcode")?,
        result: r.u8("result code")?.into(),
    })
}

/// Fitness Machine Status (0x2ADA) notification, reduced to what we act on.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MachineStatus {
    Reset,
    StoppedOrPaused,
    Started,
    TargetPowerChanged(i16),
    SimulationChanged {
        wind_mps: f64,
        grade_pct: f64,
        crr: f64,
        cw_kg_per_m: f64,
    },
    /// Another app took control; we must request it again.
    ControlPermissionLost,
    Other(u8),
}

pub fn parse_machine_status(bytes: &[u8]) -> Result<MachineStatus, ParseError> {
    let mut r = Reader::new(bytes);
    let op = r.u8("status opcode")?;
    Ok(match op {
        0x01 => MachineStatus::Reset,
        0x02 => MachineStatus::StoppedOrPaused,
        0x04 => MachineStatus::Started,
        0x08 => MachineStatus::TargetPowerChanged(r.i16("target power")?),
        0x12 => MachineStatus::SimulationChanged {
            wind_mps: r.i16("wind speed")? as f64 / 1000.0,
            grade_pct: r.i16("grade")? as f64 / 100.0,
            crr: r.u8("crr")? as f64 / 10_000.0,
            cw_kg_per_m: r.u8("cw")? as f64 / 100.0,
        },
        0xFF => MachineStatus::ControlPermissionLost,
        other => MachineStatus::Other(other),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::from_hex;

    // Payloads are built field by field from the FTMS 1.0 tables. Flag
    // layouts match what Wahoo KICKR firmware is reported to send (0x0044:
    // speed + cadence + power, 0x0064: plus resistance level).

    #[test]
    fn kickr_style_speed_cadence_power() {
        // flags 0x0044 | speed 0x0d18 = 3352 → 33.52 km/h | cadence 0x00b4 = 180 → 90 rpm | power 0x00d2 = 210 W
        let d = parse_indoor_bike_data(&from_hex("44 00 18 0d b4 00 d2 00")).unwrap();
        assert_eq!(d.speed_kmh, Some(33.52));
        assert_eq!(d.cadence_rpm, Some(90.0));
        assert_eq!(d.power_w, Some(210));
        assert_eq!(d.resistance_level, None);
        assert_eq!(d.heart_rate_bpm, None);
    }

    #[test]
    fn with_resistance_level() {
        // flags 0x0064 | speed 2500 → 25.00 | cadence 171 → 85.5 rpm | resistance 20 | power 150 W
        let d = parse_indoor_bike_data(&from_hex("64 00 c4 09 ab 00 14 00 96 00")).unwrap();
        assert_eq!(d.speed_kmh, Some(25.0));
        assert_eq!(d.cadence_rpm, Some(85.5));
        assert_eq!(d.resistance_level, Some(20));
        assert_eq!(d.power_w, Some(150));
    }

    #[test]
    fn more_data_flag_means_no_speed() {
        // flags 0x0045: More Data set, so the packet starts with cadence (160 → 80 rpm), then power 0xffec = -20 W.
        let d = parse_indoor_bike_data(&from_hex("45 00 a0 00 ec ff")).unwrap();
        assert_eq!(d.speed_kmh, None);
        assert_eq!(d.cadence_rpm, Some(80.0));
        assert_eq!(d.power_w, Some(-20));
    }

    #[test]
    fn every_field_in_spec_order() {
        // flags 0x1ffe: everything except More Data (so speed is present too).
        let bytes = from_hex(concat!(
            "fe 1f ",    // flags
            "10 27 ",    // speed 10000 → 100.00 km/h
            "88 13 ",    // average speed 5000 → 50.00
            "c8 00 ",    // cadence 200 → 100 rpm
            "b4 00 ",    // average cadence 180 → 90 rpm
            "40 e2 01 ", // distance 0x01e240 = 123456 m
            "05 00 ",    // resistance 5
            "2c 01 ",    // power 300 W
            "fa 00 ",    // average power 250 W
            "64 00 ",    // total energy 100 kcal
            "58 02 ",    // energy/h 600 kcal
            "0a ",       // energy/min 10 kcal
            "8c ",       // heart rate 140
            "55 ",       // MET 85 → 8.5
            "10 0e ",    // elapsed 3600 s
            "2c 01",     // remaining 300 s
        ));
        let d = parse_indoor_bike_data(&bytes).unwrap();
        assert_eq!(d.speed_kmh, Some(100.0));
        assert_eq!(d.average_speed_kmh, Some(50.0));
        assert_eq!(d.cadence_rpm, Some(100.0));
        assert_eq!(d.average_cadence_rpm, Some(90.0));
        assert_eq!(d.total_distance_m, Some(123_456));
        assert_eq!(d.resistance_level, Some(5));
        assert_eq!(d.power_w, Some(300));
        assert_eq!(d.average_power_w, Some(250));
        assert_eq!(d.total_energy_kcal, Some(100));
        assert_eq!(d.energy_per_hour_kcal, Some(600));
        assert_eq!(d.energy_per_minute_kcal, Some(10));
        assert_eq!(d.heart_rate_bpm, Some(140));
        assert_eq!(d.metabolic_equivalent, Some(8.5));
        assert_eq!(d.elapsed_time_s, Some(3600));
        assert_eq!(d.remaining_time_s, Some(300));
    }

    #[test]
    fn truncated_packet_names_the_missing_field() {
        let err = parse_indoor_bike_data(&from_hex("44 00 18 0d b4")).unwrap_err();
        assert_eq!(
            err,
            ParseError::TooShort {
                field: "instantaneous cadence",
                needed: 6,
                got: 5
            }
        );
        assert_eq!(parse_indoor_bike_data(&[]).unwrap_err(), ParseError::Empty);
    }

    #[test]
    fn features_of_a_typical_smart_trainer() {
        // machine 0x00004402: cadence (bit 1), heart rate (bit 10), power measurement (bit 14)
        // target  0x0000200c: resistance (bit 2), power (bit 3), indoor bike simulation (bit 13)
        let f = parse_features(&from_hex("02 44 00 00 0c 20 00 00")).unwrap();
        assert!(f.cadence_supported());
        assert!(f.power_measurement_supported());
        assert!(f.resistance_target_supported());
        assert!(f.power_target_supported());
        assert!(f.simulation_supported());
        let none = parse_features(&from_hex("00 00 00 00 00 00 00 00")).unwrap();
        assert!(!none.simulation_supported());
    }

    #[test]
    fn power_range() {
        // 0 .. 1800 W in 1 W steps
        let r = parse_power_range(&from_hex("00 00 08 07 01 00")).unwrap();
        assert_eq!(
            r,
            PowerRange {
                min_w: 0,
                max_w: 1800,
                increment_w: 1
            }
        );
    }

    #[test]
    fn control_requests_encode_per_spec() {
        assert_eq!(ControlRequest::RequestControl.encode(), from_hex("00"));
        assert_eq!(ControlRequest::Reset.encode(), from_hex("01"));
        assert_eq!(ControlRequest::StartOrResume.encode(), from_hex("07"));
        assert_eq!(ControlRequest::Stop.encode(), from_hex("08 01"));
        assert_eq!(ControlRequest::Pause.encode(), from_hex("08 02"));
        assert_eq!(ControlRequest::SetTargetPower(250).encode(), from_hex("05 fa 00"));
        assert_eq!(ControlRequest::SetTargetPower(-1).encode(), from_hex("05 ff ff"));
        assert_eq!(ControlRequest::SetTargetResistance(4.5).encode(), from_hex("04 2d"));
    }

    #[test]
    fn simulation_parameters_encode_with_spec_resolutions() {
        // wind 0 | grade 5.00% → 500 = 0x01f4 | crr 0.004 → 40 = 0x28 | cw 0.51 → 51 = 0x33
        let req = ControlRequest::SetIndoorBikeSimulation {
            wind_mps: 0.0,
            grade_pct: 5.0,
            crr: 0.004,
            cw_kg_per_m: 0.51,
        };
        assert_eq!(req.encode(), from_hex("11 00 00 f4 01 28 33"));
        // Negative grade -2.5% → -250 = 0xff06; headwind 1.5 m/s → 1500 = 0x05dc
        let req = ControlRequest::SetIndoorBikeSimulation {
            wind_mps: 1.5,
            grade_pct: -2.5,
            crr: 0.0,
            cw_kg_per_m: 0.0,
        };
        assert_eq!(req.encode(), from_hex("11 dc 05 06 ff 00 00"));
        // Out-of-range values clamp instead of wrapping.
        let req = ControlRequest::SetIndoorBikeSimulation {
            wind_mps: 0.0,
            grade_pct: 400.0,
            crr: 1.0,
            cw_kg_per_m: -1.0,
        };
        assert_eq!(req.encode(), from_hex("11 00 00 ff 7f ff 00"));
    }

    #[test]
    fn control_responses() {
        let ok = parse_control_response(&from_hex("80 11 01")).unwrap();
        assert_eq!(
            ok,
            ControlResponse {
                request_opcode: 0x11,
                result: ResultCode::Success
            }
        );
        let denied = parse_control_response(&from_hex("80 05 05")).unwrap();
        assert_eq!(denied.result, ResultCode::ControlNotPermitted);
        assert!(parse_control_response(&from_hex("11 00")).is_err());
    }

    #[test]
    fn machine_status() {
        assert_eq!(
            parse_machine_status(&from_hex("ff")).unwrap(),
            MachineStatus::ControlPermissionLost
        );
        assert_eq!(
            parse_machine_status(&from_hex("08 c8 00")).unwrap(),
            MachineStatus::TargetPowerChanged(200)
        );
        match parse_machine_status(&from_hex("12 00 00 2c 01 28 00")).unwrap() {
            MachineStatus::SimulationChanged { grade_pct, crr, .. } => {
                assert_eq!(grade_pct, 3.0);
                assert_eq!(crr, 0.004);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(parse_machine_status(&from_hex("07")).unwrap(), MachineStatus::Other(7));
    }
}
