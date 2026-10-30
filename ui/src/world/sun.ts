// Where the sun stands: the NOAA solar position equations (after Meeus, accurate to
// about 0.01° for these years), so the scene's sun agrees with the real one, and with
// the shadows baked into the aerial photos, which are flown around midday.

export interface SunPosition {
  /** Degrees above the horizon. */
  elevation: number;
  /** Degrees clockwise from north. */
  azimuth: number;
}

const rad = Math.PI / 180;

/** The sun seen from `lat`, `lon` (degrees, east positive) at the instant `date`. */
export function sunPosition(lat: number, lon: number, date: Date): SunPosition {
  // Julian century from J2000.0.
  const jd = date.getTime() / 86400000 + 2440587.5;
  const t = (jd - 2451545) / 36525;
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c = Math.sin(m * rad) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * m * rad) * (0.019993 - 0.000101 * t) + Math.sin(3 * m * rad) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(appLong * rad)) / rad;
  const y = Math.tan((eps / 2) * rad) ** 2;
  const eqTime =
    (4 / rad) *
    (y * Math.sin(2 * l0 * rad) - 2 * e * Math.sin(m * rad) + 4 * e * y * Math.sin(m * rad) * Math.cos(2 * l0 * rad) - 0.5 * y * y * Math.sin(4 * l0 * rad) - 1.25 * e * e * Math.sin(2 * m * rad));
  const minutesUtc = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolar = (((minutesUtc + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const hourAngle = trueSolar / 4 < 0 ? trueSolar / 4 + 180 : trueSolar / 4 - 180;
  const cosZenith = Math.sin(lat * rad) * Math.sin(decl * rad) + Math.cos(lat * rad) * Math.cos(decl * rad) * Math.cos(hourAngle * rad);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith))) / rad;
  const azDen = Math.cos(lat * rad) * Math.sin(zenith * rad);
  let azimuth: number;
  if (Math.abs(azDen) > 1e-6) {
    const cosAz = (Math.sin(lat * rad) * Math.cos(zenith * rad) - Math.sin(decl * rad)) / azDen;
    const a = Math.acos(Math.min(1, Math.max(-1, cosAz))) / rad;
    azimuth = hourAngle > 0 ? (a + 180) % 360 : (540 - a) % 360;
  } else {
    azimuth = lat > 0 ? 180 : 0;
  }
  return { elevation: 90 - zenith, azimuth };
}

/** Unit vector toward the sun in the world frame (x east, y up, z south). */
export function sunVector(p: SunPosition): [number, number, number] {
  const el = p.elevation * rad;
  const az = p.azimuth * rad;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
}
