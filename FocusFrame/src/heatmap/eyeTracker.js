// ─── MediaPipe iris eye tracker ──────────────────────────────────────
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// Iris center landmark indices in the 478-point MediaPipe Face Landmarker model.
const RIGHT_IRIS = 468;
const LEFT_IRIS  = 473;

// Eye corner / lid landmarks used to normalise iris position.
// Using iris-relative-to-eye-socket isolates pure eye rotation and gives
// ~5× more vertical sensitivity than raw absolute iris position.
//   Right eye: outer corner 33, inner corner 133, upper lid 159, lower lid 145
//   Left  eye: inner corner 362, outer corner 263, upper lid 386, lower lid 374
const R_OUTER = 33,  R_INNER = 133, R_TOP = 159, R_BOT = 145;
const L_INNER = 362, L_OUTER = 263, L_TOP = 386, L_BOT = 374;

// Module-level singletons — one tracker instance per tab.
let _faceLandmarker = null;
let _rafId          = null;
let _cameraStream   = null;
let _cameraVideo    = null;
let _calibData      = null; // null = not yet calibrated
let _bias           = { x: 0, y: 0 }; // screen-pixel bias corrected by verification pass

// ─── Init ────────────────────────────────────────────────────────────
/**
 * Start the MediaPipe iris tracker.
 * @param {function} onIris  Called each frame with { x, y } normalised iris coords (0-1).
 */
export async function initEyeTracker(onIris) {
  // Create a hidden video element just for the camera feed.
  _cameraVideo = document.createElement("video");
  _cameraVideo.setAttribute("playsinline", "");
  _cameraVideo.style.cssText =
    "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;top:-9999px;left:-9999px;";
  document.body.appendChild(_cameraVideo);

  _cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "user" },
    audio: false,
  });
  _cameraVideo.srcObject = _cameraStream;
  await new Promise((resolve) => {
    _cameraVideo.onloadedmetadata = () => {
      _cameraVideo.play().then(resolve).catch(resolve);
    };
  });

  // Load the MediaPipe WASM runtime and face landmarker model.
  // Both are fetched from the CDN so no extra Vite asset config is needed.
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm"
  );
  _faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
  });

  // rAF loop: detect landmarks on every frame and report the averaged iris position.
  let _lastTs = -1;
  function _loop() {
    _rafId = requestAnimationFrame(_loop);
    if (!_cameraVideo || _cameraVideo.readyState < 2) return;
    const ts = performance.now();
    if (ts === _lastTs) return;
    _lastTs = ts;

    const results = _faceLandmarker.detectForVideo(_cameraVideo, ts);
    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
      const lm = results.faceLandmarks[0];

      // ── Relative iris position ────────────────────────────────────
      // Instead of raw absolute position (which mixes eye rotation + head
      // movement and has tiny vertical range), we express each iris centre
      // as a fraction of the eye socket dimensions.  This isolates pure eye
      // rotation and is ~5× more sensitive on the vertical axis.
      //
      // relX ≈ -0.5…+0.5  (negative = looking left)
      // relY ≈ -0.5…+0.5  (negative = looking up)

      // Right eye
      const rEyeW = Math.abs(lm[R_OUTER].x - lm[R_INNER].x) || 1e-4;
      const rEyeH = Math.abs(lm[R_TOP].y   - lm[R_BOT].y)   || 1e-4;
      const rCx   = (lm[R_OUTER].x + lm[R_INNER].x) / 2;
      const rCy   = (lm[R_TOP].y   + lm[R_BOT].y)   / 2;
      const rRelX = (lm[RIGHT_IRIS].x - rCx) / rEyeW;
      const rRelY = (lm[RIGHT_IRIS].y - rCy) / rEyeH;

      // Left eye
      const lEyeW = Math.abs(lm[L_OUTER].x - lm[L_INNER].x) || 1e-4;
      const lEyeH = Math.abs(lm[L_TOP].y   - lm[L_BOT].y)   || 1e-4;
      const lCx   = (lm[L_OUTER].x + lm[L_INNER].x) / 2;
      const lCy   = (lm[L_TOP].y   + lm[L_BOT].y)   / 2;
      const lRelX = (lm[LEFT_IRIS].x - lCx) / lEyeW;
      const lRelY = (lm[LEFT_IRIS].y - lCy) / lEyeH;

      // Average both eyes
      // Skip blink / squint frames — eyelid height below 15 % of eye width means
      // the iris landmark is unreliable.
      const BLINK_THRESH = 0.15;
      if (rEyeH / rEyeW < BLINK_THRESH || lEyeH / lEyeW < BLINK_THRESH) return;

      const ix = (rRelX + lRelX) / 2;
      const iy = (rRelY + lRelY) / 2;
      onIris({ x: ix, y: iy });
    }
  }
  _loop();
}

// ─── Teardown ────────────────────────────────────────────────────────
export function stopEyeTracker() {
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  if (_faceLandmarker) { try { _faceLandmarker.close(); } catch (_) {} _faceLandmarker = null; }
  if (_cameraStream) { _cameraStream.getTracks().forEach(t => t.stop()); _cameraStream = null; }
  if (_cameraVideo) { _cameraVideo.srcObject = null; _cameraVideo.remove(); _cameraVideo = null; }
  _calibData = null;
  _bias = { x: 0, y: 0 };
}

// ─── Quadratic Calibration ───────────────────────────────────────────
// Maps iris relative coords → screen pixels using a 6-term 2-D polynomial:
//   screen_x = w · φ,  φ = [ix², iy², ix·iy, ix, iy, 1]
// This captures non-linear (curved) gaze-to-screen relationships that a
// plain affine 3-term model misses, especially at screen edges.
/**
 * Fit calibration.
 * @param {Array<{iris:{x,y}, screen:{x,y}}>} pairs
 */
export function fitCalibration(pairs) {
  if (pairs.length < 7) return; // need > 6 unique equations for 6 unknowns

  const N = 6;
  const AtA  = Array.from({length: N}, () => new Float64Array(N));
  const Atbx = new Float64Array(N);
  const Atby = new Float64Array(N);

  for (const { iris: { x: ix, y: iy }, screen: { x: sx, y: sy } } of pairs) {
    const row = [ix*ix, iy*iy, ix*iy, ix, iy, 1];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) AtA[r][c] += row[r] * row[c];
      Atbx[r] += row[r] * sx;
      Atby[r] += row[r] * sy;
    }
  }

  const wx = _solveLinearN(AtA, Atbx, N);
  const wy = _solveLinearN(AtA, Atby, N);
  if (wx && wy) _calibData = { wx, wy };
}

/**
 * Map normalised iris coordinates to screen pixel coordinates.
 * Returns null if not yet calibrated.
 */
export function irisToScreen(ix, iy) {
  if (!_calibData) return null;
  const { wx, wy } = _calibData;
  const phi = [ix*ix, iy*iy, ix*iy, ix, iy, 1];
  let sx = 0, sy = 0;
  for (let i = 0; i < 6; i++) { sx += wx[i] * phi[i]; sy += wy[i] * phi[i]; }
  return { x: sx + _bias.x, y: sy + _bias.y };
}

/** Reset calibration (keeps tracker running). */
export function resetCalibration() {
  _calibData = null;
  _bias = { x: 0, y: 0 };
}

/**
 * Apply a screen-pixel bias correction measured from the verification pass.
 * dx/dy are the average (actualDotScreen - modelPrediction) across all verify dots.
 */
export function applyBiasCorrection(dx, dy) {
  _bias = { x: dx, y: dy };
}

// ─── Internal helpers ────────────────────────────────────────────────
/** Solve an N×N linear system A·x = b via Gaussian elimination with partial pivoting. */
function _solveLinearN(A, b, N) {
  // Build augmented matrix [A | b] as plain arrays for manipulation
  const M = Array.from({length: N}, (_, i) => [...A[i], b[i]]);

  for (let col = 0; col < N; col++) {
    // Partial pivot
    let maxRow = col;
    for (let row = col + 1; row < N; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) return null; // singular

    for (let row = col + 1; row < N; row++) {
      const f = M[row][col] / M[col][col];
      for (let k = col; k <= N; k++) M[row][k] -= f * M[col][k];
    }
  }

  // Back substitution
  const x = new Array(N).fill(0);
  for (let i = N - 1; i >= 0; i--) {
    x[i] = M[i][N];
    for (let j = i + 1; j < N; j++) x[i] -= M[i][j] * x[j];
    x[i] /= M[i][i];
  }
  return x;
}
