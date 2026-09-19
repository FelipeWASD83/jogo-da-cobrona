// Testes de js/game/arena.js (COBRA.Arena): muros por setor, portais e as
// garantias que evitam morte injusta.
// Rodar na pasta do projeto com:  node --test
//
// A geração é aleatória, então as garantias são conferidas sobre muitas
// sementes e vários setores. Tudo é determinístico: a mesma semente sempre
// gera a mesma arena.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarAmbiente } = require('./ambiente.js');

const MODULOS = ['js/core/util.js', 'js/game/config.js', 'js/game/arena.js'];
const SEMENTES = 40;
const SETORES = [1, 2, 3, 4, 5, 6, 8, 12];

/** Mesmas células protegidas que o Game manda: corpo + 3 à frente da cabeça. */
function protegidas(W, H, hx, hy, d, len) {
  const cel = [];
  for (let i = 0; i < len; i++) cel.push({ x: hx - d.x * i, y: hy - d.y * i });
  for (let i = 1; i <= 3; i++) {
    cel.push({ x: (((hx + d.x * i) % W) + W) % W, y: (((hy + d.y * i) % H) + H) % H });
  }
  return cel;
}

// Cobras de teste: a posição de largada do jogo e outras espalhadas pela
// arena, em direções diferentes (a reconstrução de setor pega a cobra em
// qualquer lugar).
const COBRAS = [
  { x: 15, y: 10, d: { x: 1, y: 0 }, len: 4 },
  { x: 4, y: 8, d: { x: 0, y: 1 }, len: 6 },
  { x: 20, y: 16, d: { x: -1, y: 0 }, len: 9 },
  { x: 8, y: 15, d: { x: 0, y: -1 }, len: 5 },
  { x: 20, y: 5, d: { x: 1, y: 0 }, len: 12 },
];

function livre(A, x, y) { return !A.isWall(x, y); }

/** Todas as células sem muro alcançáveis entre si? (BFS próprio do teste) */
function conexa(A, W, H) {
  let inicio = null, total = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (livre(A, x, y)) { total++; if (!inicio) inicio = [x, y]; }
  }
  const visto = new Set([inicio.join(',')]);
  const fila = [inicio];
  while (fila.length) {
    const [x, y] = fila.shift();
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const k = nx + ',' + ny;
      if (visto.has(k) || !livre(A, nx, ny)) continue;
      visto.add(k);
      fila.push([nx, ny]);
    }
  }
  return visto.size === total;
}

function vizinhosLivres(A, W, H, x, y) {
  let n = 0;
  for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
    if (nx >= 0 && ny >= 0 && nx < W && ny < H && livre(A, nx, ny)) n++;
  }
  return n;
}

/** Espaço que a cobra alcança a partir da ponta do trecho protegido, sem dar
    ré e sem atravessar o próprio corpo (mesma regra do ensureEscape). */
function espacoDeFuga(A, W, H, cel, limite) {
  const corpo = new Set(cel.slice(0, cel.length - 3).map((c) => c.x + ',' + c.y));
  const ponta = cel[cel.length - 1], antes = cel[cel.length - 2];
  let dx = ponta.x - antes.x, dy = ponta.y - antes.y;
  if (dx > 1) dx = -1; else if (dx < -1) dx = 1;
  if (dy > 1) dy = -1; else if (dy < -1) dy = 1;
  const visto = new Set([ponta.x + ',' + ponta.y, ...corpo]);
  const fila = [];
  for (const [sx, sy] of [[dx, dy], [dy, dx], [-dy, -dx]]) {
    const x = ponta.x + sx, y = ponta.y + sy, k = x + ',' + y;
    if (x < 0 || y < 0 || x >= W || y >= H || visto.has(k) || !livre(A, x, y)) continue;
    visto.add(k); fila.push([x, y]);
  }
  let n = 0;
  while (fila.length && n < limite) {
    const [x, y] = fila.shift();
    n++;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const k = nx + ',' + ny;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || visto.has(k) || !livre(A, nx, ny)) continue;
      visto.add(k); fila.push([nx, ny]);
    }
  }
  return n;
}

/** Roda `conferir` em todas as combinações semente x setor x cobra. */
function varrer(conferir) {
  for (let semente = 1; semente <= SEMENTES; semente++) {
    const amb = criarAmbiente({ modulos: MODULOS, semente });
    const { Arena: A, CFG } = amb.COBRA;
    for (const setor of SETORES) {
      for (const c of COBRAS) {
        const cel = protegidas(CFG.GRID_W, CFG.GRID_H, c.x, c.y, c.d, c.len);
        A.build(setor, cel);
        conferir({ A, CFG, cel, setor, semente, cobra: c });
      }
    }
  }
}

const onde = (o) => `semente ${o.semente}, setor ${o.setor}, cobra em ${o.cobra.x},${o.cobra.y}`;

/* ------------------------------------------------------------------ */

test('reset e setor 0: arena limpa, sem muro e sem portal', () => {
  const { COBRA: { Arena: A } } = criarAmbiente({ modulos: MODULOS });
  A.reset();
  assert.equal(A.wallCount(), 0);
  A.build(0, []);
  assert.equal(A.wallCount(), 0);
  assert.equal(A.walls.size, 0);
  assert.equal(A.portals.length, 0);
  assert.equal(A.isWall(5, 5), false);
  assert.equal(A.isWall(-1, 0), false, 'borda externa não é muro: quem checa é o Game');
  assert.equal(A.portalAt(5, 5), null);
});

test('setor com muros: opts pode desligar muros e portais (é o que o ZEN usa)', () => {
  const { COBRA: { Arena: A } } = criarAmbiente({ modulos: MODULOS });
  A.build(5, [], { muros: false, portais: false });
  assert.equal(A.wallCount(), 0);
  assert.equal(A.portals.length, 0);
  A.build(5, []);
  assert.ok(A.wallCount() > 0);
  assert.ok(A.portals.length > 0);
});

test('nenhuma célula protegida (cobra + 3 à frente) vira muro ou portal', () => {
  varrer((o) => {
    for (const c of o.cel) {
      assert.equal(o.A.isWall(c.x, c.y), false, 'muro na cobra — ' + onde(o));
      assert.equal(o.A.isPortal(c.x, c.y), false, 'portal na cobra — ' + onde(o));
    }
  });
});

test('densidade nunca passa de 12% da grade', () => {
  varrer((o) => {
    const cap = Math.floor(o.CFG.GRID_W * o.CFG.GRID_H * o.CFG.SECTOR_DENSITY_CAP);
    assert.ok(o.A.wallCount() <= cap, `${o.A.wallCount()} muros — ` + onde(o));
  });
});

test('setores 1 a 3 deixam 2 células livres junto da borda; do 4 em diante, 1', () => {
  varrer((o) => {
    const m = o.setor >= 4 ? 1 : 2;
    for (const w of o.A.wallList) {
      assert.ok(w.x >= m && w.y >= m && w.x <= o.CFG.GRID_W - 1 - m && w.y <= o.CFG.GRID_H - 1 - m,
        `muro em ${w.x},${w.y} — ` + onde(o));
    }
  });
});

test('wallList, walls (Set) e isWall contam a mesma história', () => {
  varrer((o) => {
    assert.equal(o.A.wallList.length, o.A.wallCount());
    assert.equal(o.A.walls.size, o.A.wallCount());
    for (const w of o.A.wallList) {
      assert.ok(o.A.walls.has(w.x + ',' + w.y));
      assert.equal(o.A.isWall(w.x, w.y), true);
    }
  });
});

test('toda célula livre é alcançável (flood-fill)', () => {
  varrer((o) => {
    assert.ok(conexa(o.A, o.CFG.GRID_W, o.CFG.GRID_H), 'arena partida — ' + onde(o));
  });
});

test('a cobra sempre tem pelo menos 6 células para fugir depois da reconstrução', () => {
  varrer((o) => {
    const n = espacoDeFuga(o.A, o.CFG.GRID_W, o.CFG.GRID_H, o.cel, 6);
    assert.ok(n >= 6, `só ${n} células de fuga — ` + onde(o));
  });
});

// O comentário de arena.js ("ESCAPABILIDADE") promete: "toda célula livre
// precisa ter PELO MENOS DOIS vizinhos livres" — sem beco sem saída, onde a
// comida pode nascer e matar sem escapatória. Quem cumpre é a passada
// openDeadEnds; o ensureEscape roda DEPOIS dela e derruba muro sem
// reconferir, então em tese poderia abrir um beco novo. Em 19/09/2026 isso
// não apareceu nem aqui nem numa varredura avulsa de 3.600 arenas com cobras
// tortas. Se um dia falhar, é bug do jogo, não do teste.
test('não existe beco sem saída (toda célula livre com 2+ vizinhos livres)', () => {
  const becos = [];
  varrer((o) => {
    for (let y = 0; y < o.CFG.GRID_H; y++) for (let x = 0; x < o.CFG.GRID_W; x++) {
      if (!livre(o.A, x, y)) continue;
      if (vizinhosLivres(o.A, o.CFG.GRID_W, o.CFG.GRID_H, x, y) < 2) becos.push(`${x},${y} (${onde(o)})`);
    }
  });
  assert.deepEqual(becos, []);
});

test('portais: pares ligados nos dois sentidos, longe um do outro e em célula livre', () => {
  varrer((o) => {
    const ps = o.A.portals;
    if (!o.CFG.sectorInfo(o.setor).portais) {
      assert.equal(ps.length, 0, onde(o));
      return;
    }
    assert.ok(ps.length > 0 && ps.length <= 4 && ps.length % 2 === 0, `${ps.length} portais — ` + onde(o));
    for (const p of ps) {
      const destino = o.A.portalAt(p.x, p.y);
      assert.deepEqual([destino.x, destino.y], [p.pair.x, p.pair.y]);
      const volta = o.A.portalAt(destino.x, destino.y);
      assert.deepEqual([volta.x, volta.y], [p.x, p.y], 'ida e volta');
      assert.ok(Math.abs(p.x - p.pair.x) + Math.abs(p.y - p.pair.y) >= 8, 'pontas a 8+ células');
      assert.equal(o.A.isWall(p.x, p.y), false);
      assert.equal(o.A.isBlocked(p.x, p.y), true, 'comida não nasce em portal');
    }
  });
});

test('setor 1 tem muros; setores 0 a 2 não têm portal; 3 em diante têm', () => {
  const { COBRA: { Arena: A, CFG } } = criarAmbiente({ modulos: MODULOS, semente: 7 });
  const cel = protegidas(CFG.GRID_W, CFG.GRID_H, 15, 10, { x: 1, y: 0 }, 4);
  A.build(1, cel);
  assert.ok(A.wallCount() > 0);
  assert.equal(A.portals.length, 0);
  A.build(3, cel);
  assert.ok(A.portals.length >= 2);
});

test('breakWall (FÚRIA) tira o muro de todas as estruturas', () => {
  const { COBRA: { Arena: A } } = criarAmbiente({ modulos: MODULOS, semente: 3 });
  A.build(4, []);
  const antes = A.wallCount();
  const w = A.wallList[0];
  const [x, y] = [w.x, w.y];
  assert.equal(A.breakWall(x, y), true);
  assert.equal(A.isWall(x, y), false);
  assert.equal(A.walls.has(x + ',' + y), false);
  assert.equal(A.wallCount(), antes - 1);
  assert.equal(A.wallList.length, antes - 1);
  assert.equal(A.breakWall(x, y), false, 'não há mais muro ali');
});
