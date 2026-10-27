// A rider on a road bike, built from primitives. Forward is +X in local space,
// the rear contact patch is the origin's ground point.
import * as THREE from "three";

const WHEEL_R = 0.34;
const TYRE = 0.024;
/** How far the tyre reaches below the hub height minus the wheel radius. */
export const TYRE_BULGE = TYRE;
const CRANK = 0.17;
const BB = new THREE.Vector3(0.02, 0.29, 0); // bottom bracket
const SADDLE = new THREE.Vector3(-0.2, 1.0, 0);
const BARS = new THREE.Vector3(0.48, 0.98, 0);
const HIP = new THREE.Vector3(-0.14, 1.03, 0);
const SHOULDER = new THREE.Vector3(0.2, 1.33, 0);

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
    const frame = new THREE.MeshStandardMaterial({ color: bike, roughness: 0.35, metalness: 0.2 });
    const chrome = new THREE.MeshStandardMaterial({ color: "#c9ccd4", roughness: 0.3, metalness: 0.8 });
    const skin = new THREE.MeshStandardMaterial({ color: "#e3a97f", roughness: 0.8 });
    const kit = new THREE.MeshStandardMaterial({ color: jersey, roughness: 0.75 });
    const kit2 = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.75 });
    const shorts = new THREE.MeshStandardMaterial({ color: "#1a1a22", roughness: 0.8 });
    const white = new THREE.MeshStandardMaterial({ color: "#f4f4f4", roughness: 0.4 });

    const tube = (a: THREE.Vector3, b: THREE.Vector3, r = 0.022, mat = frame, parent: THREE.Object3D = this.group) => {
      const len = a.distanceTo(b);
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), mat);
      mesh.position.copy(a).lerp(b, 0.5);
      mesh.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
      parent.add(mesh);
      return mesh;
    };

    // Wheels with spokes.
    const tyre = new THREE.TorusGeometry(WHEEL_R, TYRE, 10, 36);
    const rimGeo = new THREE.TorusGeometry(WHEEL_R - 0.028, 0.012, 6, 36);
    const hub = new THREE.CylinderGeometry(0.03, 0.03, 0.1, 8);
    hub.rotateX(Math.PI / 2);
    for (const x of [0.5, -0.5]) {
      const w = new THREE.Group();
      w.add(new THREE.Mesh(tyre, black), new THREE.Mesh(rimGeo, chrome), new THREE.Mesh(hub, chrome));
      for (let i = 0; i < 16; i++) {
        const ang = (i / 16) * Math.PI * 2;
        const to = new THREE.Vector3(Math.cos(ang) * (WHEEL_R - 0.03), Math.sin(ang) * (WHEEL_R - 0.03), 0.012 * (i % 2 ? 1 : -1));
        tube(new THREE.Vector3(0, 0, to.z), to, 0.0025, chrome, w);
      }
      w.position.set(x, WHEEL_R, 0);
      this.wheels.push(w);
      this.group.add(w);
    }

    // Frame.
    const head = new THREE.Vector3(0.42, 0.86, 0);
    const rearHub = new THREE.Vector3(-0.5, WHEEL_R, 0);
    const frontHub = new THREE.Vector3(0.5, WHEEL_R, 0);
    const seatPost = SADDLE.clone().add(new THREE.Vector3(0.02, -0.06, 0));
    tube(BB, head, 0.024); // down tube
    tube(seatPost.clone().setY(0.9), head.clone().setY(0.9), 0.02); // top tube
    tube(BB, seatPost, 0.02); // seat tube + post
    for (const side of [-1, 1]) {
      tube(seatPost.clone().setY(0.88).setZ(0.0), rearHub.clone().setZ(0.055 * side), 0.009); // seat stays
      tube(BB.clone().setZ(0.045 * side), rearHub.clone().setZ(0.055 * side), 0.009); // chain stays
      tube(head.clone().setZ(0.0), frontHub.clone().setZ(0.055 * side), 0.011); // fork blades
    }
    tube(head, head.clone().add(new THREE.Vector3(0.0, 0.12, 0)), 0.02); // steerer
    tube(head.clone().add(new THREE.Vector3(0.0, 0.11, 0)), BARS, 0.016, black); // stem
    // Drop bars: a flat top and two hooks.
    tube(BARS.clone().setZ(-0.21), BARS.clone().setZ(0.21), 0.013, black);
    for (const side of [-1, 1]) {
      const hook = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 6, 12, Math.PI), black);
      hook.position.copy(BARS).add(new THREE.Vector3(0.03, -0.07, 0.21 * side));
      hook.rotation.y = Math.PI / 2;
      hook.rotation.x = Math.PI / 2;
      this.group.add(hook);
      const hood = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.05, 3, 6), black);
      hood.position.copy(BARS).add(new THREE.Vector3(0.08, 0.0, 0.21 * side));
      hood.rotation.z = -1.2;
      this.group.add(hood);
    }
    const saddle = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.2, 4, 8), black);
    saddle.rotation.z = Math.PI / 2;
    saddle.position.copy(SADDLE).add(new THREE.Vector3(-0.03, 0.03, 0));
    saddle.scale.set(1, 1, 1.3);
    this.group.add(saddle);

    // Cranks, pedals, chainring.
    this.crank.position.copy(BB);
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.028, CRANK, 0.014), black);
      arm.position.set(0, (CRANK / 2) * side, 0.085 * side);
      const pedal = new THREE.Group();
      pedal.position.set(0, CRANK * side, 0.12 * side);
      pedal.add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.015, 0.06), black));
      this.crank.add(arm, pedal);
      this.pedals.push(pedal);
    }
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.006, 24), chrome);
    ring.rotation.x = Math.PI / 2;
    ring.position.z = 0.055;
    this.crank.add(ring);
    this.group.add(this.crank);
    const chain = tube(BB.clone().add(new THREE.Vector3(0, 0.1, 0.055)), rearHub.clone().add(new THREE.Vector3(0, 0.04, 0.055)), 0.004, black);
    chain.visible = true;

    // Rider body: pelvis, torso leaning to the bars, head, arms with elbows.
    const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), shorts);
    pelvis.position.copy(HIP).add(new THREE.Vector3(0.02, 0.03, 0));
    pelvis.scale.set(0.9, 0.8, 1.15);
    const torsoDir = SHOULDER.clone().sub(HIP);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.135, torsoDir.length() - 0.1, 4, 10), kit);
    torso.position.copy(HIP).lerp(SHOULDER, 0.52);
    torso.quaternion.setFromUnitVectors(UP, torsoDir.clone().normalize());
    torso.scale.set(1, 1, 1.25);
    const chest = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), kit2);
    chest.position.copy(SHOULDER).add(new THREE.Vector3(-0.02, -0.02, 0));
    chest.scale.set(0.9, 0.7, 1.3);
    const neck = tube(SHOULDER, SHOULDER.clone().add(new THREE.Vector3(0.12, 0.08, 0)), 0.045, skin);
    const headPos = SHOULDER.clone().add(new THREE.Vector3(0.2, 0.1, 0));
    const headM = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 12), skin);
    headM.position.copy(headPos);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), white);
    helmet.position.copy(headPos).add(new THREE.Vector3(-0.01, 0.015, 0));
    helmet.rotation.z = -0.35;
    helmet.scale.set(1.15, 1, 1);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.17), black);
    visor.position.copy(headPos).add(new THREE.Vector3(0.1, 0.02, 0));
    this.group.add(pelvis, torso, chest, neck, headM, helmet, visor);
    for (const side of [-1, 1]) {
      const sh = SHOULDER.clone().setZ(0.17 * side);
      const hand = BARS.clone().add(new THREE.Vector3(0.08, 0.01, 0.21 * side));
      const elbow = bend(sh, hand, 0.3, 0.28, new THREE.Vector3(0.1, -1, 0.3 * side));
      tube(sh, elbow, 0.045, kit);
      tube(elbow, hand, 0.035, skin);
      const glove = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), black);
      glove.position.copy(hand);
      this.group.add(glove);
      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.36, 4, 10), shorts);
      const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.38, 4, 10), skin);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.08), white);
      this.group.add(thigh, shin, shoe);
      this.legs.push({ thigh, shin, shoe, side });
    }
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
