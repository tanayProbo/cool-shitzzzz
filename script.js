/**
 * StarkTech Gesture Interface
 * Uses MediaPipe Hands and Three.js
 */

// --- CONFIGURATION ---
const config = {
    cameraWidth: 1280,
    cameraHeight: 720,
    detectionConfidence: 0.5, // Lowered slightly for speed
    trackingConfidence: 0.5,
    colors: {
        primary: 0x00aaff, // Cyan
        secondary: 0xff0044, // Red
        active: 0x00ff88, // Green
        wireframe: 0x0066aa
    }
};

// --- GLOBALS ---
let scene, camera, renderer;
let videoElement, videoTexture;
let handLandmarker;
let hands; // MediaPipe object
let lastVideoTime = -1;
let results = undefined;

// Scene Objects
// HandMesh logic replaced by handsPool
// let handMesh; 
// let jointMeshes = []; 
// let connectionLines = [];
let uiGroup; // Group to hold floating UI
let backgroundPlane;

// State
let isPinching = false;
let pinchDistance = 0;
let cursor = { x: 0, y: 0, z: 0 };
let activeInteractable = null;

// DOM
const loadingScreen = document.getElementById('loading');
const debugGesture = document.getElementById('gesture-display');
const fpsDisplay = document.getElementById('fps');

// Init
async function init() {
    setupThreeJS();
    await setupMediaPipe();
    setupUI();
    animate();
}

function setupThreeJS() {
    const container = document.getElementById('canvas-container');

    // Scene
    scene = new THREE.Scene();

    // Camera - Orthographic preferred for 2D UI overlay feel, or Perspective for 3D depth
    // Using Perspective to match the physical camera FOV roughly
    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.PerspectiveCamera(75, aspect, 0.1, 100);
    // Position camera deeply to fit the "screen"
    camera.position.z = 10;

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.autoClear = false; // Important for compositing if needed
    container.appendChild(renderer.domElement);

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(0, 10, 10);
    scene.add(dirLight);

    // Initialize Hand Pool (for 2 hands)
    for (let i = 0; i < 2; i++) {
        createHandVisuals(i);
    }

    // Initialize Connect Beam (Line between 2 hands)
    const beamGeo = new THREE.BufferGeometry();
    const beamMat = new THREE.LineBasicMaterial({
        color: 0xff0044,
        linewidth: 5,
        transparent: true,
        opacity: 0
    });
    beamLine = new THREE.Line(beamGeo, beamMat);
    scene.add(beamLine);

    // Initialize Motion Trail
    initTrail();
}

// Hand Visualization Pool
const handsPool = [];

function createHandVisuals(id) {
    const group = new THREE.Group();
    scene.add(group);

    const joints = [];
    const bones = [];

    // Materials
    const jointGeo = new THREE.SphereGeometry(0.15, 16, 16);
    const jointMat = new THREE.MeshStandardMaterial({
        color: config.colors.primary,
        emissive: 0x0044aa,
        roughness: 0.3,
        metalness: 0.8,
        transparent: true,
        opacity: 0.8
    });

    const boneGeo = new THREE.CylinderGeometry(0.04, 0.04, 1, 8);
    const boneMat = new THREE.MeshStandardMaterial({
        color: config.colors.wireframe,
        emissive: 0x00aaff,
        emissiveIntensity: 0.8,
        transparent: true,
        opacity: 0.7
    });

    // Joints
    for (let i = 0; i < 21; i++) {
        const mesh = new THREE.Mesh(jointGeo, jointMat.clone());
        joints.push(mesh);
        group.add(mesh);
    }

    // Bones
    const connections = [
        [0, 1], [1, 2], [2, 3], [3, 4],
        [0, 5], [5, 6], [6, 7], [7, 8],
        [0, 9], [9, 10], [10, 11], [11, 12],
        [0, 13], [13, 14], [14, 15], [15, 16],
        [0, 17], [17, 18], [18, 19], [19, 20],
        [5, 9], [9, 13], [13, 17], [0, 17]
    ];

    connections.forEach(pair => {
        const bone = new THREE.Mesh(boneGeo, boneMat.clone());
        bone.userData = { startIdx: pair[0], endIdx: pair[1] };
        bones.push(bone);
        group.add(bone);
    });

    handsPool.push({ group, joints, bones, active: false });
}

async function setupMediaPipe() {
    videoElement = document.getElementsByClassName('input_video')[0];

    hands = new Hands({
        locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
        }
    });

    hands.setOptions({
        maxNumHands: 2, // ENABLE 2 HANDS
        modelComplexity: 1,
        minDetectionConfidence: config.detectionConfidence,
        minTrackingConfidence: config.trackingConfidence
    });

    hands.onResults(onHandsResults);

    // Initialize Camera
    // We use a custom loop to sync with ThreeJS, but CameraUtils is easier for webcam handling
    const cameraUtils = new Camera(videoElement, {
        onFrame: async () => {
            await hands.send({ image: videoElement });
        },
        width: config.cameraWidth,
        height: config.cameraHeight
    });

    // Setup Background Video Plane in ThreeJS
    videoTexture = new THREE.VideoTexture(videoElement);
    const planeGeo = new THREE.PlaneGeometry(16, 9); // AR 16:9
    // Fit to view

    // Shader material for "Holographic" look or just plain video? 
    // Plain video for background, but maybe stylized
    const planeMat = new THREE.MeshBasicMaterial({ map: videoTexture });
    backgroundPlane = new THREE.Mesh(planeGeo, planeMat);
    backgroundPlane.position.z = -10; // Behind everything
    // Scale background to fill screen
    const dist = camera.position.z - backgroundPlane.position.z;
    const height = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * dist;
    const width = height * (window.innerWidth / window.innerHeight);
    backgroundPlane.scale.set(width / 16, height / 9, 1);

    scene.add(backgroundPlane);

    await cameraUtils.start();

    // Hide loader
    loadingScreen.style.opacity = '0';
    setTimeout(() => { loadingScreen.style.display = 'none'; }, 800);
}

// Global UI Elements array
const uiElements = [];

// Particle System
let particles = [];
const PARTICLE_COUNT = 100;
const particleGeo = new THREE.PlaneGeometry(0.1, 0.1);
const particleMat = new THREE.MeshBasicMaterial({
    color: 0x00ff88,
    transparent: true,
    opacity: 0.8,
    side: THREE.DoubleSide
});

function createParticles(x, y, z, count = 5) {
    for (let i = 0; i < count; i++) {
        const p = new THREE.Mesh(particleGeo, particleMat.clone());
        p.position.set(x, y, z);
        p.userData = {
            vel: {
                x: (Math.random() - 0.5) * 0.2,
                y: (Math.random() - 0.5) * 0.2,
                z: (Math.random() - 0.5) * 0.2
            },
            life: 1.0
        };
        scene.add(p);
        particles.push(p);
    }
}

function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.position.x += p.userData.vel.x;
        p.position.y += p.userData.vel.y;
        p.position.z += p.userData.vel.z;
        p.userData.life -= 0.02;
        p.material.opacity = p.userData.life;
        p.rotation.z += 0.1;

        if (p.userData.life <= 0) {
            scene.remove(p);
            particles.splice(i, 1);
        }
    }
}

// Trail System
let trailLine;
let trailPositions = [];
const TRAIL_LENGTH = 15;

function initTrail() {
    const geo = new THREE.BufferGeometry();
    const mat = new THREE.LineBasicMaterial({
        color: 0x00ff88,
        transparent: true,
        opacity: 0.6
    });
    trailLine = new THREE.Line(geo, mat);
    scene.add(trailLine);
}

function updateTrail(x, y, z) {
    trailPositions.push(new THREE.Vector3(x, y, z));
    if (trailPositions.length > TRAIL_LENGTH) {
        trailPositions.shift();
    }
    trailLine.geometry.setFromPoints(trailPositions);
}

function setupUI() {
    uiGroup = new THREE.Group();
    scene.add(uiGroup);

    // 1. ARC REACTOR (The centerpiece)
    const coreGeo = new THREE.TorusKnotGeometry(1, 0.3, 100, 16);
    const coreMat = new THREE.MeshPhongMaterial({
        color: 0x00aaff,
        emissive: 0x0044aa,
        wireframe: true
    });
    const reactor = new THREE.Mesh(coreGeo, coreMat);
    reactor.userData = {
        type: 'reactor',
        spinSpeed: 0.02
    };
    uiGroup.add(reactor);
    uiElements.push(reactor);

    // Glow Ring
    const ringGeo = new THREE.RingGeometry(1.5, 1.6, 64);
    const ringMat = new THREE.MeshBasicMaterial({
        color: 0x00ffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.5
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    reactor.add(ring);

    // 2. Floating Data Cubes (Orbiting)
    for (let i = 0; i < 4; i++) {
        const cube = new THREE.Mesh(
            new THREE.BoxGeometry(0.3, 0.3, 0.3),
            new THREE.MeshBasicMaterial({ color: 0xff0044, wireframe: true })
        );
        cube.userData = {
            type: 'orbit_bit',
            angle: (i / 4) * Math.PI * 2,
            radius: 2.5,
            speed: 0.01 + (i * 0.005)
        };
        uiGroup.add(cube);
        uiElements.push(cube);
    }
}

function createButton(text, x, y, callback) {
    // Group
    const btnGroup = new THREE.Group();
    btnGroup.position.set(x, y, 0);

    // Background
    const geo = new THREE.CircleGeometry(0.8, 32);
    const mat = new THREE.MeshBasicMaterial({
        color: config.colors.primary,
        transparent: true,
        opacity: 0.2,
        side: THREE.DoubleSide
    });
    const bg = new THREE.Mesh(geo, mat);

    // Ring
    const ringGeo = new THREE.RingGeometry(0.75, 0.8, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: config.colors.primary });
    const ring = new THREE.Mesh(ringGeo, ringMat);

    btnGroup.add(bg);
    btnGroup.add(ring);

    // Text (Simulated with sprite or just assume shape for now for speed without FontLoader)
    // For specific text, use canvas texture
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#00aaff';
    ctx.font = 'bold 30px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 64, 32);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(1.5, 0.75, 1);
    btnGroup.add(sprite);

    btnGroup.userData = {
        isInteractable: true,
        type: 'button',
        callback: callback,
        baseScale: 1,
        hoverScale: 1.1
    };

    uiGroup.add(btnGroup);
    uiElements.push(btnGroup);
}

function createSlider(x, y) {
    const group = new THREE.Group();
    group.position.set(x, y, 0);

    // Bar
    const barGeo = new THREE.PlaneGeometry(0.2, 3);
    const barMat = new THREE.MeshBasicMaterial({ color: config.colors.primary, opacity: 0.5, transparent: true });
    const bar = new THREE.Mesh(barGeo, barMat);
    group.add(bar);

    // Knob
    const knobGeo = new THREE.SphereGeometry(0.3);
    const knobMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const knob = new THREE.Mesh(knobGeo, knobMat);
    knob.position.y = -1.0; // Start bottom
    knob.userData = { id: 'knob' }; // Tag
    group.add(knob);

    group.userData = {
        isInteractable: true,
        type: 'slider',
        value: 0,
        knob: knob
    };

    uiGroup.add(group);
    uiElements.push(group);
}

let beamLine;
let prevHandDistance = 0;

function onHandsResults(res) {
    results = res;

    // Reset hands
    handsPool.forEach(h => {
        h.group.visible = false;
        h.active = false;
    });

    if (res.multiHandLandmarks && res.multiHandLandmarks.length > 0) {

        // Loop through all detected hands
        for (let i = 0; i < res.multiHandLandmarks.length; i++) {
            if (handsPool[i]) {
                updateHandMesh(handsPool[i], res.multiHandLandmarks[i]);
                handsPool[i].active = true;

                // Track cursor with First hand only for now
                if (i === 0) {
                    // Update cursor for single hand interactions
                    // (Logic inside updateHandMesh updates global 'cursor' var)
                }
            }
        }

        // Single Hand Gesture Detection
        detectGestures(res.multiHandLandmarks[0]);

        // Two Hand Gesture Detection
        if (res.multiHandLandmarks.length === 2) {
            detectTwoHandGestures(res.multiHandLandmarks);
        } else {
            // Hide beam if not 2 hands
            beamLine.material.opacity = 0;
            prevHandDistance = 0;
        }

    } else {
        isPinching = false;
        beamLine.material.opacity = 0;
    }
}

function updateHandMesh(handObj, landmarks) {
    handObj.group.visible = true;

    const dist = camera.position.z - 0;
    const vHeight = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * dist;
    const vWidth = vHeight * (window.innerWidth / window.innerHeight);

    // 1. Update Joints
    landmarks.forEach((lm, index) => {
        if (handObj.joints[index]) {
            const px = (lm.x - 0.5) * vWidth * -1;
            const py = (1 - lm.y - 0.5) * vHeight;
            const pz = -lm.z * 5;

            handObj.joints[index].position.set(px, py, pz);

            // If this is the primary hand (roughly checking by existence of cursor update logic or just overriding)
            // Ideally we track which hand is measuring cursor.
            // For now, let's say index 8 of the FIRST update call sets cursor.
            // But here we are generic.

            // We'll calculate palm center for two-hand logic later, or use Index 8
        }
    });

    // 2. Update Bones
    handObj.bones.forEach(bone => {
        const start = handObj.joints[bone.userData.startIdx].position;
        const end = handObj.joints[bone.userData.endIdx].position;

        bone.position.copy(start).lerp(end, 0.5);
        const dist = start.distanceTo(end);
        bone.scale.set(1, dist, 1);
        bone.lookAt(end);
        bone.rotateX(Math.PI / 2);
    });

    // Update Global Cursor from First Active Hand (Index 8)
    if (handObj === handsPool[0]) {
        const tip = handObj.joints[8].position;
        cursor.x = tip.x; cursor.y = tip.y; cursor.z = tip.z;
        updateTrail(tip.x, tip.y, tip.z);
    }
}

function detectTwoHandGestures(landmarksArray) {
    // Get Index tips of both hands
    // We already computed world positions in updateHandMesh, but it's cleaner to read them from the Visuals
    // since 'landmarksArray' is normalized 0-1.

    const h1 = handsPool[0].joints[8].position; // Index Tip Hand 1
    const h2 = handsPool[1].joints[8].position; // Index Tip Hand 2

    // Draw Beam
    const points = [h1, h2];
    beamLine.geometry.setFromPoints(points);
    beamLine.material.opacity = 0.8;

    const dist = h1.distanceTo(h2);

    if (prevHandDistance > 0) {
        const delta = dist - prevHandDistance;

        // RESIZE LOGIC
        // If hands move apart (delta > 0), Scale Up
        // If hands move closer (delta < 0), Scale Down

        // Threshold to avoid jitter
        if (Math.abs(delta) > 0.1) {
            const scaleFactor = 1 + delta * 0.5;

            // Apply to Reactor
            const reactor = uiElements.find(e => e.userData.type === 'reactor');
            if (reactor) {
                reactor.scale.multiplyScalar(scaleFactor);
                // Clamp
                reactor.scale.x = Math.max(0.2, Math.min(5, reactor.scale.x));
                reactor.scale.y = reactor.scale.x;
                reactor.scale.z = reactor.scale.x;

                // Feedback
                createParticles((h1.x + h2.x) / 2, (h1.y + h2.y) / 2, (h1.z + h2.z) / 2, 2);
            }
        }
    }

    prevHandDistance = dist;
}

function detectGestures(landmarks) {
    // 1. PINCH Detection (Thumb 4 and Index 8)
    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];

    // Calculate Euclidean distance in normalized space
    const d = Math.sqrt(
        Math.pow(thumbTip.x - indexTip.x, 2) +
        Math.pow(thumbTip.y - indexTip.y, 2) +
        Math.pow(thumbTip.z - indexTip.z, 2)
    );

    pinchDistance = d;
    // Threshold
    if (d < 0.05) {
        if (!isPinching) {
            isPinching = true;
            onPinchStart();
        }
    } else {
        if (isPinching) {
            isPinching = false;
            onPinchEnd();
        }
    }

    // Update debug info
    debugGesture.innerText = isPinching ? "PINCH (HOLD)" : "HOVER";
    if (isPinching) {
        debugGesture.style.color = '#00ff00';
    } else {
        debugGesture.style.color = '#fff';
    }
}

function onPinchStart() {
    // Check collision with UI
    checkInteractions(true);
}

function onPinchEnd() {
    if (activeInteractable) {
        // Release
        activeInteractable = null;
    }
}

function checkInteractions(isClick) {
    for (let el of uiElements) {
        const dx = cursor.x - el.position.x;
        const dy = cursor.y - el.position.y;
        let dist = Math.sqrt(dx * dx + dy * dy);

        if (el.userData.type === 'reactor') {
            if (dist < 1.0) {
                activeInteractable = el;
                // Interaction Feedback
                createParticles(el.position.x, el.position.y, el.position.z, 10);
                gsap.to(el.scale, { x: 1.2, y: 1.2, z: 1.2, duration: 0.2, yoyo: true, repeat: 1 });
            }
        }
    }
}

// Camera Shake
let shakeIntensity = 0;

function updateInteractions() {
    // Spin Reactor Faster if pinched
    if (activeInteractable && activeInteractable.userData.type === 'reactor') {
        activeInteractable.rotation.z += 0.2; // FAST SPIN
        activeInteractable.rotation.x += 0.1;

        // Emit Particles
        createParticles(activeInteractable.position.x, activeInteractable.position.y, activeInteractable.position.z, 2);

        // Add Shake
        shakeIntensity = 0.1;
    }
}

function animate() {
    requestAnimationFrame(animate);

    // Apply Shake
    if (shakeIntensity > 0) {
        const shakeX = (Math.random() - 0.5) * shakeIntensity;
        const shakeY = (Math.random() - 0.5) * shakeIntensity;
        camera.position.x += shakeX;
        camera.position.y += shakeY;

        // Decay
        shakeIntensity *= 0.9;
        if (shakeIntensity < 0.001) shakeIntensity = 0;
    } else {
        // Return to center (smoothly)
        camera.position.x += (0 - camera.position.x) * 0.1;
        camera.position.y += (0 - camera.position.y) * 0.1;
    }

    // Idle Animations
    uiElements.forEach(el => {
        if (el.userData.type === 'reactor') {
            el.rotation.z += el.userData.spinSpeed;
            el.rotation.y += el.userData.spinSpeed * 0.5;
        }
        if (el.userData.type === 'orbit_bit') {
            el.userData.angle += el.userData.speed;
            el.position.x = Math.cos(el.userData.angle) * el.userData.radius;
            el.position.y = Math.sin(el.userData.angle) * el.userData.radius;
            el.rotation.x += 0.05;
        }
    });

    // Handle User Interactions
    updateInteractions();

    updateParticles();

    renderer.render(scene, camera);
}

// Start
init();
