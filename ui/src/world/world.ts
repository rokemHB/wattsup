// The live 3D view: renders the static world, moves the rider from engine
// snapshots and runs the chase camera.
import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import type { EngineSnapshot, Route } from "../types";
import { Rider, TYRE_BULGE } from "./rider";
import { RouteSampler } from "./route";
import { buildWorld, REAL_ROAD_WIDTH, ROAD_LIFT, ROAD_WIDTH, type WorldStatics } from "./scene";
import type { WorldData } from "./terrain";

export type CameraMode = "chase" | "side" | "front" | "drone";
const MODES: CameraMode[] = ["chase", "side", "front", "drone"];

export class World {
  readonly sampler: RouteSampler;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private sun: THREE.DirectionalLight;
  private sunDir: THREE.Vector3;
  private statics: WorldStatics;
  private rider = new Rider();
  private distance = 0;
  private targetDistance = 0;
  private targetAt = performance.now();
  private speed = 0;
  onFrame: (() => void) | null = null;
  private cadence = 0;
  private lastFrame = performance.now();
  private running = true;
  private mode: CameraMode = "chase";
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private heading = new THREE.Vector3(1, 0, 0);
  private lean = 0;
  /** How far right of the centre line the rider rides. */
  private laneOffset: number;
  /** Render scale, tuned at runtime to hold the frame rate on weak GPUs. */
  private pixelRatio = Math.min(window.devicePixelRatio, 1.5);
  private frameTimes: number[] = [];

  constructor(canvas: HTMLCanvasElement, route: Route, world?: WorldData) {
    this.sampler = new RouteSampler(route);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.debug.onShaderError = (gl, _program, vs, fs) => {
      console.warn(`shader error: vertex: ${gl.getShaderInfoLog(vs)} fragment: ${gl.getShaderInfoLog(fs)}`);
    };
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.56;

    // Sky with atmospheric scattering; it also lights the materials through an environment map.
    const sky = new Sky();
    sky.scale.setScalar(40000);
    const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 46), THREE.MathUtils.degToRad(160));
    Object.assign(sky.material.uniforms, {});
    sky.material.uniforms.turbidity.value = 2.0;
    sky.material.uniforms.rayleigh.value = 1.0;
    sky.material.uniforms.mieCoefficient.value = 0.002;
    sky.material.uniforms.mieDirectionalG.value = 0.8;
    sky.material.uniforms.sunPosition.value.copy(sunDir);
    this.scene.add(sky);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    this.scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    this.scene.environmentIntensity = 0.4;
    envScene.clear();
    this.scene.fog = new THREE.Fog("#c6d9ec", 500, 9000);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, 30000);
    this.scene.add(new THREE.HemisphereLight("#bcd6f5", "#6f7f5a", 0.7));
    this.sun = new THREE.DirectionalLight("#fff1d6", 3.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1536, 1536);
    const s = 110;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 900 });
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.3;
    this.sunDir = sunDir;
    this.scene.add(this.sun, this.sun.target);

    this.statics = buildWorld(route, world);
    this.laneOffset = (world ? REAL_ROAD_WIDTH : ROAD_WIDTH) * 0.22;
    this.scene.add(this.statics.group, this.rider.group);

    this.resize();
    window.addEventListener("resize", () => this.resize());
    requestAnimationFrame(() => this.frame());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Feeds the latest engine state. Called ~20 times a second. */
  update(snap: EngineSnapshot) {
    const s = snap.session;
    this.targetDistance = s.distance_m;
    this.targetAt = performance.now();
    this.speed = s.virtual_speed_kmh / 3.6;
    this.cadence = s.cadence_rpm ?? 0;
    if (Math.abs(this.targetDistance - this.distance) > 20) this.distance = this.targetDistance;
  }

  setCamera(mode: string) {
    if ((MODES as string[]).includes(mode)) this.mode = mode as CameraMode;
  }

  cycleCamera(): CameraMode {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    return this.mode;
  }

  stop() {
    this.running = false;
  }

  /** Raises `pos` until it is above the ground and sees `eye` without terrain in between. */
  private clearTerrain(pos: THREE.Vector3, eye: THREE.Vector3) {
    for (let pass = 0; pass < 3; pass++) {
      let lift = Math.max(0, this.statics.heightAt(pos.x, pos.z) + 1.2 - pos.y);
      for (let t = 0.12; t < 1; t += 0.08) {
        const px = eye.x + (pos.x - eye.x) * t;
        const pz = eye.z + (pos.z - eye.z) * t;
        const py = eye.y + (pos.y - eye.y) * t;
        const need = this.statics.heightAt(px, pz) + 1.0 - py;
        // A blockage at fraction t needs the camera end raised by need / t.
        if (need > 0) lift = Math.max(lift, need / t);
      }
      if (lift <= 0.01) return;
      pos.y += lift;
    }
  }

  /** Every two seconds: lower the render scale when frames are slow, raise it when there is headroom. */
  private adaptResolution(dt: number) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 120) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.frameTimes = [];
    const max = Math.min(window.devicePixelRatio, 1.5);
    let next = this.pixelRatio;
    if (median > 1 / 50 && this.pixelRatio > 0.6) next = Math.max(0.6, this.pixelRatio - 0.2);
    else if (median < 1 / 70 && this.pixelRatio < max) next = Math.min(max, this.pixelRatio + 0.25);
    if (next !== this.pixelRatio) {
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      this.resize();
    }
  }

  private frame() {
    if (!this.running) return;
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;

    // The engine steps the physics every 250 ms, so its distance arrives in
    // jumps. Extrapolate it by the time since the snapshot and close the gap
    // through velocity, never through position, so motion stays smooth.
    const estimate = this.targetDistance + (this.speed * (now - this.targetAt)) / 1000;
    const error = Math.max(-5, Math.min(5, estimate - this.distance));
    this.distance += (this.speed + error * 1.5) * dt;
    this.onFrame?.();

    const pose = this.sampler.pose(this.distance);
    const up = new THREE.Vector3(0, 1, 0);
    const fwd = new THREE.Vector3(pose.dx, 0, pose.dz);
    const turn = this.heading.clone().cross(fwd).y; // + = turning left
    this.heading.lerp(fwd, Math.min(1, dt * 10)).normalize();
    this.lean += (Math.max(-0.35, Math.min(0.35, turn * this.speed * 3.5)) - this.lean) * Math.min(1, dt * 6);

    // Ride on the right-hand side of the lane, not on the centre line.
    const right = new THREE.Vector3(-this.heading.z, 0, this.heading.x);
    const g = this.rider.group;
    const pitch = Math.atan(pose.grade / 100);
    // The road surface sits ROAD_LIFT above the route line and the tyre bulges
    // TYRE_BULGE below the hub height; pitching about the bike's middle dips one
    // wheel by half the wheelbase times the slope.
    const clearance = ROAD_LIFT + TYRE_BULGE + 0.5 * Math.abs(Math.sin(pitch)) + 0.005;
    g.position.set(pose.x, pose.y + clearance, pose.z).add(right.clone().multiplyScalar(this.laneOffset));
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), this.heading.clone().negate(), up));
    g.rotateY(-Math.PI / 2);
    g.rotateZ(pitch);
    g.rotateX(-this.lean);
    this.rider.animate(this.cadence, this.speed, dt);
    this.statics.animate(dt);
    this.adaptResolution(dt);

    // Camera.
    const rider = g.position;
    let wantPos: THREE.Vector3;
    let wantLook: THREE.Vector3;
    switch (this.mode) {
      case "side":
        wantPos = rider.clone().add(right.clone().multiplyScalar(9)).add(up.clone().multiplyScalar(2.2));
        wantLook = rider.clone().add(up.clone().multiplyScalar(0.9));
        break;
      case "front":
        wantPos = rider.clone().add(this.heading.clone().multiplyScalar(7)).add(up.clone().multiplyScalar(1.6));
        wantLook = rider.clone().add(up.clone().multiplyScalar(1.0));
        break;
      case "drone":
        wantPos = rider.clone().add(this.heading.clone().multiplyScalar(-22)).add(up.clone().multiplyScalar(30));
        wantLook = rider.clone().add(this.heading.clone().multiplyScalar(25));
        break;
      default:
        wantPos = rider.clone().add(this.heading.clone().multiplyScalar(-9.5)).add(up.clone().multiplyScalar(3.4));
        wantLook = rider.clone().add(this.heading.clone().multiplyScalar(8)).add(up.clone().multiplyScalar(1.1));
    }
    // Keep the camera above the ground and its line of sight to the rider
    // clear of the terrain: on a road cut into a slope the ground between
    // them can rise well above both. Applied to the target and again to the
    // smoothed position, which lags behind and would otherwise dip underground.
    const eye = rider.clone().add(up.clone().multiplyScalar(1.2));
    this.clearTerrain(wantPos, eye);
    const k = Math.min(1, dt * 5);
    if (this.camPos.lengthSq() === 0) {
      this.camPos.copy(wantPos);
      this.camLook.copy(wantLook);
    }
    this.camPos.lerp(wantPos, k);
    this.camLook.lerp(wantLook, k);
    this.clearTerrain(this.camPos, eye);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    // The sun's shadow box follows the rider.
    this.sun.position.copy(rider).add(this.sunDir.clone().multiplyScalar(400));
    this.sun.target.position.copy(rider);

    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(() => this.frame());
  }
}
