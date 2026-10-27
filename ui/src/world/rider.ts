// A low-poly rider on a bike, built from primitives. Forward is +X in local space.
import * as THREE from "three";

const WHEEL_R = 0.34;
const CRANK = 0.17;

export class Rider {
  readonly group = new THREE.Group();
  private wheels: THREE.Mesh[] = [];
  private crank = new THREE.Group();
  private pedals: THREE.Group[] = [];
  private legs: { thigh: THREE.Mesh; shin: THREE.Mesh; side: number }[] = [];
  private crankAngle = 0;
  private wheelAngle = 0;
  private hip = new THREE.Vector3(-0.12, 1.05, 0);

  constructor(jersey = "#ffc400") {
    const black = new THREE.MeshLambertMaterial({ color: "#1c1e24" });
    const frame = new THREE.MeshLambertMaterial({ color: "#2b7fff" });
    const skin = new THREE.MeshLambertMaterial({ color: "#e9b48c" });
    const kit = new THREE.MeshLambertMaterial({ color: jersey });
    const shorts = new THREE.MeshLambertMaterial({ color: "#1a1a22" });

    // Wheels.
    const tyre = new THREE.TorusGeometry(WHEEL_R, 0.035, 8, 28);
    const rim = new THREE.CylinderGeometry(WHEEL_R - 0.03, WHEEL_R - 0.03, 0.02, 24);
    rim.rotateX(Math.PI / 2);
    for (const x of [0.5, -0.5]) {
      const w = new THREE.Group();
      const t = new THREE.Mesh(tyre, black);
      const r = new THREE.Mesh(rim, new THREE.MeshLambertMaterial({ color: "#8a8f9c", transparent: true, opacity: 0.35 }));
      w.add(t, r);
      w.position.set(x, WHEEL_R, 0);
      this.wheels.push(t);
      this.group.add(w);
      this.wheels.push(r);
    }

    // Frame: a few tubes.
    const tube = (a: THREE.Vector3, b: THREE.Vector3, r = 0.025, mat = frame) => {
      const len = a.distanceTo(b);
      const g = new THREE.CylinderGeometry(r, r, len, 6);
      const m = new THREE.Mesh(g, mat);
      m.position.copy(a).lerp(b, 0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      m.castShadow = true;
      this.group.add(m);
      return m;
    };
    const bb = new THREE.Vector3(0.02, 0.3, 0); // bottom bracket
    const head = new THREE.Vector3(0.42, 0.85, 0);
    const seat = new THREE.Vector3(-0.2, 0.9, 0);
    const rear = new THREE.Vector3(-0.5, WHEEL_R, 0);
    const front = new THREE.Vector3(0.5, WHEEL_R, 0);
    tube(bb, head); // down tube
    tube(seat, head); // top tube
    tube(bb, seat); // seat tube
    tube(seat, rear, 0.018); // seat stay
    tube(bb, rear, 0.018); // chain stay
    tube(head, front, 0.02); // fork
    tube(head.clone().add(new THREE.Vector3(0.05, 0.1, 0)), head, 0.02); // stem
    tube(new THREE.Vector3(0.47, 0.95, -0.2), new THREE.Vector3(0.47, 0.95, 0.2), 0.02, black); // bars
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 0.12), black);
    saddle.position.set(-0.22, 0.95, 0);
    this.group.add(saddle);

    // Cranks and pedals.
    this.crank.position.copy(bb);
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.03, CRANK, 0.02), black);
      arm.position.set(0, (CRANK / 2) * side, 0.09 * side);
      const pedal = new THREE.Group();
      pedal.position.set(0, CRANK * side, 0.12 * side);
      pedal.add(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.07), black));
      this.crank.add(arm, pedal);
      this.pedals.push(pedal);
    }
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.01, 20), black);
    ring.rotation.x = Math.PI / 2;
    ring.position.z = 0.06;
    this.crank.add(ring);
    this.group.add(this.crank);

    // Rider: torso leaning forward, head, arms, legs driven by the cranks.
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.42, 4, 8), kit);
    torso.position.set(0.1, 1.22, 0);
    torso.rotation.z = -1.0;
    torso.castShadow = true;
    const headM = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), skin);
    headM.position.set(0.44, 1.42, 0);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.135, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: "#f4f4f4" }));
    helmet.position.copy(headM.position).add(new THREE.Vector3(0, 0.01, 0));
    helmet.rotation.z = -0.5;
    this.group.add(torso, headM, helmet);
    for (const side of [-1, 1]) {
      tube(new THREE.Vector3(0.22, 1.3, 0.14 * side), new THREE.Vector3(0.47, 0.97, 0.19 * side), 0.035, kit);
      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.4, 4, 8), shorts);
      const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.4, 4, 8), skin);
      thigh.castShadow = shin.castShadow = true;
      this.group.add(thigh, shin);
      this.legs.push({ thigh, shin, side });
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
    for (const p of this.pedals) p.rotation.z = this.crankAngle; // pedals stay level
    for (const w of this.wheels) w.rotation.z = -this.wheelAngle;

    const hip = this.hip;
    const thighLen = 0.46;
    const shinLen = 0.46;
    for (const { thigh, shin, side } of this.legs) {
      const a = this.crankAngle + (side > 0 ? 0 : Math.PI);
      const foot = new THREE.Vector3(0.02 + Math.sin(a) * CRANK, 0.3 + Math.cos(a) * CRANK, 0.12 * side);
      const h = hip.clone().setZ(0.1 * side);
      const d = h.distanceTo(foot);
      const reach = Math.min(d, thighLen + shinLen - 0.01);
      // Knee by the law of cosines, bent forward.
      const cosA = (thighLen * thighLen + reach * reach - shinLen * shinLen) / (2 * thighLen * reach);
      const ang = Math.acos(Math.min(Math.max(cosA, -1), 1));
      const dir = foot.clone().sub(h).normalize();
      const perp = new THREE.Vector3(-dir.y, dir.x, 0); // forward, in the XY plane
      const knee = h.clone().add(dir.clone().multiplyScalar(Math.cos(ang) * thighLen)).add(perp.multiplyScalar(Math.sin(ang) * thighLen));
      place(thigh, h, knee);
      place(shin, knee, foot);
    }
  }
}

function place(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
  m.position.copy(a).lerp(b, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
}
