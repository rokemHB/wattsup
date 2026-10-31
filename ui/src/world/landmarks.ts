// Landmarks the terrain data does not carry: the lighthouse at the end of the Formentor
// road, which the plane's flight makes for. Built from primitives, a few draw calls.
import * as THREE from "three";
import type { RoadNetwork } from "./network";

/** The lighthouse on Cap de Formentor, where the Ma-2210 ends. */
const FORMENTOR_LIGHTHOUSE = { lat: 39.9619, lon: 3.2133 };
const EARTH_LAT_M = 110574;
const EARTH_LON_M = 111320;

/**
 * The Formentor lighthouse (1863): a white round tower on a square base, a dark lantern with
 * a gallery, and the keeper's house beside it, standing a little beyond the road's last
 * point the way the road arrives. Null when the network has no such road.
 */
export function formentorLighthouse(net: RoadNetwork, origin: { lat: number; lon: number }): THREE.Group | null {
  // The road end nearest the lighthouse, within 400 m (the island network's frame).
  const lx = (FORMENTOR_LIGHTHOUSE.lon - origin.lon) * EARTH_LON_M * Math.cos((origin.lat * Math.PI) / 180);
  const lz = -(FORMENTOR_LIGHTHOUSE.lat - origin.lat) * EARTH_LAT_M;
  let node = -1;
  let best = 400;
  const degree = new Map<number, number>();
  for (const e of net.edges) for (const n of [e.a, e.b]) degree.set(n, (degree.get(n) ?? 0) + 1);
  net.nodes.forEach((n, i) => {
    const d = Math.hypot(n.x - lx, n.z - lz);
    if (degree.get(i) === 1 && d < best) {
      best = d;
      node = i;
    }
  });
  if (node < 0) return null;
  const edge = net.edges.find((e) => e.a === node || e.b === node);
  if (!edge) return null;
  const end = edge.b === node ? edge.start + edge.count - 1 : edge.start;
  const before = edge.b === node ? end - 4 : end + 4;
  const p = (i: number) => new THREE.Vector3(net.xyz[i * 3], net.xyz[i * 3 + 1], net.xyz[i * 3 + 2]);
  const at = p(end);
  const dir = at.clone().sub(p(before)).setY(0).normalize();
  const g = new THREE.Group();
  g.position.copy(at).addScaledVector(dir, 22);
  g.rotation.y = Math.atan2(dir.x, dir.z);

  const white = new THREE.MeshStandardMaterial({ color: "#f3f1ea", roughness: 0.8 });
  const stone = new THREE.MeshStandardMaterial({ color: "#c9bfa9", roughness: 1 });
  const dark = new THREE.MeshStandardMaterial({ color: "#2c3338", roughness: 0.5, metalness: 0.4 });
  const glass = new THREE.MeshStandardMaterial({ color: "#fff3c2", emissive: "#ffd970", emissiveIntensity: 0.6, roughness: 0.1 });
  const roof = new THREE.MeshStandardMaterial({ color: "#b0603f", roughness: 0.9 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  // A stone platform reaching well down, so the cliff top never shows under it.
  add(new THREE.BoxGeometry(26, 14, 18), stone, 0, -6.5, 0);
  // Keeper's house: two storeys, tiled roof.
  add(new THREE.BoxGeometry(12, 6.5, 9), white, -4, 3.25, 0);
  const r = add(new THREE.ConeGeometry(8.4, 2.6, 4), roof, -4, 7.8, 0);
  r.rotation.y = Math.PI / 4;
  r.scale.set(1, 1, 0.75);
  // Tower: square base, round shaft, gallery, lantern, dome.
  add(new THREE.BoxGeometry(5, 3, 5), white, 6, 1.5, 0);
  add(new THREE.CylinderGeometry(1.9, 2.3, 16, 20), white, 6, 11, 0);
  add(new THREE.CylinderGeometry(2.9, 2.9, 0.4, 20), dark, 6, 19.2, 0);
  add(new THREE.CylinderGeometry(1.6, 1.6, 2.6, 16), glass, 6, 20.7, 0);
  add(new THREE.SphereGeometry(1.75, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), dark, 6, 22, 0);
  return g;
}
