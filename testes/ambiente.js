// Carrega os scripts do jogo no Node, do jeito que eles estão, sem mexer em
// uma linha de produção.
//
// O jogo é feito de scripts clássicos que escrevem em `window.COBRA` (não são
// módulos: precisam rodar em file://). Aqui cada teste ganha um contexto do
// `node:vm` novo em que `window` é o próprio global, e os arquivos rodam na
// mesma ordem do index.html. Como todo módulo guarda estado próprio (a Arena,
// o Game, a fila do Input), um contexto novo por teste é o que isola um teste
// do outro.
//
// O ambiente controla as duas fontes de não-determinismo do jogo:
//   - o relógio (`performance.now`), que só anda quando o teste manda;
//   - o `Math.random` do contexto, trocado por um gerador com semente.
// Não existe `document`, `localStorage` nem `AudioContext` — de propósito: o
// que depende deles não é lógica e fica fora destes testes.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RAIZ = path.join(__dirname, '..');

// Mesma ordem do index.html (§8 do ARCHITECTURE.md).
const ORDEM = [
  'js/core/util.js',
  'js/game/config.js',
  'js/core/audio.js',
  'js/core/input.js',
  'js/core/fx.js',
  'js/game/arena.js',
  'js/game/entities.js',
  'js/game/game.js',
];

// Gerador mulberry32: pequeno, rápido e com semente.
function gerador(semente) {
  let a = semente >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {object} [op]
 * @param {string[]} [op.modulos] quais arquivos carregar (sempre na ordem do index.html)
 * @param {number} [op.semente] semente do Math.random
 * @param {object} [op.localStorage] objeto a expor como window.localStorage
 * @param {object} [op.extras] propriedades extras no global antes de carregar
 */
function criarAmbiente(op = {}) {
  const modulos = op.modulos || ORDEM;
  let agora = 1000;

  const global = {
    console,
    performance: { now: () => agora },
  };
  global.window = global;
  if (op.localStorage !== undefined) global.localStorage = op.localStorage;
  Object.assign(global, op.extras || {});
  vm.createContext(global);

  // O util.js guarda uma referência a Math.random no carregamento
  // (`var random = M.random`). Por isso o Math.random do contexto é um
  // envelope fixo que delega para `fonte`, e trocar a fonte depois vale para
  // todo mundo, inclusive para quem guardou a referência.
  let fonte = gerador(op.semente === undefined ? 12345 : op.semente);
  vm.runInContext('Math', global).random = () => fonte();

  for (const rel of ORDEM) {
    if (!modulos.includes(rel)) continue;
    const codigo = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
    vm.runInContext(codigo, global, { filename: rel });
  }

  return {
    COBRA: global.COBRA,
    global,
    agora: () => agora,
    avancarRelogio(ms) { agora += ms; },
    /** Troca o Math.random por uma constante (útil para escolher o sorteio). */
    fixarAleatorio(v) { fonte = () => v; },
    /** Volta a um gerador com semente. */
    semear(s) { fonte = gerador(s); },
  };
}

/**
 * Ambiente pronto para testar o Game: carrega tudo menos o áudio (sem
 * AudioContext ele vira no-op de qualquer forma) e põe no lugar da UI um
 * gravador de chamadas — o Game fala com a UI por nome, em tempo de execução.
 */
function ambienteDoJogo(op = {}) {
  const amb = criarAmbiente({
    semente: op.semente,
    modulos: ORDEM.filter((m) => m !== 'js/core/audio.js'),
  });
  const chamadas = [];
  amb.COBRA.UI = new Proxy({}, {
    get(_alvo, nome) {
      return (...args) => { chamadas.push({ nome, args }); };
    },
  });
  amb.ui = chamadas;
  amb.chamadasDe = (nome) => chamadas.filter((c) => c.nome === nome);
  return amb;
}

module.exports = { criarAmbiente, ambienteDoJogo, ORDEM, gerador };
