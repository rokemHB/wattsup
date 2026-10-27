//! Byte-level codecs for the Bluetooth devices WattsUp talks to.
//!
//! Each submodule parses notification payloads into typed values and encodes
//! the writes we send. UUIDs are listed as 16-bit short forms where the
//! Bluetooth SIG assigned one; [`uuid_from_short`] expands them.

pub mod ftms;
pub mod hrs;

use std::fmt;

/// Why a payload could not be decoded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParseError {
    Empty,
    /// Payload ended before a field the flags promised.
    TooShort {
        field: &'static str,
        needed: usize,
        got: usize,
    },
    /// A value or opcode the parser does not know.
    Unexpected(String),
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ParseError::Empty => write!(f, "empty payload"),
            ParseError::TooShort { field, needed, got } => {
                write!(f, "payload too short for {field}: needed {needed} bytes, got {got}")
            }
            ParseError::Unexpected(what) => write!(f, "unexpected payload: {what}"),
        }
    }
}

impl std::error::Error for ParseError {}

/// Expands a 16-bit SIG UUID to its 128-bit string form.
pub fn uuid_from_short(short: u16) -> String {
    format!("0000{short:04x}-0000-1000-8000-00805f9b34fb")
}

/// Little-endian cursor over a payload; every read names its field for errors.
pub(crate) struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn take(&mut self, n: usize, field: &'static str) -> Result<&'a [u8], ParseError> {
        let end = self.pos + n;
        if end > self.bytes.len() {
            return Err(ParseError::TooShort {
                field,
                needed: end,
                got: self.bytes.len(),
            });
        }
        let out = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    pub fn u8(&mut self, field: &'static str) -> Result<u8, ParseError> {
        Ok(self.take(1, field)?[0])
    }

    pub fn u16(&mut self, field: &'static str) -> Result<u16, ParseError> {
        let b = self.take(2, field)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    pub fn i16(&mut self, field: &'static str) -> Result<i16, ParseError> {
        let b = self.take(2, field)?;
        Ok(i16::from_le_bytes([b[0], b[1]]))
    }

    pub fn u24(&mut self, field: &'static str) -> Result<u32, ParseError> {
        let b = self.take(3, field)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], 0]))
    }

    pub fn u32(&mut self, field: &'static str) -> Result<u32, ParseError> {
        let b = self.take(4, field)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn remaining(&self) -> usize {
        self.bytes.len() - self.pos
    }
}

/// Formats bytes as lowercase hex pairs ("44 00 18 0d"), for logs and the debug screen.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
pub(crate) fn from_hex(s: &str) -> Vec<u8> {
    s.split_whitespace()
        .map(|b| u8::from_str_radix(b, 16).expect("hex byte"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_uuid_expands_to_sig_base() {
        assert_eq!(uuid_from_short(0x1826), "00001826-0000-1000-8000-00805f9b34fb");
    }

    #[test]
    fn hex_round_trips() {
        assert_eq!(hex(&from_hex("44 00 ff")), "44 00 ff");
    }
}
