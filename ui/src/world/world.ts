// The live 3D view: renders the static world, moves the rider from engine
// snapshots and runs the chase camera.
import * as THREE from "three";
import type { EngineSnapshot, Route } from "../types";
import { Rider } from "./rider";
import { RouteSampler } from "./route";
import { buildWorld, type WorldStatics } from "./scene";

export type CameraMode = "chase" | "side" | "front" | "drone";
const MODES: CameraMode[] = ["chase", "side", "front", "drone"];

export class World {
  readonly sampler: RouteSampler;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private sun: THREE.DirectionalLight;
  private statics: WorldStatics;
  private rider = new Rider();
  private distance = 0;
  private targetDistance = 0;
  private speed = 0;
  private cadence = 0;
  private lastFrame = performance.now();
  private running = true;
  private mode: CameraMode = "chase";
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private heading = new THREE.Vector3(1, 0, 0);
  private lean = 0;

  constructor(canvas: HTMLCanvasElement, route: Route) {
    this.sampler = new RouteSampler(route);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    const sky = new THREE.Color("#8ec5ff");
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog("#b9dcff", 250, 1600);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, 4000);
    this.scene.add(new THREE.HemisphereLight("#cfe6ff", "#6f8f4f", 0.9));
    this.sun = new THREE.DirectionalLight("#fff3dc", 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = 70;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 600 });
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);

    this.statics = buildWorld(route);
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
    this.speed = s.virtual_speed_kmh / 3.6;
    this.cadence = s.cadence_rpm ?? 0;
    if (Math.abs(this.targetDistance - this.distance) > 20) this.distance = this.targetDistance;
  }

  cycleCamera(): CameraMode {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    return this.mode;
  }

  stop() {
    this.running = false;
  }

  private frame() {
    if (!this.running) return;
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;

    // Dead-reckon between snapshots, then ease toward the authoritative distance.
    this.distance += this.speed * dt;
    this.distance += (this.targetDistance - this.distance) * Math.min(1, dt * 2);

    const pose = this.sampler.pose(this.distance);
    const up = new THREE.Vector3(0, 1, 0);
    const fwd = new THREE.Vector3(pose.dx, 0, pose.dz);
    const turn = this.heading.clone().cross(fwd).y; // + = turning left
    this.heading.lerp(fwd, Math.min(1, dt * 10)).normalize();
    this.lean += (Math.max(-0.35, Math.min(0.35, turn * this.speed * 3.5)) - this.lean) * Math.min(1, dt * 6);

    const g = this.rider.group;
    g.position.set(pose.x, pose.y, pose.z);
    const pitch = Math.atan(pose.grade / 100);
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), this.heading.clone().negate(), up));
    g.rotateY(-Math.PI / 2);
    g.rotateZ(pitch);
    g.rotateX(-this.lean);
    this.rider.animate(this.cadence, this.speed, dt);

    // Camera.
    const left = new THREE.Vector3(-this.heading.z, 0, this.heading.x);
    const rider = g.position;
    let wantPos: THREE.Vector3;
    let wantLook: THREE.Vector3;
    switch (this.mode) {
      case "side":
        wantPos = rider.clone().add(left.clone().multiplyScalar(9)).add(up.clone().multiplyScalar(2.2));
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
    // Keep the camera above the ground.
    const ground = this.statics.heightAt(wantPos.x, wantPos.z) + 1.2;
    if (wantPos.y < ground) wantPos.y = ground;
    const k = Math.min(1, dt * 5);
    if (this.camPos.lengthSq() === 0) {
      this.camPos.copy(wantPos);
      this.camLook.copy(wantLook);
    }
    this.camPos.lerp(wantPos, k);
    this.camLook.lerp(wantLook, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    // The sun's shadow box follows the rider.
    this.sun.position.copy(rider).add(new THREE.Vector3(120, 220, 80));
    this.sun.target.position.copy(rider);

    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(() => this.frame());
  }
}
