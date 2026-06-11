// server/physics.js
// physics.ts'in CommonJS (Node) ikizi. Sunucu bunu require eder.
// physics.ts ile BIREBIR ayni mantik - birini degistirince digerini de guncelle.

const PLAYER_RADIUS = 22;
const BALL_RADIUS = 12;
const POST_RADIUS = 2;
const PLAYER_SPEED = 0.29;
const PLAYER_FRICTION = 0.89;
const BALL_FRICTION = 0.985;
const KICK_POWER = 8;
const COLLISION_RESTITUTION = 0.7;
const GOAL_INNER_DEPTH = PLAYER_RADIUS * 2 + 8; // 52

function applyMoveNormalized(body, dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    body.vx += (dx / len) * PLAYER_SPEED;
    body.vy += (dy / len) * PLAYER_SPEED;
  }
}

function kickSet(kicker, ball) {
  const dx = ball.x - kicker.x;
  const dy = ball.y - kicker.y;
  const dist = Math.hypot(dx, dy);
  if (dist > 0 && dist < PLAYER_RADIUS + BALL_RADIUS + 8) {
    ball.vx = (dx / dist) * KICK_POWER;
    ball.vy = (dy / dist) * KICK_POWER;
    return true;
  }
  return false;
}

function integrate(body) {
  body.x += body.vx;
  body.y += body.vy;
}
function applyFriction(body, friction) {
  body.vx *= friction;
  body.vy *= friction;
}

function buildGoalPosts(field) {
  const posts = [];
  if (field.goalOnSides) {
    const yMin = (field.h - field.goalSize) / 2;
    const yMax = (field.h + field.goalSize) / 2;
    posts.push({ x: 0, y: yMin }, { x: 0, y: yMax });
    posts.push({ x: field.w, y: yMin }, { x: field.w, y: yMax });
  } else {
    const xMin = (field.w - field.goalSize) / 2;
    const xMax = (field.w + field.goalSize) / 2;
    posts.push({ x: xMin, y: 0 }, { x: xMax, y: 0 });
    posts.push({ x: xMin, y: field.h }, { x: xMax, y: field.h });
  }
  return posts;
}

function collideWithPosts(obj, r, posts) {
  let reflected = false;
  for (const post of posts) {
    const dx = obj.x - post.x;
    const dy = obj.y - post.y;
    const dist = Math.hypot(dx, dy);
    const minDist = r + POST_RADIUS;
    if (dist > 0 && dist < minDist) {
      const overlap = minDist - dist;
      const nx = dx / dist;
      const ny = dy / dist;
      obj.x += nx * overlap;
      obj.y += ny * overlap;
      const vDotN = obj.vx * nx + obj.vy * ny;
      if (vDotN < 0) {
        obj.vx -= 2 * vDotN * nx * COLLISION_RESTITUTION;
        obj.vy -= 2 * vDotN * ny * COLLISION_RESTITUTION;
        reflected = true;
      }
    }
  }
  return reflected;
}

function clampToField(obj, r, field) {
  const { w, h, goalSize, goalOnSides } = field;
  if (goalOnSides) {
    const yMin = (h - goalSize) / 2;
    const yMax = (h + goalSize) / 2;
    const inLane = (obj.y - r) >= yMin && (obj.y + r) <= yMax;
    if (inLane) {
      if (obj.y < yMin + r) { obj.y = yMin + r; obj.vy *= -COLLISION_RESTITUTION; }
      if (obj.y > yMax - r) { obj.y = yMax - r; obj.vy *= -COLLISION_RESTITUTION; }
    } else {
      if (obj.y < r) { obj.y = r; obj.vy *= -COLLISION_RESTITUTION; }
      if (obj.y > h - r) { obj.y = h - r; obj.vy *= -COLLISION_RESTITUTION; }
    }
    if (!inLane) {
      if (obj.x < r) { obj.x = r; obj.vx *= -COLLISION_RESTITUTION; }
      if (obj.x > w - r) { obj.x = w - r; obj.vx *= -COLLISION_RESTITUTION; }
    } else {
      if (obj.x < -GOAL_INNER_DEPTH + r) { obj.x = -GOAL_INNER_DEPTH + r; obj.vx *= -COLLISION_RESTITUTION; }
      if (obj.x > w + GOAL_INNER_DEPTH - r) { obj.x = w + GOAL_INNER_DEPTH - r; obj.vx *= -COLLISION_RESTITUTION; }
    }
  } else {
    const xMin = (w - goalSize) / 2;
    const xMax = (w + goalSize) / 2;
    const inLane = (obj.x - r) >= xMin && (obj.x + r) <= xMax;
    if (inLane) {
      if (obj.x < xMin + r) { obj.x = xMin + r; obj.vx *= -COLLISION_RESTITUTION; }
      if (obj.x > xMax - r) { obj.x = xMax - r; obj.vx *= -COLLISION_RESTITUTION; }
    } else {
      if (obj.x < r) { obj.x = r; obj.vx *= -COLLISION_RESTITUTION; }
      if (obj.x > w - r) { obj.x = w - r; obj.vx *= -COLLISION_RESTITUTION; }
    }
    if (!inLane) {
      if (obj.y < r) { obj.y = r; obj.vy *= -COLLISION_RESTITUTION; }
      if (obj.y > h - r) { obj.y = h - r; obj.vy *= -COLLISION_RESTITUTION; }
    } else {
      if (obj.y < -GOAL_INNER_DEPTH + r) { obj.y = -GOAL_INNER_DEPTH + r; obj.vy *= -COLLISION_RESTITUTION; }
      if (obj.y > h + GOAL_INNER_DEPTH - r) { obj.y = h + GOAL_INNER_DEPTH - r; obj.vy *= -COLLISION_RESTITUTION; }
    }
  }
}

function resolveCircleCollision(a, b, rA, rB) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const minDist = rA + rB;
  if (dist === 0 || dist >= minDist) return;
  const overlap = minDist - dist;
  const nx = dx / dist;
  const ny = dy / dist;
  a.x -= nx * overlap / 2;
  a.y -= ny * overlap / 2;
  b.x += nx * overlap / 2;
  b.y += ny * overlap / 2;
  const dvx = b.vx - a.vx;
  const dvy = b.vy - a.vy;
  const sep = dvx * nx + dvy * ny;
  if (sep > 0) return;
  const impulse = -(1 + COLLISION_RESTITUTION) * sep / 2;
  a.vx -= impulse * nx;
  a.vy -= impulse * ny;
  b.vx += impulse * nx;
  b.vy += impulse * ny;
}

function detectGoal(ball, field) {
  const { w, h, goalSize, goalOnSides } = field;
  if (goalOnSides) {
    const inGoalY = ball.y > (h - goalSize) / 2 && ball.y < (h + goalSize) / 2;
    if (inGoalY && ball.x < -BALL_RADIUS) return 'p1';
    if (inGoalY && ball.x > w + BALL_RADIUS) return 'p2';
  } else {
    const inGoalX = ball.x > (w - goalSize) / 2 && ball.x < (w + goalSize) / 2;
    if (inGoalX && ball.y < -BALL_RADIUS) return 'p1';
    if (inGoalX && ball.y > h + BALL_RADIUS) return 'p2';
  }
  return null;
}

// Tek frame'lik simulasyon - sunucu her tick'te bunu cagirir.
// Iki oyuncu da kickSet (simetrik/adil). Olaylari dondurur.
function simulate(state, p1, p2, field) {
  const { p1: b1, p2: b2, ball } = state;

  applyMoveNormalized(b1, p1.dx, p1.dy);
  const p1Kicked = p1.kick ? kickSet(b1, ball) : false;
  applyMoveNormalized(b2, p2.dx, p2.dy);
  const p2Kicked = p2.kick ? kickSet(b2, ball) : false;

  integrate(b1); integrate(b2); integrate(ball);
  applyFriction(b1, PLAYER_FRICTION);
  applyFriction(b2, PLAYER_FRICTION);
  applyFriction(ball, BALL_FRICTION);

  const posts = buildGoalPosts(field);
  collideWithPosts(b1, PLAYER_RADIUS, posts);
  collideWithPosts(b2, PLAYER_RADIUS, posts);
  const ballHitPost = collideWithPosts(ball, BALL_RADIUS, posts);

  clampToField(b1, PLAYER_RADIUS, field);
  clampToField(b2, PLAYER_RADIUS, field);
  clampToField(ball, BALL_RADIUS, field);

  resolveCircleCollision(b1, ball, PLAYER_RADIUS, BALL_RADIUS);
  resolveCircleCollision(b2, ball, PLAYER_RADIUS, BALL_RADIUS);
  resolveCircleCollision(b1, b2, PLAYER_RADIUS, PLAYER_RADIUS);

  const scored = detectGoal(ball, field);
  return { scored, ballHitPost, p1Kicked, p2Kicked };
}

module.exports = {
  PLAYER_RADIUS, BALL_RADIUS, POST_RADIUS, PLAYER_SPEED,
  PLAYER_FRICTION, BALL_FRICTION, KICK_POWER, COLLISION_RESTITUTION, GOAL_INNER_DEPTH,
  applyMoveNormalized, kickSet, integrate, applyFriction,
  buildGoalPosts, collideWithPosts, clampToField, resolveCircleCollision,
  detectGoal, simulate,
};
