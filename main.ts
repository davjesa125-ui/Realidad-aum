import * as THREE from 'three';
import { XREstimatedLight } from 'three/examples/jsm/webxr/XREstimatedLight.js';
import { ESCENAS, type Escena } from './content/escenas';

/* ------------------------------------------------------------------ */
/* Configuración base                                                  */
/* ------------------------------------------------------------------ */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 50);

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */
let hitTestSource: XRHitTestSource | null = null;
let hitTestRequested = false;
let currentIndex = 0;
let panel: THREE.Group | null = null;
const loader = new THREE.TextureLoader();
const raycaster = new THREE.Raycaster();
const listener = new THREE.AudioListener();      // HRTF por defecto en PannerNode
camera.add(listener);

/* ------------------------------------------------------------------ */
/* Retículo de colocación                                              */
/* ------------------------------------------------------------------ */
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

/* ------------------------------------------------------------------ */
/* Iluminación ambiental estimada (reflejos y luz reales)              */
/* ------------------------------------------------------------------ */
const fallbackLight = new THREE.HemisphereLight(0xffffff, 0x888888, 1.2);
scene.add(fallbackLight);
const xrLight = new XREstimatedLight(renderer);
xrLight.addEventListener('estimationstart', () => {
  scene.add(xrLight);
  scene.remove(fallbackLight);
  if (xrLight.environment) scene.environment = xrLight.environment;
});
xrLight.addEventListener('estimationend', () => {
  scene.remove(xrLight);
  scene.add(fallbackLight);
  scene.environment = null;
});

/* ------------------------------------------------------------------ */
/* Oclusión por profundidad (shader parcheado)                         */
/* Requiere depth-sensing 'gpu-optimized'. Si no está, no se aplica.   */
/* ------------------------------------------------------------------ */
const depthUniforms = {
  uDepthTex: { value: null as WebGLTexture | null },
  uRawToMeters: { value: 1.0 },
  uUvTransform: { value: new THREE.Matrix4() },
  uHasDepth: { value: 0 },
  uViewport: { value: new THREE.Vector2(1, 1) },
};

function conOclusion<T extends THREE.Material>(mat: T): T {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, depthUniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uDepthTex; uniform float uRawToMeters; uniform mat4 uUvTransform;
        uniform float uHasDepth; uniform vec2 uViewport;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        if (uHasDepth > 0.5) {
          vec2 uv = (uUvTransform * vec4(gl_FragCoord.xy / uViewport, 0.0, 1.0)).xy;
          vec2 la = texture2D(uDepthTex, uv).ra;            // luminance-alpha
          float realM = (la.x + la.y * 256.0) * 255.0 * uRawToMeters;
          // distancia del fragmento a la cámara aproximada con gl_FragCoord.z lineal
          float fragM = length(vViewPosition);
          if (realM > 0.0 && realM < fragM - 0.03) discard;   // algo real está delante
        }`);
  };
  return mat;
}

/* ------------------------------------------------------------------ */
/* Panel holográfico: foto + marco + capa temporal                     */
/* ------------------------------------------------------------------ */
async function crearPanel(e: Escena): Promise<THREE.Group> {
  const tex = await loader.loadAsync(`${import.meta.env.BASE_URL}fotos/${e.archivo}`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  const alto = 0.6, ancho = alto * e.aspecto;
  const g = new THREE.Group();

  const foto = new THREE.Mesh(
    new THREE.PlaneGeometry(ancho, alto),
    conOclusion(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0, transparent: true }))
  );
  foto.name = 'foto';
  g.add(foto);

  // Marco con leve reflejo ambiental (usa scene.environment estimado)
  const marco = new THREE.Mesh(
    new THREE.BoxGeometry(ancho + 0.03, alto + 0.03, 0.012),
    conOclusion(new THREE.MeshStandardMaterial({ color: 0xd8c9a8, roughness: 0.35, metalness: 0.6 }))
  );
  marco.position.z = -0.008;
  g.add(marco);

  g.userData = { escena: e, tex };

  if (e.audio) {
    const snd = new THREE.PositionalAudio(listener);
    new THREE.AudioLoader().load(`${import.meta.env.BASE_URL}audio/${e.audio}`, (buf) => {
      snd.setBuffer(buf); snd.setLoop(true); snd.setRefDistance(0.5); snd.setRolloffFactor(1.5);
      snd.panner.panningModel = 'HRTF';
      snd.play();
    });
    g.add(snd);
  }
  return g;
}

async function colocarEscena(idx: number, matrix?: THREE.Matrix4) {
  currentIndex = (idx + ESCENAS.length) % ESCENAS.length;
  const prev = panel?.matrix.clone();
  if (panel) { scene.remove(panel); (panel.userData.tex as THREE.Texture).dispose(); }
  panel = await crearPanel(ESCENAS[currentIndex]);
  const m = matrix ?? prev;
  if (m) {
    panel.matrixAutoUpdate = false;
    panel.matrix.copy(m);
    // levantar a 1.2 m sobre el piso y girar hacia el usuario
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    p.y += 1.2;
    const dir = new THREE.Vector3().subVectors(camera.position, p).setY(0).normalize();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    panel.matrix.compose(p, q, s);
  }
  scene.add(panel);
  actualizarFicha();
}

/* ------------------------------------------------------------------ */
/* Interacción: tap = colocar / siguiente; gaze dwell = ficha          */
/* ------------------------------------------------------------------ */
let gazeTime = 0;
function actualizarGaze(dt: number) {
  if (!panel) return;
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hit = raycaster.intersectObject(panel, true)[0];
  gazeTime = hit ? gazeTime + dt : 0;
  document.getElementById('ficha')?.classList.toggle('visible', gazeTime > 0.8);
}

function actualizarFicha() {
  const e = ESCENAS[currentIndex];
  const ficha = document.getElementById('ficha');
  if (ficha) ficha.innerHTML = `<h2>${e.titulo}</h2><p>${e.descripcion}</p>
    <small>${currentIndex + 1} / ${ESCENAS.length}</small>`;
}

// Pinza en headsets con seguimiento de manos
function detectarPinza(frame: XRFrame, refSpace: XRReferenceSpace): boolean {
  const session = frame.session;
  for (const src of session.inputSources) {
    if (!src.hand) continue;
    const thumb = frame.getJointPose(src.hand.get('thumb-tip')!, refSpace);
    const index = frame.getJointPose(src.hand.get('index-finger-tip')!, refSpace);
    if (thumb && index) {
      const a = thumb.transform.position, b = index.transform.position;
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.015) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Sesión y bucle                                                      */
/* ------------------------------------------------------------------ */
async function iniciarAR() {
  const fallback = document.getElementById('fallback')!;
  const mostrarError = (msg: string) => { fallback.hidden = false; fallback.textContent = msg; };

  if (!navigator.xr) {
    mostrarError('Este navegador no tiene WebXR. Usá Chrome en Android con ARCore (Servicios de Google Play para RA).');
    return;
  }

  // Intentos de más a menos funciones, por si el equipo no soporta alguna.
  const intentos: XRSessionInit[] = [
    {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['local-floor', 'depth-sensing', 'light-estimation', 'anchors', 'dom-overlay'],
      depthSensing: { usagePreference: ['gpu-optimized'], dataFormatPreference: ['luminance-alpha'] },
      domOverlay: { root: document.getElementById('ui')! },
    } as XRSessionInit,
    { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay'],
      domOverlay: { root: document.getElementById('ui')! } } as XRSessionInit,
    { requiredFeatures: ['hit-test'] },
  ];

  let session: XRSession | null = null;
  let ultimoError: unknown = null;
  for (const init of intentos) {
    try { session = await navigator.xr.requestSession('immersive-ar', init); break; }
    catch (err) { ultimoError = err; }
  }
  if (!session) {
    mostrarError('No se pudo iniciar la RA: ' + (ultimoError as Error)?.message);
    return;
  }

  try {
    await renderer.xr.setSession(session);   // esperar: prepara el contexto para XR
  } catch (err) {
    mostrarError('Error al preparar el render XR: ' + (err as Error).message);
    return;
  }
  const gl = renderer.getContext() as WebGL2RenderingContext;
  let glBinding: XRWebGLBinding | null = null;
  try { glBinding = new XRWebGLBinding(session, gl); } catch { /* sin oclusión */ }

  session.addEventListener('select', async () => {
    if (reticle.visible) await colocarEscena(panel ? currentIndex + 1 : 0, reticle.matrix);
    else if (panel) await colocarEscena(currentIndex + 1);
  });
  session.addEventListener('end', () => { hitTestSource = null; hitTestRequested = false; });

  let last = 0;
  renderer.setAnimationLoop(async (t, frame) => {
    const dt = (t - last) / 1000; last = t;
    if (frame) {
      const refSpace = renderer.xr.getReferenceSpace()!;

      // Hit test sobre superficies reales
      if (!hitTestRequested) {
        const viewer = await session.requestReferenceSpace('viewer');
        hitTestSource = (await session.requestHitTestSource!({ space: viewer })) ?? null;
        hitTestRequested = true;
      }
      if (hitTestSource) {
        const hits = frame.getHitTestResults(hitTestSource);
        if (hits.length) {
          reticle.visible = true;
          reticle.matrix.fromArray(hits[0].getPose(refSpace)!.transform.matrix);
        } else reticle.visible = false;
      }

      // Profundidad para oclusión
      const pose = frame.getViewerPose(refSpace);
      if (pose && glBinding && (glBinding as any).getDepthInformation && session!.depthUsage) {
        const depth = (glBinding as any).getDepthInformation(pose.views[0]);
        if (depth) {
          depthUniforms.uDepthTex.value = depth.texture;
          depthUniforms.uRawToMeters.value = depth.rawValueToMeters;
          depthUniforms.uUvTransform.value.fromArray(depth.normDepthBufferFromNormView.matrix);
          depthUniforms.uViewport.value.set(gl.drawingBufferWidth, gl.drawingBufferHeight);
          depthUniforms.uHasDepth.value = 1;
        }
      }

      if (detectarPinza(frame, refSpace)) { /* avanzar escena con debounce */ }
    }
    actualizarGaze(dt);
    renderer.render(scene, camera);
  });
}

document.getElementById('btn-ar')!.addEventListener('click', iniciarAR);

// Capa temporal: opacidad de la foto sobre el mundo real (útil para comparar con el lugar actual)
(document.getElementById('capa') as HTMLInputElement)?.addEventListener('input', (ev) => {
  const v = Number((ev.target as HTMLInputElement).value);
  const foto = panel?.getObjectByName('foto') as THREE.Mesh | undefined;
  if (foto) (foto.material as THREE.MeshStandardMaterial).opacity = v;
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
