//! Zwift Click / Click v2 / Play / Ride controllers ("Zwift Accessory Protocol").
//!
//! Proprietary and only partly reverse-engineered. This follows the open
//! implementations in BikeControl (github.com/OpenBikeControl/bikecontrol,
//! formerly doudar/swiftcontrol: `lib/bluetooth/devices/zwift/`) and
//! qdomyos-zwift (`src/zwift_play/abstractZapDevice.h`):
//!
//! 1. Subscribe to Async (notify) and Sync TX (indicate).
//! 2. Write "RideOn" to Sync RX (write without response). Click v2 also gets
//!    `FF 04 00` afterwards.
//! 3. Every notification is `[message type][protobuf body]`. Button bits are
//!    inverted: a cleared bit means "pressed".
//!
//! Click v2 caveat (from BikeControl's troubleshooting guide): unless the
//! official Zwift app connected to it recently, it stops sending buttons
//! about a minute after connecting, and must be reconnected. It then sends
//! `FF 05 00 EA 05` or `FF 05 00 FA 05`, decoded here as [`ZwiftMessage::Stopped`].

use serde::{Deserialize, Serialize};

use super::ParseError;
use crate::gearing::ShiftDirection;

pub const SERVICE_UUID: &str = "00000001-19ca-4651-86e5-fa29dcdd09d1";
/// Newer firmware (Ride, Click v2) advertises this 16-bit service instead.
pub const RIDE_SERVICE_SHORT: u16 = 0xFC82;
pub const ASYNC_UUID: &str = "00000002-19ca-4651-86e5-fa29dcdd09d1";
pub const SYNC_RX_UUID: &str = "00000003-19ca-4651-86e5-fa29dcdd09d1";
pub const SYNC_TX_UUID: &str = "00000004-19ca-4651-86e5-fa29dcdd09d1";
/// Bluetooth company ID of Zwift, Inc. in advertisement manufacturer data.
pub const MANUFACTURER_ID: u16 = 0x094A;

pub const RIDE_ON: [u8; 6] = *b"RideOn";
/// Extra start command BikeControl sends to a Click v2 after the handshake.
pub const CLICK_V2_START: [u8; 3] = [0xFF, 0x04, 0x00];

mod msg {
    pub const EMPTY: u8 = 0x15;
    pub const BATTERY: u8 = 0x19;
    pub const RIDE_NOTIFICATION: u8 = 0x23;
    pub const CLICK_NOTIFICATION: u8 = 0x37;
    /// Click v2 status frames (`FF 05 ...`); 0x07 (Play) and 0x3C are not decoded.
    pub const STATUS: u8 = 0xFF;
}

/// Which controller a device is, from the first byte of its manufacturer data.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ZwiftDeviceType {
    Click,
    ClickV2Right,
    ClickV2Left,
    PlayLeft,
    PlayRight,
    RideLeft,
    RideRight,
}

impl ZwiftDeviceType {
    pub fn from_manufacturer_data(data: &[u8]) -> Option<Self> {
        Some(match *data.first()? {
            0x09 => Self::Click,
            0x0A => Self::ClickV2Right,
            0x0B => Self::ClickV2Left,
            0x03 => Self::PlayLeft,
            0x02 => Self::PlayRight,
            0x08 => Self::RideLeft,
            0x07 => Self::RideRight,
            _ => return None,
        })
    }

    pub fn is_click_v2(&self) -> bool {
        matches!(self, Self::ClickV2Left | Self::ClickV2Right)
    }
}

/// Writes that start a session, in order, for the given device type.
pub fn handshake(device: Option<ZwiftDeviceType>) -> Vec<Vec<u8>> {
    let mut writes = vec![RIDE_ON.to_vec()];
    if device.is_some_and(|d| d.is_click_v2()) {
        writes.push(CLICK_V2_START.to_vec());
    }
    writes
}

/// Controller buttons, named after the Zwift Ride layout (Click v2 reuses it).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Button {
    NavLeft,
    NavUp,
    NavRight,
    NavDown,
    A,
    B,
    Y,
    Z,
    ShiftUpLeft,
    ShiftDownLeft,
    PowerUpLeft,
    OnOffLeft,
    ShiftUpRight,
    ShiftDownRight,
    PowerUpRight,
    OnOffRight,
    /// Click (v1) "+" and "−" buttons.
    Plus,
    Minus,
    /// Ride analog paddles pushed past the threshold.
    PaddleLeft,
    PaddleRight,
}

/// Button bits of `RideKeyPadStatus.buttonMap` (cleared = pressed).
const RIDE_BUTTON_MASKS: [(u32, Button); 16] = [
    (0x00001, Button::NavLeft),
    (0x00002, Button::NavUp),
    (0x00004, Button::NavRight),
    (0x00008, Button::NavDown),
    (0x00010, Button::A),
    (0x00020, Button::B),
    (0x00040, Button::Y),
    (0x00080, Button::Z),
    (0x00100, Button::ShiftUpLeft),
    (0x00200, Button::ShiftDownLeft),
    (0x00400, Button::PowerUpLeft),
    (0x00800, Button::OnOffLeft),
    (0x01000, Button::ShiftUpRight),
    (0x02000, Button::ShiftDownRight),
    (0x04000, Button::PowerUpRight),
    (0x08000, Button::OnOffRight),
];

/// Analog paddle values (−100..100) at or beyond this count as a press (BikeControl uses 25).
pub const ANALOG_PADDLE_THRESHOLD: i32 = 25;

/// The set of buttons held down in one notification.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Buttons(Vec<Button>);

impl Buttons {
    pub fn pressed(&self) -> &[Button] {
        &self.0
    }
    pub fn contains(&self, b: Button) -> bool {
        self.0.contains(&b)
    }
    fn push(&mut self, b: Button) {
        if !self.0.contains(&b) {
            self.0.push(b);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandshakeVariant {
    Click,
    Play,
    ClickV2,
    /// Plain "RideOn" echo (Ride, or Click v2 in unencrypted mode).
    Plain,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ZwiftMessage {
    Handshake {
        variant: HandshakeVariant,
        public_key: Vec<u8>,
    },
    Buttons(Buttons),
    Battery(u8),
    /// Keep-alive with nothing in it, sent constantly while idle.
    Empty,
    /// Click v2 stopped sending buttons (it was not unlocked by the Zwift app).
    Stopped,
    Other {
        kind: u8,
        body: Vec<u8>,
    },
}

/// Decodes one notification or indication from either Zwift characteristic.
pub fn parse_message(bytes: &[u8]) -> Result<ZwiftMessage, ParseError> {
    let (&kind, body) = bytes.split_first().ok_or(ParseError::Empty)?;
    if bytes.starts_with(&RIDE_ON) {
        let rest = &bytes[RIDE_ON.len()..];
        let (variant, key) = match rest {
            [0x01, 0x03, key @ ..] => (HandshakeVariant::Click, key),
            [0x01, 0x04, key @ ..] => (HandshakeVariant::Play, key),
            [0x02, 0x03, key @ ..] => (HandshakeVariant::ClickV2, key),
            _ => (HandshakeVariant::Plain, rest),
        };
        return Ok(ZwiftMessage::Handshake {
            variant,
            public_key: key.to_vec(),
        });
    }
    Ok(match kind {
        msg::EMPTY => ZwiftMessage::Empty,
        msg::BATTERY => {
            let fields = decode_fields(body)?;
            let level = field_varint(&fields, 1).unwrap_or(0).min(100) as u8;
            ZwiftMessage::Battery(level)
        }
        msg::CLICK_NOTIFICATION => ZwiftMessage::Buttons(parse_click_buttons(body)?),
        msg::RIDE_NOTIFICATION => ZwiftMessage::Buttons(parse_ride_buttons(body)?),
        msg::STATUS if matches!(body, [0x05, 0x00, 0xEA | 0xFA, 0x05]) => ZwiftMessage::Stopped,
        _ => ZwiftMessage::Other {
            kind,
            body: body.to_vec(),
        },
    })
}

/// Click v1 `ClickKeyPadStatus`: field 1 = plus, field 2 = minus; 0 = pressed.
fn parse_click_buttons(body: &[u8]) -> Result<Buttons, ParseError> {
    let fields = decode_fields(body)?;
    let mut b = Buttons::default();
    if field_varint(&fields, 1) == Some(0) {
        b.push(Button::Plus);
    }
    if field_varint(&fields, 2) == Some(0) {
        b.push(Button::Minus);
    }
    Ok(b)
}

/// Ride / Click v2 `RideKeyPadStatus`: field 1 = inverted button bit map,
/// field 3 (repeated) = analog paddles `{1: location, 2: sint32 value}`.
fn parse_ride_buttons(body: &[u8]) -> Result<Buttons, ParseError> {
    let fields = decode_fields(body)?;
    let map = field_varint(&fields, 1)
        .ok_or_else(|| ParseError::Unexpected("ride notification without button map".into()))? as u32;
    let mut b = Buttons::default();
    for (mask, button) in RIDE_BUTTON_MASKS {
        if map & mask == 0 {
            b.push(button);
        }
    }
    for f in &fields {
        if let (2 | 3, Field::Bytes(group)) = (f.number, &f.value) {
            let inner = decode_fields(group)?;
            let location = field_varint(&inner, 1).unwrap_or(0);
            let value = field_varint(&inner, 2).map(zigzag).unwrap_or(0);
            if value.abs() >= ANALOG_PADDLE_THRESHOLD {
                match location {
                    0 => b.push(Button::PaddleLeft),
                    1 => b.push(Button::PaddleRight),
                    _ => {}
                }
            }
        }
    }
    Ok(b)
}

/// What a button press means for gearing. Right side and "+" shift harder.
pub fn shift_for(button: Button) -> Option<ShiftDirection> {
    match button {
        Button::ShiftUpRight | Button::ShiftDownRight | Button::PaddleRight | Button::Plus => Some(ShiftDirection::Up),
        Button::ShiftUpLeft | Button::ShiftDownLeft | Button::PaddleLeft | Button::Minus => Some(ShiftDirection::Down),
        _ => None,
    }
}

/// Turns the stream of "buttons held" frames into one event per new press.
///
/// Controllers repeat the same frame while a button is held and send an
/// all-released frame afterwards, so only rising edges count.
#[derive(Debug, Default)]
pub struct ButtonEdges {
    held: Buttons,
}

impl ButtonEdges {
    /// Returns buttons pressed in `now` that were not held in the previous frame.
    pub fn update(&mut self, now: Buttons) -> Vec<Button> {
        let fresh = now
            .pressed()
            .iter()
            .copied()
            .filter(|b| !self.held.contains(*b))
            .collect();
        self.held = now;
        fresh
    }
}

// --- minimal protobuf reader -------------------------------------------------

#[derive(Debug, PartialEq)]
enum Field<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    Fixed,
}

#[derive(Debug)]
struct ProtoField<'a> {
    number: u64,
    value: Field<'a>,
}

fn read_varint(bytes: &[u8], pos: &mut usize) -> Result<u64, ParseError> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let b = *bytes.get(*pos).ok_or(ParseError::TooShort {
            field: "varint",
            needed: *pos + 1,
            got: bytes.len(),
        })?;
        *pos += 1;
        value |= ((b & 0x7F) as u64) << shift;
        if b & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(ParseError::Unexpected("varint longer than 10 bytes".into()))
}

fn decode_fields(bytes: &[u8]) -> Result<Vec<ProtoField<'_>>, ParseError> {
    let mut pos = 0;
    let mut out = Vec::new();
    while pos < bytes.len() {
        let tag = read_varint(bytes, &mut pos)?;
        let number = tag >> 3;
        let value = match tag & 0x7 {
            0 => Field::Varint(read_varint(bytes, &mut pos)?),
            2 => {
                let len = read_varint(bytes, &mut pos)? as usize;
                let end = pos + len;
                if end > bytes.len() {
                    return Err(ParseError::TooShort {
                        field: "protobuf bytes",
                        needed: end,
                        got: bytes.len(),
                    });
                }
                let v = &bytes[pos..end];
                pos = end;
                Field::Bytes(v)
            }
            1 => {
                pos += 8;
                Field::Fixed
            }
            5 => {
                pos += 4;
                Field::Fixed
            }
            w => return Err(ParseError::Unexpected(format!("protobuf wire type {w}"))),
        };
        if pos > bytes.len() {
            return Err(ParseError::TooShort {
                field: "protobuf fixed",
                needed: pos,
                got: bytes.len(),
            });
        }
        out.push(ProtoField { number, value });
    }
    Ok(out)
}

fn field_varint(fields: &[ProtoField<'_>], number: u64) -> Option<u64> {
    fields.iter().find_map(|f| match f.value {
        Field::Varint(v) if f.number == number => Some(v),
        _ => None,
    })
}

fn zigzag(v: u64) -> i32 {
    ((v >> 1) as i64 ^ -((v & 1) as i64)) as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::from_hex;

    fn buttons(bytes: &str) -> Vec<Button> {
        match parse_message(&from_hex(bytes)).unwrap() {
            ZwiftMessage::Buttons(b) => b.pressed().to_vec(),
            other => panic!("expected buttons, got {other:?}"),
        }
    }

    #[test]
    fn device_type_from_manufacturer_data() {
        assert_eq!(
            ZwiftDeviceType::from_manufacturer_data(&[0x09]),
            Some(ZwiftDeviceType::Click)
        );
        assert_eq!(
            ZwiftDeviceType::from_manufacturer_data(&[0x0A, 0x11]),
            Some(ZwiftDeviceType::ClickV2Right)
        );
        assert_eq!(
            ZwiftDeviceType::from_manufacturer_data(&[0x0B]),
            Some(ZwiftDeviceType::ClickV2Left)
        );
        assert_eq!(ZwiftDeviceType::from_manufacturer_data(&[0x42]), None);
        assert_eq!(ZwiftDeviceType::from_manufacturer_data(&[]), None);
    }

    #[test]
    fn handshake_writes() {
        assert_eq!(
            handshake(Some(ZwiftDeviceType::Click)),
            vec![from_hex("52 69 64 65 4f 6e")]
        );
        assert_eq!(
            handshake(Some(ZwiftDeviceType::ClickV2Left)),
            vec![from_hex("52 69 64 65 4f 6e"), from_hex("ff 04 00")]
        );
    }

    #[test]
    fn handshake_responses() {
        let mut click = from_hex("52 69 64 65 4f 6e 01 03");
        click.extend([0xAB; 32]);
        match parse_message(&click).unwrap() {
            ZwiftMessage::Handshake { variant, public_key } => {
                assert_eq!(variant, HandshakeVariant::Click);
                assert_eq!(public_key, vec![0xAB; 32]);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            parse_message(&from_hex("52 69 64 65 4f 6e 02 03")).unwrap(),
            ZwiftMessage::Handshake {
                variant: HandshakeVariant::ClickV2,
                public_key: vec![]
            }
        );
        assert_eq!(
            parse_message(&from_hex("52 69 64 65 4f 6e")).unwrap(),
            ZwiftMessage::Handshake {
                variant: HandshakeVariant::Plain,
                public_key: vec![]
            }
        );
    }

    #[test]
    fn click_v1_plus_and_minus() {
        // qdomyos-zwift checks exactly this 5-byte layout: byte 2 = plus, byte 4 = minus, 0 = pressed.
        assert_eq!(buttons("37 08 00 10 01"), vec![Button::Plus]);
        assert_eq!(buttons("37 08 01 10 00"), vec![Button::Minus]);
        assert_eq!(buttons("37 08 01 10 01"), vec![]);
    }

    #[test]
    fn ride_and_click_v2_shift_buttons() {
        // All 18 button bits released: 0x3ffff = varint ff ff 0f.
        assert_eq!(buttons("23 08 ff ff 0f"), vec![]);
        // qdomyos-zwift: "bytes[3] == 0xdf: right top button", "0xbf: right bottom",
        // "0xfd: left top", "0xfb: left bottom" - the second varint byte carries bits 7-13.
        assert_eq!(buttons("23 08 ff df 0f"), vec![Button::ShiftUpRight]);
        assert_eq!(buttons("23 08 ff bf 0f"), vec![Button::ShiftDownRight]);
        assert_eq!(buttons("23 08 ff fd 0f"), vec![Button::ShiftUpLeft]);
        assert_eq!(buttons("23 08 ff fb 0f"), vec![Button::ShiftDownLeft]);
        // A full 32-bit map (0xffffffff, 5-byte varint) with A (0x10) pressed.
        assert_eq!(buttons("23 08 ef ff ff ff 0f"), vec![Button::A]);
    }

    #[test]
    fn ride_analog_paddles() {
        // map all released, then field 3 groups: {location L1, value zigzag(-100) = 199 = c7 01}
        // and {location L0, value 10} (below the threshold).
        let b = buttons("23 08 ff ff 0f 1a 05 08 01 10 c7 01 1a 04 08 00 10 14");
        assert_eq!(b, vec![Button::PaddleRight]);
    }

    #[test]
    fn battery_empty_and_stopped() {
        assert_eq!(parse_message(&from_hex("19 08 4b")).unwrap(), ZwiftMessage::Battery(75));
        assert_eq!(parse_message(&from_hex("15")).unwrap(), ZwiftMessage::Empty);
        assert_eq!(
            parse_message(&from_hex("ff 05 00 ea 05")).unwrap(),
            ZwiftMessage::Stopped
        );
        assert_eq!(
            parse_message(&from_hex("ff 05 00 fa 05")).unwrap(),
            ZwiftMessage::Stopped
        );
        assert!(matches!(
            parse_message(&from_hex("3c 08 01")).unwrap(),
            ZwiftMessage::Other { kind: 0x3c, .. }
        ));
        assert_eq!(parse_message(&[]).unwrap_err(), ParseError::Empty);
    }

    #[test]
    fn broken_protobuf_is_an_error_not_a_panic() {
        assert!(parse_message(&from_hex("23 08 ff")).is_err());
        assert!(parse_message(&from_hex("23 1a 09 08")).is_err());
        assert!(parse_message(&from_hex("23 10 01")).is_err(), "no button map");
    }

    #[test]
    fn edges_fire_once_per_press() {
        let mut edges = ButtonEdges::default();
        let frame = |s: &str| match parse_message(&from_hex(s)).unwrap() {
            ZwiftMessage::Buttons(b) => b,
            _ => unreachable!(),
        };
        assert_eq!(edges.update(frame("23 08 ff df 0f")), vec![Button::ShiftUpRight]);
        assert_eq!(edges.update(frame("23 08 ff df 0f")), vec![], "repeated while held");
        assert_eq!(edges.update(frame("23 08 ff ff 0f")), vec![]);
        assert_eq!(edges.update(frame("23 08 ff df 0f")), vec![Button::ShiftUpRight]);
    }

    #[test]
    fn shift_mapping() {
        assert_eq!(shift_for(Button::ShiftUpRight), Some(ShiftDirection::Up));
        assert_eq!(shift_for(Button::Plus), Some(ShiftDirection::Up));
        assert_eq!(shift_for(Button::ShiftUpLeft), Some(ShiftDirection::Down));
        assert_eq!(shift_for(Button::Minus), Some(ShiftDirection::Down));
        assert_eq!(shift_for(Button::A), None);
    }
}
