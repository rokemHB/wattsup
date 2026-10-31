// A small electric two-seater (high wing, nose propeller, fixed tricycle gear), built from
// primitives like the rider: forward is +X, up +Y, its middle at the origin. The propeller
// turns with the pedals; with no one pedalling it stops and the plane hangs in the air,
// bobbing a little.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Revolutions of the propeller per revolution of the cranks. */
const PROP_GEAR = 12;

export class Plane {
  readonly group = new THREE.Group();
  private body = new THREE.Group();
  private prop = new THREE.Group();
  private disc: THREE.Mesh;
  private propAngle = 0;
  private spin = 0;
  private bob = 0;

  constructor(jersey = "#e8574a", accent = "#1f3a5f") {
    this.group.add(this.body);
    const white = new THREE.MeshStandardMaterial({ color: "#f2f2ee", roughness: 0.35, metalness: 0.1 });
    const stripe = new THREE.MeshStandardMaterial({ color: jersey, roughness: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({ color: "#23303c", roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.85 });
    const black = new THREE.MeshStandardMaterial({ color: "#1b1b1b", roughness: 0.6 });

    // Fuselage: a lathe profile (radius along the length) laid along X, nose at +3.2 m.
    const profile: [number, number][] = [
      [0.0, 3.25],
      [0.32, 3.15],
      [0.55, 2.8],
      [0.66, 2.1],
      [0.68, 1.0],
      [0.6, 0.0],
      [0.42, -1.2],
      [0.24, -2.4],
      [0.12, -3.3],
      [0.0, -3.4],
    ];
    const lathe = new THREE.LatheGeometry(
      profile.map(([r, x]) => new THREE.Vector2(r, x)),
      20,
    );
    lathe.rotateZ(-Math.PI / 2);
    lathe.scale(1, 1.15, 0.95);
    const fuselage = new THREE.Mesh(lathe, white);
    this.body.add(fuselage);
    // A stripe in the rider's colour along each side.
    for (const side of [-1, 1]) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.16, 0.02), stripe);
      s.position.set(-0.2, -0.05, side * 0.62);
      s.rotation.z = -0.05;
      this.body.add(s);
    }
    // Canopy over the two seats, a pilot's head inside.
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.62, 18, 12), glass);
    canopy.scale.set(1.7, 0.75, 0.95);
    canopy.position.set(1.0, 0.55, 0);
    this.body.add(canopy);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), new THREE.MeshStandardMaterial({ color: "#d9b08c", roughness: 0.8 }));
    head.position.set(1.0, 0.62, 0.18);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), dark);
    helmet.position.copy(head.position).add(new THREE.Vector3(0, 0.03, 0));
    this.body.add(head, helmet);

    // High wing with a little dihedral, its tips in the accent colour; struts to the fuselage.
    const half = 5.4;
    for (const side of [-1, 1]) {
      const w = new THREE.BoxGeometry(1.25, 0.14, half);
      w.translate(0, 0, (side * half) / 2);
      const wing = new THREE.Mesh(w, white);
      wing.position.set(0.6, 0.86, 0);
      wing.rotation.x = side * -0.04;
      this.body.add(wing);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.15, 0.5), stripe);
      tip.position.set(0.6, 0.86 + 0.04 * half * 0.98, side * (half - 0.25));
      this.body.add(tip);
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.9, 6), dark);
      strut.position.set(0.55, 0.15, side * 1.6);
      strut.rotation.x = side * 1.15;
      this.body.add(strut);
    }
    // Tail: stabiliser and fin.
    const stab = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.08, 3.4), white);
    stab.position.set(-3.05, 0.12, 0);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.25, 0.08), white);
    fin.position.set(-3.0, 0.72, 0);
    fin.rotation.z = 0.35;
    const finTip = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.09), stripe);
    finTip.position.set(-3.25, 1.25, 0);
    finTip.rotation.z = 0.35;
    this.body.add(stab, fin, finTip);

    // Fixed tricycle gear: wheels in spats on sprung legs.
    const wheel = new THREE.CylinderGeometry(0.2, 0.2, 0.12, 14);
    wheel.rotateX(Math.PI / 2);
    for (const [x, z] of [
      [2.3, 0],
      [0.2, 0.95],
      [0.2, -0.95],
    ]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.7, 6), dark);
      leg.position.set(x, -0.82, z * 0.8);
      leg.rotation.x = z * 0.4;
      const w2 = new THREE.Mesh(wheel, black);
      w2.position.set(x, -1.17, z);
      const spat = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), white);
      spat.scale.set(1.6, 0.85, 0.55);
      spat.position.copy(w2.position).add(new THREE.Vector3(0, 0.06, 0));
      this.body.add(leg, w2, spat);
    }

    // Propeller: spinner and two blades, plus a faint disc that shows when it turns fast.
    const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.45, 14), dark);
    spinner.rotation.z = -Math.PI / 2;
    spinner.position.x = 0.12;
    this.prop.add(spinner);
    const blade = new THREE.BoxGeometry(0.06, 0.85, 0.13);
    blade.translate(0, 0.45, 0);
    const blades = mergeGeometries([blade.clone(), blade.clone().rotateX(Math.PI)])!;
    this.prop.add(new THREE.Mesh(blades, black));
    this.prop.position.set(3.32, 0, 0);
    this.body.add(this.prop);
    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.9, 32),
      new THREE.MeshBasicMaterial({ color: "#9a9a9a", transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.disc.rotation.y = Math.PI / 2;
    this.disc.position.set(3.36, 0, 0);
    this.body.add(this.disc);

    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o !== this.disc) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  /** Turns the propeller with the cranks; with them still, the plane hangs and bobs. */
  animate(cadenceRpm: number, speedMps: number, dt: number) {
    const want = cadenceRpm > 5 ? (cadenceRpm / 60) * PROP_GEAR * Math.PI * 2 : 0;
    this.spin += (want - this.spin) * Math.min(1, dt * 2.5);
    this.propAngle += this.spin * dt;
    this.prop.rotation.x = this.propAngle;
    (this.disc.material as THREE.MeshBasicMaterial).opacity = Math.min(0.28, Math.max(0, (this.spin - 40) / 200));
    // Hanging in the air with no way on: a slow bob and a little roll.
    this.bob += dt;
    const still = Math.max(0, 1 - speedMps / 3);
    this.body.position.y = Math.sin(this.bob * 1.3) * 0.25 * still;
    this.body.rotation.x = Math.sin(this.bob * 0.9) * 0.03 * still;
  }
}
