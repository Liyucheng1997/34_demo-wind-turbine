/**
 * turbine.js — 用 Three.js 构建一台风力发电机的 3D 模型
 * ------------------------------------------------------------
 * 结构层级（便于动画控制）：
 *   group (整机，立在地面)
 *     └ tower            塔筒（固定）
 *     └ yaw              偏航平台（绕竖直 Y 轴旋转 → 对风/偏航）
 *         └ nacelle      机舱（装发电机）
 *         └ rotor        叶轮（绕水平轴自转）
 *             └ hub + 3×blade
 */
import * as THREE from 'three';

export function createTurbine() {
  const group = new THREE.Group();

  // ---- 塔筒 ----
  const towerH = 80;
  const tower = new THREE.Mesh(
    new THREE.CylinderGeometry(2.2, 3.5, towerH, 24),
    new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.6, metalness: 0.1 })
  );
  tower.position.y = towerH / 2;
  tower.castShadow = true;
  group.add(tower);

  // ---- 偏航平台（机舱+叶轮挂在这里，整体绕 Y 轴转）----
  const yaw = new THREE.Group();
  yaw.position.y = towerH;
  group.add(yaw);

  // ---- 机舱 ----
  const nacelle = new THREE.Mesh(
    new THREE.BoxGeometry(14, 6, 6),
    new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.5, metalness: 0.2 })
  );
  nacelle.position.set(-1, 0, 0);
  nacelle.castShadow = true;
  yaw.add(nacelle);

  // 机舱尾部风向标（小尾翼，帮助直观看出朝向）
  const vane = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 3, 5),
    new THREE.MeshStandardMaterial({ color: 0x4aa8ff, roughness: 0.4 })
  );
  vane.position.set(-8.5, 1.5, 0);
  yaw.add(vane);

  // ---- 叶轮（rotor）：朝 +X 方向（机舱迎风面）----
  const rotor = new THREE.Group();
  rotor.position.set(6.5, 0, 0);
  yaw.add(rotor);

  // 轮毂
  const hub = new THREE.Mesh(
    new THREE.SphereGeometry(1.8, 24, 16),
    new THREE.MeshStandardMaterial({ color: 0xe8edf2, roughness: 0.4, metalness: 0.2 })
  );
  rotor.add(hub);

  // 整流罩（鼻锥）
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(1.8, 3, 24),
    new THREE.MeshStandardMaterial({ color: 0xcdd6e0, roughness: 0.4 })
  );
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 1.5;
  rotor.add(nose);

  // ---- 三只叶片，互成 120° ----
  const bladeLen = 44;
  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0xfbfdff, roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide,
  });
  for (let i = 0; i < 3; i++) {
    const blade = createBlade(bladeLen, bladeMat);
    // 叶片在叶轮平面内（YZ 平面）按 120° 排布，绕 X 轴旋转
    blade.rotation.x = (i * 2 * Math.PI) / 3;
    rotor.add(blade);
  }

  return { group, yaw, rotor, towerH, bladeLen, rotorRadius: bladeLen };
}

/** 构建一片有锥度和扭角感的叶片（沿 +Y 伸出，根部在轮毂处） */
function createBlade(len, material) {
  const blade = new THREE.Group();

  // 用锥形几何近似：根部宽、叶尖细
  const root = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.3, 4, 12),
    material
  );
  root.position.y = 2;
  blade.add(root);

  // 主体：拉长的扁平体（带轻微扭角）
  const main = new THREE.Mesh(
    new THREE.BoxGeometry(0.35, len - 4, 2.6, 1, 6, 1),
    material
  );
  main.position.y = (len - 4) / 2 + 4;
  // 沿展向施加扭角，叶尖更“平”
  const pos = main.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = (y + (len - 4) / 2) / (len - 4); // 0(根)→1(尖)
    const twist = (1 - t) * 0.5;               // 根部扭角大
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setX(i, x * Math.cos(twist) - z * Math.sin(twist));
    pos.setZ(i, x * Math.sin(twist) + z * Math.cos(twist));
  }
  pos.needsUpdate = true;
  main.geometry.computeVertexNormals();
  main.castShadow = true;
  blade.add(main);

  return blade;
}
