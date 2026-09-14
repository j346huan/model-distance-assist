const axes = ['x', 'y', 'z'];
const cleanZero = value => Math.abs(value) < 1e-12 ? 0 : value;
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function point3(point) {
  if (!point || typeof point !== 'object') throw new TypeError('point must contain x, y, and z');
  return {x: finite(point.x, 'point.x'), y: finite(point.y, 'point.y'), z: finite(point.z, 'point.z')};
}

function halfExtents(box) {
  if (!box || typeof box !== 'object') throw new TypeError('boxCm must contain width, height, and depth');
  return ['width', 'height', 'depth'].map(key => {
    const size = finite(box[key], `boxCm.${key}`);
    if (size <= 0) throw new RangeError(`boxCm.${key} must be positive`);
    return size / 2;
  });
}

export function normalizeDegrees(angle) {
  return cleanZero(((finite(angle, 'angle') % 360) + 360) % 360);
}

export function viewBasis(mode = 'horizontal', angle = 0) {
  const radians = normalizeDegrees(angle) * Math.PI / 180;
  if (mode === 'top' || mode === 'bottom') {
    return {right: {x: 1, y: 0, z: 0}, up: {x: 0, y: 0, z: mode === 'top' ? -1 : 1}};
  }
  if (!['horizontal', 'side', 'front', 'orbit'].includes(mode)) throw new RangeError(`Unknown view mode: ${mode}`);
  return {right: {x: cleanZero(Math.cos(radians)), y: 0, z: cleanZero(-Math.sin(radians))}, up: {x: 0, y: 1, z: 0}};
}

function boundsFor(extents, basis) {
  const extent = axis => extents[0] * Math.abs(axis.x) + extents[1] * Math.abs(axis.y) + extents[2] * Math.abs(axis.z);
  const x = extent(basis.right), y = extent(basis.up);
  return {minX: -x, maxX: x, minY: -y, maxY: y, width: 2 * x, height: 2 * y};
}

export function projectedBounds(boxCm, mode = 'horizontal', angle = 0) {
  return boundsFor(halfExtents(boxCm), viewBasis(mode, angle));
}

export function measurePoint(point, boxCm, mode = 'horizontal', angle = 0) {
  const p = point3(point), basis = viewBasis(mode, angle);
  const bounds = boundsFor(halfExtents(boxCm), basis);
  const projectedPoint = {x: cleanZero(dot(p, basis.right)), y: cleanZero(dot(p, basis.up))};
  return {
    left: cleanZero(projectedPoint.x - bounds.minX),
    right: cleanZero(bounds.maxX - projectedPoint.x),
    top: cleanZero(bounds.maxY - projectedPoint.y),
    bottom: cleanZero(projectedPoint.y - bounds.minY),
    projectedPoint, bounds,
  };
}

export function centeredGridPositions(halfExtent, spacing) {
  finite(halfExtent, 'halfExtent');
  finite(spacing, 'spacing');
  if (halfExtent < 0) throw new RangeError('halfExtent must be nonnegative');
  if (spacing <= 0) throw new RangeError('spacing must be positive');
  const ratio = halfExtent / spacing;
  const count = Math.floor(ratio + Number.EPSILON * Math.max(1, ratio) * 4);
  return Array.from({length: 2 * count + 1}, (_, i) => i === count ? 0 : (i - count) * spacing);
}

function wallDistance(point, direction, sign, extents, inside) {
  let enter = -Infinity, exit = Infinity;
  for (let i = 0; i < axes.length; i++) {
    const coordinate = point[axes[i]], delta = direction[axes[i]] * sign, half = extents[i];
    if (Math.abs(delta) < 1e-12) {
      if (coordinate < -half - 1e-10 || coordinate > half + 1e-10) return null;
      continue;
    }
    const first = (-half - coordinate) / delta, second = (half - coordinate) / delta;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (enter > exit + 1e-10) return null;
  }
  return exit < -1e-10 ? null : cleanZero(Math.max(0, inside ? exit : enter));
}

export function measureWallPoint(point, boxCm, mode = 'horizontal', angle = 0) {
  const p = point3(point), extents = halfExtents(boxCm), {right, up} = viewBasis(mode, angle);
  const inside = axes.every((axis, i) => Math.abs(p[axis]) <= extents[i] + 1e-10);
  const result = {left: null, right: null, top: null, bottom: null, endpoints: {}, inside};
  for (const [side, direction, sign] of [['left', right, -1], ['right', right, 1], ['top', up, 1], ['bottom', up, -1]]) {
    const distance = wallDistance(p, direction, sign, extents, inside);
    result[side] = distance;
    result.endpoints[side] = distance === null ? null : {
      x: cleanZero(p.x + direction.x * sign * distance),
      y: cleanZero(p.y + direction.y * sign * distance),
      z: cleanZero(p.z + direction.z * sign * distance),
    };
  }
  return result;
}
