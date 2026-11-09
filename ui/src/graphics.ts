// Graphics quality: what a frame may cost. High is the full picture; the lower levels drop
// what costs most per pixel or per draw (shadows, antialiasing, render scale, far trees),
// for a laptop that has to share its GPU or should stay cool on a long ride.

export type Quality = "high" | "balanced" | "performance";

export interface QualityParams {
  shadows: boolean;
  shadowMapSize: number;
  antialias: boolean;
  /** Highest render scale the adaptive resolution may pick. */
  maxPixelRatio: number;
  /** Tree distances (full trees, two-card trees, infill) as a share of the full ones. */
  forest: number;
}

export const QUALITIES: Record<Quality, QualityParams> = {
  high: { shadows: true, shadowMapSize: 1536, antialias: true, maxPixelRatio: 1.5, forest: 1 },
  balanced: { shadows: true, shadowMapSize: 1024, antialias: true, maxPixelRatio: 1.2, forest: 0.75 },
  performance: { shadows: false, shadowMapSize: 1024, antialias: false, maxPixelRatio: 1.0, forest: 0.55 },
};

const KEY = "wattsup.graphics";

function stored(): Quality {
  try {
    const q = localStorage.getItem(KEY);
    return q === "balanced" || q === "performance" ? q : "high";
  } catch {
    return "high";
  }
}

let current: Quality = stored();

export function quality(): Quality {
  return current;
}

export function qualityParams(): QualityParams {
  return QUALITIES[current];
}

export function setQuality(q: Quality) {
  current = q;
  try {
    localStorage.setItem(KEY, q);
  } catch {
    // storage may be unavailable
  }
}
