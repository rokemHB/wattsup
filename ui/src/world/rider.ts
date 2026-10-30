// A rider on an aero road bike, built from primitives. Forward is +X in local
// space, the rear contact patch is the origin's ground point.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const WHEEL_R = 0.34;
const TYRE = 0.026;
/** How far the tyre reaches below the hub height minus the wheel radius. */
export const TYRE_BULGE = TYRE;
const CRANK = 0.17;
const BB = new THREE.Vector3(0.02, 0.29, 0); // bottom bracket
const SADDLE = new THREE.Vector3(-0.2, 0.93, 0); // top of the seat post; the hip joint sits ~0.1 m above
const BARS = new THREE.Vector3(0.52, 0.97, 0);
const HIP = new THREE.Vector3(-0.14, 1.03, 0);
const SHOULDER = new THREE.Vector3(0.2, 1.33, 0);
// Road geometry: 0.47 m chain stays, the front hub 0.61 m ahead of the bottom
// bracket and a 73° steering axis with 4 cm of rake. With the hub any closer the
// down tube, the bottle and the head tube cut through the front tyre.
const REAR_HUB = new THREE.Vector3(-0.45, WHEEL_R, 0);
const HEAD_TOP = new THREE.Vector3(0.425, 0.9, 0);
const HEAD_BOTTOM = new THREE.Vector3(0.47, 0.75, 0);
const FRONT_HUB = new THREE.Vector3(HEAD_BOTTOM.x + (HEAD_BOTTOM.y - WHEEL_R) * 0.3 + 0.04, WHEEL_R, 0);
/** The farther hub's distance from the origin, which the bike pitches about. */
export const HALF_WHEELBASE = Math.max(-REAR_HUB.x, FRONT_HUB.x);
/** The seat tube runs from the bottom bracket through the saddle; the sloping top tube meets it here. */
const SEAT_CLUSTER = BB.clone().lerp(SADDLE, (0.8 - BB.y) / (SADDLE.y - BB.y));
/** Dropped seat stays join the seat tube well below the top tube. */
const STAY_JOIN = BB.clone().lerp(SADDLE, (0.68 - BB.y) / (SADDLE.y - BB.y));

const UP = new THREE.Vector3(0, 1, 0);

export class Rider {
  readonly group = new THREE.Group();
  private wheels: THREE.Object3D[] = [];
  private crank = new THREE.Group();
  private pedals: THREE.Group[] = [];
  private legs: { thigh: THREE.Mesh; shin: THREE.Mesh; shoe: THREE.Mesh; side: number }[] = [];
  private crankAngle = 0;
  private wheelAngle = 0;

  constructor(jersey = "#ffc400", accent = "#1b1b22", bike = "#2b7fff") {
    const black = new THREE.MeshStandardMaterial({ color: "#1c1e24", roughness: 0.7 });
    const carbon = new THREE.MeshStandardMaterial({ color: "#15161a", roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide });
    const frame = new THREE.MeshStandardMaterial({ color: bike, roughness: 0.3, metalness: 0.15 });
    const chrome = new THREE.MeshStandardMaterial({ color: "#c9ccd4", roughness: 0.3, metalness: 0.8 });
    const skin = new THREE.MeshStandardMaterial({ color: "#e3a97f", roughness: 0.8 });
    const kit = new THREE.MeshStandardMaterial({ map: jerseyTexture(jersey, accent), roughness: 0.75 });
    const kitPlain = new THREE.MeshStandardMaterial({ color: jersey, roughness: 0.75 });
    const kit2 = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.75 });
    const shorts = new THREE.MeshStandardMaterial({ color: "#1a1a22", roughness: 0.8 });
    const white = new THREE.MeshStandardMaterial({ color: "#f4f4f4", roughness: 0.4 });
    const gloss = new THREE.MeshStandardMaterial({ color: "#f4f4f4", roughness: 0.25, metalness: 0.05 });
    const lens = new THREE.MeshStandardMaterial({ color: "#1a1d2a", roughness: 0.15, metalness: 0.6, side: THREE.DoubleSide });

    /**
     * A tube from `a` to `b`. `section` scales the cross-section: x is the depth
     * in the bike's side plane, z the width across it (an aero tube is deep and
     * narrow). For tubes in the side plane the rotation keeps local z across.
     */
    const tube = (a: THREE.Vector3, b: THREE.Vector3, r = 0.022, mat: THREE.Material = frame, parent: THREE.Object3D = this.group, section: [number, number] = [1, 1]) => {
      const len = a.distanceTo(b);
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
      mesh.position.copy(a).lerp(b, 0.5);
      mesh.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
      mesh.scale.set(section[0], 1, section[1]);
      parent.add(mesh);
      return mesh;
    };
    const ball = (at: THREE.Vector3, r: number, mat: THREE.Material, scale: [number, number, number] = [1, 1, 1], parent: THREE.Object3D = this.group, detail = 10) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, detail, Math.max(6, detail - 2)), mat);
      mesh.position.copy(at);
      mesh.scale.set(...scale);
      parent.add(mesh);
      return mesh;
    };
    const box = (at: THREE.Vector3, size: [number, number, number], mat: THREE.Material, parent: THREE.Object3D = this.group) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
      mesh.position.copy(at);
      parent.add(mesh);
      return mesh;
    };

    // Wheels: deep-section carbon rims, bladed spokes, disc rotors.
    const tyre = new THREE.TorusGeometry(WHEEL_R - 0.004, TYRE, 10, 40);
    const rimOut = WHEEL_R - 0.026;
    const rimIn = WHEEL_R - 0.085;
    const rim = new THREE.LatheGeometry(
      [new THREE.Vector2(rimIn, -0.005), new THREE.Vector2(rimOut - 0.01, -0.012), new THREE.Vector2(rimOut, -0.011), new THREE.Vector2(rimOut, 0.011), new THREE.Vector2(rimOut - 0.01, 0.012), new THREE.Vector2(rimIn, 0.005)],
      40,
    );
    rim.rotateX(Math.PI / 2);
    const hub = new THREE.CylinderGeometry(0.024, 0.024, 0.1, 10);
    hub.rotateX(Math.PI / 2);
    const rotor = new THREE.CylinderGeometry(0.08, 0.08, 0.003, 24);
    rotor.rotateX(Math.PI / 2);
    for (const x of [FRONT_HUB.x, REAR_HUB.x]) {
      const w = new THREE.Group();
      w.add(new THREE.Mesh(tyre, black), new THREE.Mesh(rim, carbon), new THREE.Mesh(hub, carbon));
      const disc = new THREE.Mesh(rotor, chrome);
      disc.position.z = -0.065;
      w.add(disc);
      for (let i = 0; i < 14; i++) {
        const ang = (i / 14) * Math.PI * 2;
        const z = 0.012 * (i % 2 ? 1 : -1);
        const to = new THREE.Vector3(Math.cos(ang) * (rimIn + 0.002), Math.sin(ang) * (rimIn + 0.002), z);
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.0022, rimIn, 0.0045), chrome);
        spoke.position.copy(to).multiplyScalar(0.5).setZ(z);
        spoke.quaternion.setFromUnitVectors(UP, to.clone().setZ(0).normalize());
        w.add(spoke);
      }
      w.position.set(x, WHEEL_R, 0);
      this.wheels.push(w);
      this.group.add(w);
    }
    // Cassette and derailleur on the rear wheel's drive side.
    for (let i = 0; i < 6; i++) {
      const cog = new THREE.Mesh(new THREE.CylinderGeometry(0.052 - i * 0.005, 0.052 - i * 0.005, 0.003, 20), chrome);
      cog.rotation.x = Math.PI / 2;
      cog.position.copy(REAR_HUB).add(new THREE.Vector3(0, 0, 0.05 + i * 0.0045));
      this.group.add(cog);
    }
    box(REAR_HUB.clone().add(new THREE.Vector3(-0.03, -0.06, 0.07)), [0.04, 0.09, 0.025], black);

    // Frame: a kammtail down tube, a sloping top tube, dropped seat stays, a
    // deep head tube and fork, all flattened across the bike.
    const aero: [number, number] = [1.7, 0.75];
    tube(BB, HEAD_BOTTOM.clone().add(new THREE.Vector3(-0.02, 0.05, 0)), 0.024, frame, this.group, aero); // down tube
    tube(SEAT_CLUSTER, HEAD_TOP, 0.018, frame, this.group, [1.4, 0.85]); // top tube
    tube(BB, SEAT_CLUSTER.clone().lerp(SADDLE, 0.15), 0.021, frame, this.group, [1.5, 0.75]); // seat tube
    tube(SEAT_CLUSTER, SADDLE.clone().add(new THREE.Vector3(0.0, 0.0, 0)), 0.014, carbon, this.group, [1.6, 0.8]); // seat post
    tube(HEAD_BOTTOM.clone().add(new THREE.Vector3(0.01, -0.03, 0)), HEAD_TOP.clone().add(new THREE.Vector3(-0.005, 0.03, 0)), 0.026, frame, this.group, [1.4, 0.85]); // head tube
    for (const side of [-1, 1]) {
      tube(STAY_JOIN, REAR_HUB.clone().setZ(0.055 * side), 0.008, frame, this.group, [1.6, 0.8]); // dropped seat stays
      tube(BB.clone().setZ(0.045 * side), REAR_HUB.clone().setZ(0.055 * side), 0.011, frame, this.group, [1.6, 0.7]); // chain stays
      tube(HEAD_BOTTOM.clone().add(new THREE.Vector3(0.0, -0.02, 0.01 * side)), FRONT_HUB.clone().setZ(0.055 * side), 0.012, frame, this.group, [1.5, 0.7]); // fork blades
    }
    // Disc brake calipers inside the fork and the rear triangle, on the left.
    box(FRONT_HUB.clone().add(new THREE.Vector3(-0.03, 0.07, -0.065)), [0.03, 0.06, 0.025], black);
    box(REAR_HUB.clone().add(new THREE.Vector3(0.05, 0.05, -0.065)), [0.05, 0.03, 0.025], black);
    // Integrated bar and stem: one flat stem into a wing-shaped top, hooks below.
    const stemFrom = HEAD_TOP.clone().add(new THREE.Vector3(-0.005, 0.045, 0));
    const stem = box(stemFrom.clone().lerp(BARS, 0.5), [stemFrom.distanceTo(BARS), 0.03, 0.05], carbon);
    stem.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), BARS.clone().sub(stemFrom).normalize());
    tube(BARS.clone().setZ(-0.21), BARS.clone().setZ(0.21), 0.013, carbon, this.group, [2.2, 1]); // wing top
    for (const side of [-1, 1]) {
      const hook = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 6, 12, Math.PI), black);
      hook.position.copy(BARS).add(new THREE.Vector3(0.03, -0.07, 0.21 * side));
      hook.rotation.y = Math.PI / 2;
      hook.rotation.x = Math.PI / 2;
      this.group.add(hook);
      const hood = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.05, 3, 8), black);
      hood.position.copy(BARS).add(new THREE.Vector3(0.08, 0.0, 0.21 * side));
      hood.rotation.z = -1.2;
      this.group.add(hood);
    }
    // Saddle: a flat rear and a narrow nose on short rails.
    const saddleAt = SADDLE.clone().add(new THREE.Vector3(-0.02, 0.035, 0));
    ball(saddleAt.clone().add(new THREE.Vector3(-0.06, 0, 0)), 0.1, black, [0.9, 0.22, 0.7], this.group, 12);
    const nose = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.17, 4, 8), black);
    nose.rotation.z = Math.PI / 2;
    nose.position.copy(saddleAt).add(new THREE.Vector3(0.04, -0.005, 0));
    nose.scale.set(1, 0.6, 1.2);
    this.group.add(nose);
    // A bottle in a cage on the down tube.
    const dtDir = HEAD_BOTTOM.clone().sub(BB).normalize();
    const dtNormal = new THREE.Vector3(-dtDir.y, dtDir.x, 0);
    const bottleAt = BB.clone().add(dtDir.clone().multiplyScalar(0.3)).add(dtNormal.clone().multiplyScalar(0.07));
    const bottle = new THREE.Mesh(new THREE.CapsuleGeometry(0.036, 0.15, 4, 10), kitPlain);
    bottle.position.copy(bottleAt);
    bottle.quaternion.setFromUnitVectors(UP, dtDir);
    this.group.add(bottle);
    tube(bottleAt.clone().add(dtDir.clone().multiplyScalar(0.11)), bottleAt.clone().add(dtDir.clone().multiplyScalar(0.135)), 0.018, black); // cap

    // Cranks, pedals, chainring.
    this.crank.position.copy(BB);
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.03, CRANK, 0.014), carbon);
      arm.position.set(0, (CRANK / 2) * side, 0.085 * side);
      const pedal = new THREE.Group();
      pedal.position.set(0, CRANK * side, 0.12 * side);
      pedal.add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.015, 0.06), black));
      this.crank.add(arm, pedal);
      this.pedals.push(pedal);
    }
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.006, 32), chrome);
    ring.rotation.x = Math.PI / 2;
    ring.position.z = 0.055;
    this.crank.add(ring);
    this.group.add(this.crank);
    tube(BB.clone().add(new THREE.Vector3(0, 0.1, 0.055)), REAR_HUB.clone().add(new THREE.Vector3(0, 0.045, 0.055)), 0.004, black); // chain, top run
    tube(BB.clone().add(new THREE.Vector3(0, -0.1, 0.055)), REAR_HUB.clone().add(new THREE.Vector3(-0.02, -0.08, 0.055)), 0.004, black); // chain, bottom run

    // Rider body: pelvis, torso leaning to the bars, head, arms with elbows.
    ball(HIP.clone().add(new THREE.Vector3(0.02, 0.04, 0)), 0.13, shorts, [0.9, 0.72, 1.15]); // pelvis, its underside just meets the saddle
    const torsoDir = SHOULDER.clone().sub(HIP);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.135, torsoDir.length() - 0.1, 6, 14), kit);
    torso.position.copy(HIP).lerp(SHOULDER, 0.52);
    torso.quaternion.setFromUnitVectors(UP, torsoDir.clone().normalize());
    torso.scale.set(1, 1, 1.25);
    this.group.add(torso);
    // Rear pockets: three small bulges low on the back.
    for (const z of [-0.075, 0, 0.075]) {
      const p = ball(HIP.clone().lerp(SHOULDER, 0.28).add(new THREE.Vector3(-0.1, 0.05, z)), 0.045, kitPlain, [0.5, 1.1, 0.8], this.group, 8);
      p.quaternion.copy(torso.quaternion);
    }
    // Collar and a zip line down the chest.
    const neckBase = SHOULDER.clone().add(new THREE.Vector3(0.03, 0.03, 0));
    tube(neckBase.clone().add(new THREE.Vector3(-0.02, -0.03, 0)), neckBase.clone().add(new THREE.Vector3(0.015, 0.01, 0)), 0.065, kit2);
    tube(SHOULDER, SHOULDER.clone().add(new THREE.Vector3(0.12, 0.08, 0)), 0.045, skin); // neck
    const zipTop = HIP.clone().lerp(SHOULDER, 0.9).add(new THREE.Vector3(0.12, -0.08, 0));
    const zipBottom = HIP.clone().lerp(SHOULDER, 0.15).add(new THREE.Vector3(0.14, -0.04, 0));
    tube(zipBottom, zipTop, 0.006, white);

    // Head: skin, sunglasses, nose, ears, a vented aero helmet with a chin strap.
    const head = new THREE.Group();
    head.position.copy(SHOULDER).add(new THREE.Vector3(0.2, 0.1, 0));
    head.rotation.z = -0.12;
    this.group.add(head);
    const O = new THREE.Vector3();
    ball(O, 0.11, skin, [1, 1.05, 0.95], head, 16);
    ball(new THREE.Vector3(0.108, -0.02, 0), 0.017, skin, [1.3, 0.9, 0.8], head, 8); // nose
    box(new THREE.Vector3(0.098, -0.06, 0), [0.012, 0.006, 0.04], shorts, head); // mouth
    for (const side of [-1, 1]) {
      ball(new THREE.Vector3(-0.01, -0.005, 0.103 * side), 0.022, skin, [0.6, 1, 0.5], head, 8); // ear
      tube(new THREE.Vector3(0.0, 0.0, 0.1 * side), new THREE.Vector3(0.085, 0.015, 0.09 * side), 0.004, black, head); // glasses arm
      tube(new THREE.Vector3(-0.02, 0.0, 0.1 * side), new THREE.Vector3(0.02, -0.11, 0.025 * side), 0.004, black, head); // chin strap
    }
    const shades = new THREE.Mesh(new THREE.CylinderGeometry(0.108, 0.108, 0.028, 14, 1, true, Math.PI / 2 - 0.95, 1.9), lens);
    shades.position.set(0.0, 0.02, 0);
    head.add(shades);
    const helmet = new THREE.Group();
    helmet.position.set(-0.005, 0.02, 0);
    helmet.rotation.z = -0.2;
    head.add(helmet);
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.128, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.58), gloss);
    shell.scale.set(1.28, 0.98, 1.06);
    helmet.add(shell);
    ball(new THREE.Vector3(-0.1, 0.0, 0), 0.07, kit2, [1.2, 0.55, 0.8], helmet, 10); // tail
    const band = new THREE.Mesh(new THREE.SphereGeometry(0.129, 18, 4, 0, Math.PI * 2, Math.PI * 0.36, Math.PI * 0.07), kit2); // accent stripe round the shell
    band.scale.set(1.285, 0.98, 1.065);
    helmet.add(band);
    for (const z of [-0.07, -0.035, 0.035, 0.07]) {
      // Vents: dark grooves over the crown, following its curve.
      const vent = box(new THREE.Vector3(0.01, 0.122 * Math.cos(Math.asin(z / 0.135)), z), [0.11, 0.02, 0.011], black, helmet);
      vent.rotation.x = Math.asin(z / 0.135);
    }

    // Arms: a sleeve in the jersey colour with an accent cuff, forearms in skin, gloves.
    for (const side of [-1, 1]) {
      const sh = SHOULDER.clone().setZ(0.17 * side);
      const hand = BARS.clone().add(new THREE.Vector3(0.08, 0.01, 0.21 * side));
      const elbow = bend(sh, hand, 0.3, 0.28, new THREE.Vector3(0.1, -1, 0.3 * side));
      tube(sh, elbow, 0.045, kitPlain);
      tube(sh.clone().lerp(elbow, 0.78), elbow, 0.047, kit2); // cuff
      tube(elbow, hand, 0.035, skin);
      const glove = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), black);
      glove.position.copy(hand);
      this.group.add(glove);
      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.36, 4, 10), shorts);
      const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.38, 4, 10), skin);
      // The sock rides with the shin: a white band just above the ankle.
      const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.05, 0.09, 10), white);
      sock.position.y = -0.17;
      shin.add(sock);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.08), white);
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.012, 0.085), black);
      sole.position.y = -0.03;
      const toe = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), white);
      toe.position.set(0.11, 0, 0);
      toe.scale.set(1, 0.75, 1);
      shoe.add(sole, toe);
      this.group.add(thigh, shin, shoe);
      this.legs.push({ thigh, shin, shoe, side });
    }
    // Everything that does not move on its own becomes one mesh per material:
    // the frame, body and wheels were a hundred draw calls, twice over with shadows.
    const moving = new Set<THREE.Object3D>([...this.wheels, this.crank, ...this.pedals, ...this.legs.flatMap((l) => [l.thigh, l.shin, l.shoe])]);
    mergeStatic(head, new Set());
    mergeStatic(helmet, new Set());
    mergeStatic(this.group, moving);
    for (const w of this.wheels) mergeStatic(w, new Set());
    mergeStatic(this.crank, new Set(this.pedals));
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
  }

  /** Advances the animation: cadence in rpm, ground speed in m/s. */
  animate(cadenceRpm: number, speedMps: number, dt: number) {
    this.crankAngle += (cadenceRpm / 60) * Math.PI * 2 * dt;
    this.wheelAngle += (speedMps / WHEEL_R) * dt;
    this.crank.rotation.z = -this.crankAngle;
    for (const p of this.pedals) p.rotation.z = this.crankAngle;
    for (const w of this.wheels) w.rotation.z = -this.wheelAngle;

    for (const { thigh, shin, shoe, side } of this.legs) {
      const a = this.crankAngle + (side > 0 ? 0 : Math.PI);
      const foot = new THREE.Vector3(BB.x + Math.sin(a) * CRANK + 0.03, BB.y + Math.cos(a) * CRANK + 0.04, 0.13 * side);
      const hip = HIP.clone().setZ(0.09 * side);
      const knee = bend(hip, foot, 0.44, 0.44, new THREE.Vector3(1, 0.15, 0.25 * side));
      place(thigh, hip, knee);
      place(shin, knee, foot);
      shoe.position.copy(foot).add(new THREE.Vector3(0.04, -0.02, 0));
      shoe.rotation.z = Math.sin(a) * 0.25;
    }
  }
}

/** The jersey: its colour with an accent band over the chest and a white stripe under it. v runs hip → shoulders. */
function jerseyTexture(jersey: string, accent: string): THREE.CanvasTexture {
  const w = 64;
  const h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = jersey;
  ctx.fillRect(0, 0, w, h);
  // Canvas y runs top → bottom, so v = 1 is row 0.
  const band = (v0: number, v1: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, Math.round((1 - v1) * h), w, Math.round((v1 - v0) * h));
  };
  band(0.76, 0.93, accent);
  band(0.73, 0.75, "#f4f4f4");
  band(0.0, 0.06, accent);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Replaces `parent`'s direct child meshes (except `keep` and non-meshes) by one merged mesh per material. */
function mergeStatic(parent: THREE.Object3D, keep: Set<THREE.Object3D>) {
  const byMat = new Map<THREE.Material, THREE.Mesh[]>();
  for (const o of parent.children) {
    if (!(o instanceof THREE.Mesh) || keep.has(o)) continue;
    const mat = o.material as THREE.Material;
    if (!byMat.has(mat)) byMat.set(mat, []);
    byMat.get(mat)!.push(o);
  }
  for (const [mat, meshes] of byMat) {
    if (meshes.length < 2) continue;
    const geos = meshes.map((m) => {
      m.updateMatrix();
      return m.geometry.clone().applyMatrix4(m.matrix);
    });
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    for (const m of meshes) {
      parent.remove(m);
      m.geometry.dispose();
    }
    parent.add(new THREE.Mesh(merged, mat));
  }
}

/** Middle joint of a two-bone chain from `a` to `b`, bent toward `hint`. */
function bend(a: THREE.Vector3, b: THREE.Vector3, l1: number, l2: number, hint: THREE.Vector3): THREE.Vector3 {
  const d = Math.min(a.distanceTo(b), l1 + l2 - 0.005);
  const dir = b.clone().sub(a).normalize();
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const ang = Math.acos(cosA);
  const perp = hint.clone().sub(dir.clone().multiplyScalar(hint.dot(dir))).normalize();
  return a.clone().add(dir.multiplyScalar(Math.cos(ang) * l1)).add(perp.multiplyScalar(Math.sin(ang) * l1));
}

function place(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
  m.position.copy(a).lerp(b, 0.5);
  m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
}
