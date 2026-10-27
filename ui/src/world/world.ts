// The live 3D view: renders the static world, moves the rider from engine
// snapshots and runs the chase camera.
import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import type { EngineSnapshot, Route } from "../types";
import { Rider, TYRE_BULGE } from "./rider";
import { RouteSampler } from "./route";
import type { RoadNetwork } from "./network";
import { buildWorld, cloudLayers, type Detail, FAR_SIZE, gridBlockMesh, imageTexture, patchTexture, REAL_ROAD_WIDTH, ROAD_LIFT, ROAD_WIDTH, seaMesh, type WorldStatics } from "./scene";
import { TileManager } from "./streaming";
import { gridSample as gridSampleOr, imageMean, type NetworkWorldData, type WorldData } from "./terrain";
import { detailTexture, rockDetailTexture, rockNormalTexture, scrubDetailTexture } from "./textures";

export type CameraMode = "chase" | "side" | "front" | "drone" | "orbit";
/** The modes the C key cycles through; orbit is for the menus. */
const MODES: CameraMode[] = ["chase", "side", "front", "drone"];

export class World {
  sampler: RouteSampler;
  /** Present when the world streams tiles around a road network. */
  tiles: TileManager | null = null;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private sun: THREE.DirectionalLight;
  private sunDir: THREE.Vector3;
  private sky: THREE.Object3D;
  private statics: WorldStatics;
  private rider = new Rider();
  private orbitAngle = 0;
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

  constructor(canvas: HTMLCanvasElement, route: Route, world?: WorldData, network?: { data: NetworkWorldData; net: RoadNetwork }) {
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
    this.sky = sky;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    this.scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    this.scene.environmentIntensity = 0.4;
    envScene.clear();
    this.scene.fog = new THREE.Fog("#bccfe4", 900, 10000);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, 30000);
    this.scene.add(new THREE.HemisphereLight("#bcd6f5", "#6f7f5a", 0.9));
    this.sun = new THREE.DirectionalLight("#fff1d6", 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1536, 1536);
    const s = 110;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 900 });
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.3;
    // A soft fill from the opposite side, as the sky and the ground bounce would give: shaded cliffs stay readable.
    const fill = new THREE.DirectionalLight("#c8d8ee", 0.75);
    fill.position.copy(sunDir.clone().multiply(new THREE.Vector3(-1, 0.6, -1)).normalize().multiplyScalar(100));
    this.scene.add(fill);
    this.sunDir = sunDir;
    this.scene.add(this.sun, this.sun.target);

    this.statics = network ? this.buildNetworkWorld(network.data, network.net) : buildWorld(route, world);
    this.laneOffset = (world || network ? REAL_ROAD_WIDTH : ROAD_WIDTH) * 0.22;
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

  /** The far layer, sea and clouds once; the rest streams in around the rider. */
  private buildNetworkWorld(data: NetworkWorldData, net: RoadNetwork): WorldStatics {
    const group = new THREE.Group();
    const detail: Detail = data.details
      ? {
          grain: detailTexture(),
          rock: patchTexture(data.details.rock),
          scrub: patchTexture(data.details.scrub),
          normal: rockNormalTexture(),
          rockScale: data.details.metres,
          scrubScale: data.details.metres,
          rockMean: imageMean(data.details.rock),
          scrubMean: imageMean(data.details.scrub),
        }
      : { grain: detailTexture(), rock: rockDetailTexture(), scrub: scrubDetailTexture(), normal: rockNormalTexture(), rockScale: 3.2, scrubScale: 2.6, rockMean: [0.5, 0.5, 0.5], scrubMean: [0.5, 0.5, 0.5] };
    const far = data.far;
    const farHeight = (x: number, z: number) => gridSampleOr(far, x, z) ?? -10;
    let farMesh: THREE.Mesh | null = null;
    if (far.ortho) {
      farMesh = gridBlockMesh(far, farHeight, [0, far.rows - 1], [0, far.cols - 1], imageTexture(far.ortho.images[0][0]), detail, 0);
      group.add(farMesh);
    }
    const cx = far.x0 + (far.cols * far.spacing) / 2;
    const cz = far.z0 + (far.rows * (far.spacingZ ?? far.spacing)) / 2;
    const sea = seaMesh(FAR_SIZE * 8, cx, cz);
    group.add(sea.mesh);
    const clouds = cloudLayers(cx, cz);
    group.add(...clouds.meshes);
    const tiles = new TileManager(group, data, net, far, farMesh, detail);
    this.tiles = tiles;
    return {
      group,
      heightAt: tiles.heightAt,
      animate: (dt) => {
        sea.animate(dt);
        clouds.animate(dt);
      },
    };
  }

  /** A new route from the engine (a navigator extended or re-planned it). Distances stay comparable. */
  setRoute(route: Route) {
    this.sampler = new RouteSampler(route);
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
    if ((MODES as string[]).includes(mode) || mode === "orbit") this.mode = mode as CameraMode;
  }

  /** Swaps the rider model for one in these colours. */
  setRider(jersey: string, accent: string, bike: string) {
    const old = this.rider;
    this.rider = new Rider(jersey, accent, bike);
    this.rider.group.position.copy(old.group.position);
    this.rider.group.quaternion.copy(old.group.quaternion);
    this.scene.remove(old.group);
    this.scene.add(this.rider.group);
  }

  /** Stops rendering and frees the GPU resources. */
  dispose() {
    this.running = false;
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
          m.dispose();
        }
      }
    });
    this.renderer.renderLists.dispose();
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
    if (this.frameTimes.length < 45) return;
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
    this.tiles?.update(g.position.x, g.position.z, this.camPos);
    this.adaptResolution(dt);

    // Camera.
    const rider = g.position;
    let wantPos: THREE.Vector3;
    let wantLook: THREE.Vector3;
    switch (this.mode) {
      case "orbit": {
        // Slow circle round the rider for the menus.
        this.orbitAngle += dt * 0.25;
        const r = 5.5;
        wantPos = rider.clone().add(new THREE.Vector3(Math.cos(this.orbitAngle) * r, 1.6, Math.sin(this.orbitAngle) * r));
        wantLook = rider.clone().add(up.clone().multiplyScalar(0.9));
        break;
      }
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
      default: {
        // Follow the road itself, not the rider's heading: the camera sits on
        // the road behind and looks along it ahead, so in a hairpin it stays
        // on the tarmac and looks round the bend instead of into the bank.
        const back = this.sampler.pose(this.distance - 8.5);
        const ahead = this.sampler.pose(this.distance + 7);
        const backRight = new THREE.Vector3(-back.dz, 0, back.dx).multiplyScalar(this.laneOffset * 0.6);
        wantPos = new THREE.Vector3(back.x, Math.max(back.y, rider.y - 1) + 2.7, back.z).add(backRight);
        wantLook = new THREE.Vector3(ahead.x, ahead.y + 1.0, ahead.z).lerp(rider.clone().add(up.clone().multiplyScalar(1.0)), 0.6);
      }
    }
    // Keep the camera above the ground and its line of sight to the rider
    // clear of the terrain: on a road cut into a slope the ground between
    // them can rise well above both. Applied to the target and again to the
    // smoothed position, which lags behind and would otherwise dip underground.
    const eye = rider.clone().add(up.clone().multiplyScalar(1.2));
    const before = wantPos.y;
    this.clearTerrain(wantPos, eye);
    if (this.mode === "orbit") {
      this.camPos.copy(wantPos);
      this.camLook.copy(wantLook);
    }
    // When the terrain forces the camera well up, bring it in closer too, so
    // hairpins cut into a slope are not watched from high above the bank.
    const lifted = wantPos.y - before;
    if (lifted > 2 && this.mode === "chase") {
      const t = Math.min(1, (lifted - 2) / 8);
      wantPos.lerp(eye.clone().add(up.clone().multiplyScalar(lifted * 0.5)), 0.45 * t);
      this.clearTerrain(wantPos, eye);
    }
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

    // The sky dome and the sun's shadow box follow the rider: an island is wider than the dome.
    this.sky.position.copy(this.camPos);
    this.sun.position.copy(rider).add(this.sunDir.clone().multiplyScalar(400));
    this.sun.target.position.copy(rider);

    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(() => this.frame());
  }
}
