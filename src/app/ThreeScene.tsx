import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PageId } from "../model";
import type { SceneGraphInput } from "../network";
import { mapGraphTo3D, type Scene3D } from "./threeScene.map";
import type { Workbench } from "./workbench";

/**
 * ThreeScene (FEAT-006, spec §3.4) — the secret 3D dimensional shift.
 *
 * It renders the SAME live concept-network graph the 2D NodesCanvas shows,
 * lifted into a navigable Three.js WebGL space:
 *   - nodes become glowing stellar PARTICLES (additive points) in watercolor
 *     fog (scene.fog + soft translucent materials),
 *   - categories become translucent 3D bubble HULLS (spheres) sized/centered
 *     from the squircle bounds,
 *   - relationships become faint connecting line glyphs between the particles.
 *
 * The graph -> scene-descriptor mapping is the PURE, Vitest-covered
 * mapGraphTo3D() (threeScene.map.ts); this component only translates those
 * plain descriptors into Three.js objects and drives navigation, so it adds no
 * scene semantics that aren't provable headlessly.
 *
 * WebGL GUARD: if a WebGL context cannot be acquired (headless CI without GPU,
 * blocked context) we DO NOT crash — we render a visible 2D-fallback notice
 * (data-testid="three-fallback") and leave the 2D experience intact. The e2e
 * spec branches on a WebGL-availability probe accordingly.
 *
 * Navigation: orbit-style camera via OrbitControls (pointer drag + wheel zoom),
 * imported from three/examples per the plan (no extra dependency).
 */
export function ThreeScene({
  wb,
  suppressMotion,
  onExit,
}: {
  wb: Workbench;
  suppressMotion: boolean;
  onExit: () => void;
}): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  // Read the LIVE graph and map it (purely) to a 3D scene descriptor. Keyed on
  // a structural signature so we only rebuild the Three.js scene when the
  // underlying records actually change (idle = stable, no camera snap).
  const graphInput = useMemo<SceneGraphInput>(() => toSceneInput(wb), [wb]);
  const scene3d = useMemo<Scene3D>(() => mapGraphTo3D(graphInput), [graphInput]);
  const signature = useMemo(() => JSON.stringify(graphInput), [graphInput]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // Guard: refuse to even construct a renderer without a usable WebGL context.
    if (!isWebGLAvailable()) {
      setWebglFailed(true);
      return;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setWebglFailed(true);
      return;
    }
    setWebglFailed(false);

    const width = mount.clientWidth || 800;
    const height = mount.clientHeight || 600;
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = renderer.domElement;
    canvas.setAttribute("data-testid", "three-canvas");
    mount.appendChild(canvas);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#f4f1ea");
    // Gentle watercolor fog: distant particles dissolve into the paper tone.
    const extent = Math.max(scene3d.extent, 200);
    scene.fog = new THREE.FogExp2(0xf4f1ea, 0.0016);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, extent * 20);
    camera.position.set(extent * 0.9, extent * 0.8, extent * 1.6);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const key = new THREE.DirectionalLight(0xffffff, 0.5);
    key.position.set(1, 1, 1);
    scene.add(key);

    const disposables: { dispose: () => void }[] = [];

    // --- Particles (glowing stellar nodes) ---------------------------------
    if (scene3d.particles.length > 0) {
      const positions = new Float32Array(scene3d.particles.length * 3);
      scene3d.particles.forEach((p, i) => {
        positions[i * 3] = p.position.x;
        positions[i * 3 + 1] = p.position.y;
        positions[i * 3 + 2] = p.position.z;
      });
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: 0x2a2825,
        size: 10,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const points = new THREE.Points(geom, mat);
      points.name = "particles";
      scene.add(points);
      disposables.push(geom, mat);
    }

    // --- Category hulls (translucent 3D bubbles) ---------------------------
    for (const hull of scene3d.hulls) {
      const geom = new THREE.SphereGeometry(hull.radius, 24, 18);
      const color = new THREE.Color(safeColor(hull.colorCode));
      const mat = new THREE.MeshStandardMaterial({
        color,
        transparent: true,
        opacity: 0.12,
        roughness: 0.9,
        metalness: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(hull.center.x, hull.center.y, hull.center.z);
      scene.add(mesh);
      disposables.push(geom, mat);
    }

    // --- Relationship link glyphs ------------------------------------------
    for (const link of scene3d.links) {
      if (link.endpoints.length < 2) continue;
      const pts = link.endpoints.map(
        (e) => new THREE.Vector3(e.x, e.y, e.z),
      );
      const geom = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(safeColor(link.blendColor)),
        transparent: true,
        opacity: 0.4,
      });
      const line = new THREE.Line(geom, mat);
      scene.add(line);
      disposables.push(geom, mat);
    }

    // --- Navigation --------------------------------------------------------
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = !suppressMotion;
    controls.dampingFactor = 0.08;
    // Auto-rotate is the only ambient motion; suppress it when motion is off so
    // the no-forced-camera-motion guarantee carries into 3D.
    controls.autoRotate = false;

    let raf = 0;
    const render = (): void => {
      controls.update();
      renderer.render(scene, camera);
    };
    const loop = (): void => {
      raf = requestAnimationFrame(loop);
      render();
    };
    if (suppressMotion) {
      // Static frame: render once and on interaction only (no rAF spin).
      render();
      controls.addEventListener("change", render);
    } else {
      loop();
    }

    const onResize = (): void => {
      const w = mount.clientWidth || width;
      const h = mount.clientHeight || height;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
      controls.removeEventListener("change", render);
      controls.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      if (canvas.parentNode === mount) mount.removeChild(canvas);
    };
    // Rebuild only when the structural signature or motion mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, suppressMotion]);

  return (
    <div
      data-testid="three-scene"
      data-suppress-motion={suppressMotion ? "true" : "false"}
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      <button
        data-testid="exit-3d"
        onClick={onExit}
        style={{
          position: "absolute",
          top: "0.75rem",
          right: "0.75rem",
          zIndex: 2,
          padding: "0.4rem 0.8rem",
          borderRadius: "999px",
          border: "1px solid #c9c2b4",
          background: "rgba(251, 250, 247, 0.9)",
          color: "#3a3733",
          cursor: "pointer",
        }}
      >
        Return to 2D
      </button>
      {webglFailed ? (
        <div
          data-testid="three-fallback"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: "2rem",
            color: "#8a847c",
            font: "500 14px system-ui, sans-serif",
          }}
        >
          3D view is unavailable here (no WebGL). The 2D concept network remains
          fully available — select Return to 2D.
        </div>
      ) : null}
      <div
        ref={mountRef}
        data-testid="three-mount"
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}

/** Map the live Workbench graph to the pure scene mapper's input shape. */
function toSceneInput(wb: Workbench): SceneGraphInput {
  const g = wb.conceptGraph();
  return {
    nodes: g.nodes.map((n) => ({
      pageId: n.pageId,
      title: n.title,
      hidden: n.hidden,
      position: n.position,
    })),
    links: g.links.map((l) => ({
      relationshipId: l.relationshipId,
      endpointPageIds: l.endpointPageIds as readonly PageId[] as readonly string[],
      label: l.label,
      blendColor: l.blendColor,
      hidden: l.hidden,
    })),
    categories: g.categories.map((c) => ({
      categoryId: c.categoryId,
      name: c.name,
      colorCode: c.colorCode,
      memberPageIds: c.memberPageIds as readonly PageId[] as readonly string[],
    })),
  };
}

/**
 * Probe whether a WebGL context can actually be acquired in this environment.
 * Pure DOM feature-detection (no Three.js state). Used both by the mount guard
 * and exposed via window.__ito so the e2e spec can branch on it.
 */
export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl");
    return gl != null;
  } catch {
    return false;
  }
}

/** Fall back to a neutral pigment if a color string is empty/invalid. */
function safeColor(code: string | undefined): string {
  if (code && /^#[0-9a-fA-F]{3,8}$/.test(code)) return code;
  return "#9aa7b2";
}
