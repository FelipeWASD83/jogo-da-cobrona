# CLAUDE.md — jogo-da-cobrona

"COBRONA :: PROTOCOLO NEON": jogo da cobrinha synthwave em HTML + Canvas 2D +
Web Audio, sem dependência, sem build e sem rede. ~9 mil linhas de JS em 12
arquivos.

O `CLAUDE.md` da raiz vale aqui também. Este arquivo acrescenta o que é
específico do projeto. **Ele foi escrito em 19/09/2026 lendo o código**: o
projeto foi feito em outra máquina e as conversas que o criaram se perderam,
então o que está aqui é a memória do projeto daqui para frente. O
`ARCHITECTURE.md` é o design doc original (ele se declara "normativo"). Foi
revisado em 19/09/2026 para bater com o código; se aparecer divergência nova,
**o código é o que roda** — o histórico está na seção 7.

---

## 1. O que é, e o que não é

Snake com muita "suculência": movimento interpolado, combo com
multiplicador, três comidas, cinco power-ups, arena que muda a cada 500
pontos (muros, caçadores, portais), três modos, trilha sintetizada que cresce
com o setor, recordes no navegador.

**É um dos três snakes da pasta, e não deve virar os outros** (regra da raiz):
`jogo-da-cobrona` é o modular e cheio de sistema; `cobra-medieval` é pixel art
com fases; `cobrinha-simples` é o cru. Não portar feature entre eles.

Tudo que o jogador lê é em português. Foi pensado para abrir com dois cliques
no `index.html` (`file://`), e isso continua valendo: não trocar os scripts
por módulos ES nem usar `fetch`.

---

## 2. Como rodar e jogar

**Jeito mais simples:** dois cliques no `index.html`. Abre no navegador e
funciona offline.

**Pelo servidor** (é o que o preview do Claude Code usa — entrada `cobrona`
no `.claude/launch.json` da raiz e no do projeto, porta **8777**):

```powershell
python -m http.server 8777
```

e abrir `http://localhost:8777`.

**Controles:**

| Tecla | O que faz |
|---|---|
| setas ou WASD | vira a cobra |
| Espaço | começa (no menu), pausa e continua |
| Enter | começa (no menu), joga de novo (na tela de fim) |
| Esc | volta ao menu |
| P | pausa |
| M | liga/desliga o som (fica gravado) |
| ↑ ↓ no menu | escolhe o modo |
| celular: arrastar o dedo | vira; tocar começa/continua |
| controle (gamepad) | direcional ou analógico vira; A começa; B menu; Start pausa |

**Modos:** CLÁSSICO (a progressão inteira), CAÔS (começa no SETOR 04, tick de
105 ms, dois caçadores, pontos ×1,5) e ZEN (não morre: bater custa até 3
segmentos, nunca abaixo de 3; sem muro, portal ou caçador).

Perder o foco da janela ou trocar de aba pausa sozinho. Depois de morrer, a
tela de fim só aceita "jogar de novo" quando o slow-motion acaba.

Recordes e preferências ficam no `localStorage` do navegador:
`cobrona.recordes.v1` (top 5), `cobrona.recorde.v1` (melhor pontuação),
`cobrona.mudo.v1`, `cobrona.modo.v1` (último modo). Em `file://`, se o
navegador bloquear o `localStorage`, o jogo segue funcionando e só não
guarda nada entre sessões.

---

## 3. Arquivos

Scripts clássicos, carregados pelo `index.html` **nesta ordem**; cada um
pendura um objeto em `window.COBRA` e só lê os outros módulos dentro de
funções (nunca no topo do arquivo).

| Arquivo | Objeto | O que tem |
|---|---|---|
| `js/core/util.js` | `COBRA.Util` | matemática, sorteio, direções, `store` (localStorage à prova de bloqueio) |
| `js/game/config.js` | `COBRA.CFG` | constantes, paleta, tabelas de comida, power-up, setor, modo, juice, textos |
| `js/core/audio.js` | `COBRA.Audio` | todos os sons e a trilha de 4 camadas, sintetizados na hora |
| `js/core/input.js` | `COBRA.Input` | teclado, toque, gamepad e a fila de 2 direções |
| `js/core/fx.js` | `COBRA.FX` | partículas (900 no máximo), anéis, texto flutuante, flash, tremor, hitstop |
| `js/game/arena.js` | `COBRA.Arena` | muros de cada setor, portais, conectividade |
| `js/game/entities.js` | `COBRA.Snake`, `.Food`, `.Hunter` | as peças, sem regra de jogo |
| `js/game/game.js` | `COBRA.Game` | **toda a regra**: estados, tick, colisão, pontos, power-up, setor, morte, recordes |
| `js/render/background.js` | `COBRA.BG` | fundo: estrelas, nebulosa, grade |
| `js/render/renderer.js` | `COBRA.Renderer` | desenho do mundo com sprites pré-assados |
| `js/ui/ui.js` | `COBRA.UI` | só DOM: HUD, menu, pausa, fim de jogo, lista de recordes |
| `js/main.js` | `COBRA.Main` | boot, loop de frame, teclas → estado do jogo, tela de erro fatal |
| `css/style.css` | — | HUD, menus, efeito CRT |
| `testes/` | — | testes no Node (seção 5) |

**Quem decide o quê:** `game.js` é o único que sabe o que é pontuar, morrer
ou subir de setor. Snake/Food/Hunter/Arena só se movem e guardam estado.
`ui.js` nunca toca no canvas; `renderer.js` nunca toca no DOM. `main.js` não
tem regra: traduz tecla em `Game.start/pause/toMenu/restart` e roda o frame
(Input → Audio → FX → Game → Renderer → UI).

**Ordem dentro de um tick** (`doTick` em `game.js`), que é onde nascem os bugs
de cobrinha: direção (uma por tick) → passo → colisão com borda/muro/corpo →
caçador parado na casa de destino → comida → caçadores andam → caçador de novo
→ prazo da comida e ímã → troca de setor.

---

## 4. Onde mexer

| Quero mudar... | Onde |
|---|---|
| velocidade, tamanho da grade, tamanho inicial | `config.js`: `TICK_BASE`, `TICK_MIN`, `TICK_STEP`, `GRID_W/H`, `START_LEN` |
| pontos, crescimento e prazo das comidas, chance de cada uma | `config.js`: `CFG.FOOD` (as `chance` precisam somar 1) |
| duração dos power-ups, efeito de lento/fúria | `config.js`: `CFG.POWER`, `SLOW_*`, `FURY_*`, `MAGNET_*` |
| janela e teto do combo | `config.js`: `COMBO_MS`, `COMBO_MAX_MULT`, `COMBO_STEP` |
| o que cada setor traz (densidade de muro, caçadores, portais) | `config.js`: `CFG.SECTORS` e `sectorInfo` (do SETOR 07 em diante são gerados) |
| modos | `config.js`: `CFG.MODES` |
| tremor, hitstop, partículas por evento | `config.js`: `CFG.JUICE` |
| textos do HUD e das telas | `config.js`: `CFG.TXT` e `DEATH_TITLES`; o resto está no `index.html` |
| formato dos muros | `arena.js`: `PATTERNS` e `ORDER` |
| regra nova de jogo | `game.js`, com teste em `testes/jogo.test.js` |
| cor da grade por setor | `background.js`: `SECTOR_HUE` (o CFG não tem cor de grade) |
| visual da cobra, comida, muro, caçador | `renderer.js`: funções `bake*` e constantes do topo; nº de matizes e alpha do rastro em `CFG.SNAKE` |
| tremor, flash, tamanho dos pools do FX | `config.js`: `CFG.SHAKE`, `FLASH_FADE_MS`, `MAX_PARTICLES/RINGS/TEXTS` |
| sons e trilha | `audio.js`: `SFX.*` e `voice*`; números em `CFG.AUDIO` |
| tamanho da fila de direções, limiar do swipe | `config.js`: `INPUT_QUEUE_MAX`, `SWIPE_THRESHOLD` |
| teclas | `input.js`: `onKeyDown` |
| texto do título, dicas e rótulos do HUD | `index.html` (os `TXT.*` equivalentes do CFG não são lidos — está escrito no config) |

**Regra do `config.js` desde 19/09/2026:** todo valor ali ou é lido pelo jogo,
ou está marcado no comentário como "NÃO USADO". Número que o código precisa e
não está no CFG fica como constante local com comentário; se acrescentar um
valor no CFG, ligue o código a ele no mesmo passo — comentário prometendo
"o FX lê daqui" sem o FX ler foi exatamente o problema que existia.

Mexeu em regra ou número de jogo? Rodar `node --test` (seção 5): vários
testes conferem os valores atuais (130 ms, 10/50/25 pontos, 500 pontos por
setor). Se a mudança foi de propósito, atualizar o teste junto.

---

## 5. Testes

```powershell
node --test
```

na pasta do projeto. Sem `package.json` e sem dependência: o runner vem com o
Node (testado no Node 24.19). Em 19/09/2026: **121 testes, 121 passando,
nenhum TODO** — tem que terminar com `ℹ fail 0`. (Os três bugs que ficaram
marcados como TODO na primeira rodada foram corrigidos no mesmo dia; ver seção
8. Se um dia precisar marcar bug conhecido sem corrigir, `{ todo: 'motivo' }`
no teste: ele aparece com ⚠ e não derruba o comando.)

Como funciona, porque não é óbvio: `testes/ambiente.js` roda cada arquivo do
jogo dentro de um contexto `node:vm` em que `window` é o próprio global —
exatamente como o navegador faria com os `<script>`, sem nenhuma adaptação no
código de produção. Cada teste ganha um contexto novo (o estado dos módulos é
isolado), um relógio que só anda quando o teste manda e um `Math.random` com
semente. No teste do `Game` a UI é trocada por um gravador de chamadas e o
áudio fica de fora; no da UI, um DOM falso mínimo.

| Arquivo | Cobre |
|---|---|
| `testes/util-config.test.js` | Util (matemática, sorteio, formatação, storage com e sem localStorage) e as tabelas/fórmulas do CFG |
| `testes/entidades.test.js` | Snake (passo, ré, crescimento, borda, portal, encolher, colisão, onda, rastro), Food (prazo, piscar, ímã), Hunter (materializar, perseguir, empate, muro/portal) |
| `testes/arena.test.js` | 40 sementes × 8 setores × 5 posições de cobra: nada em cima da cobra, densidade ≤ 12%, margem da borda, arena conexa, espaço de fuga, sem beco, portais válidos |
| `testes/entrada.test.js` | fila de direções e filtro de ré, `INPUT_QUEUE_MAX` e `SWIPE_THRESHOLD` lidos do CFG, mapa de teclas, auto-repetição, swipe e tap |
| `testes/jogo.test.js` | regra inteira: tick, combo, nível, comidas, power-ups, cada tipo de morte, escudo, ZEN, fantasma, fúria, caçador, setores e o texto do banner por modo, CAÔS, recordes, "perfeito" e 27 mil ticks de partidas sorteadas conferindo invariantes a cada tick |
| `testes/ui.test.js` | lista de recordes pelo `modoId` (e registro antigo sem ele), tela de fim, HUD |
| `testes/efeitos-som.test.js` | hitstop, teto de partículas, tremor lido de `CFG.SHAKE`; áudio sem AudioContext vira no-op, BPM por nível |

**Não é testado:** desenho (renderer, background, o `draw` do FX), `main.js`,
o som saindo de verdade e o gamepad. A ligação do renderer ao CFG
(`HUE_SPRITES`, `TRAIL_ALPHA`, `PORTAL.COR`) só foi conferida carregando o jogo
no navegador (seção 9), não por teste.

---

## 6. Armadilhas do código

- **Scripts clássicos, não módulos.** `import`/`export` quebra o jogo em
  `file://`. E nenhum arquivo pode ler outro módulo no topo — só dentro de
  função —, senão a ordem de carga passa a importar.
- **`cells` e `prev` da cobra têm sempre o mesmo tamanho.** O renderer
  desenha entre `prev[i]` e `cells[i]`. Segmento novo nasce na cauda antiga
  **nos dois arrays**; wrap e portal suprimem a interpolação (inclusive por
  segmento, no tick em que cada um dá o salto).
- **Colisão que não mata "rebobina"** (escudo, ZEN, invencibilidade): o corpo
  inteiro volta para `prev`, em vez de empurrar só a cabeça. Empurrar a
  cabeça duplicava segmento.
- **No máximo 3 ticks por frame.** Um travamento longo descarta ticks em vez
  de teleportar a cobra.
- **A fila de input compara a ré com a última direção DA FILA**, não com a
  direção atual — é o que deixa "cima + esquerda" rápido virar curva em vez
  de morte.
- **O prazo da comida usa o relógio de parede** (`performance.now`), não o
  tempo de jogo. A pausa compensa (`resume` empurra `food.born`); o hitstop e
  o slow-motion, não — a dourada perde alguns ms nesses momentos.
- **`Food.moveTo` pede `settle()` nos ticks em que a comida não anda**, mas o
  `game.js` não chama. Quem segura é o renderer, que só interpola a comida no
  tick exato em que ela mudou de casa (usa `Game.tick`). Não "consertar" um
  lado sem olhar o outro.
- **A arena tem três passadas depois de gerar muro**: conectar tudo
  (flood-fill), abrir becos sem saída e garantir 6 casas de fuga para a
  cobra. Tirar qualquer uma volta a produzir morte injusta.
- **Os módulos se chamam por nome em tempo de execução e engolem erro de UI e
  de áudio** (`uiCall`, `sfx`, `music` em `game.js`). Isso é o que permite
  testar o `Game` sem DOM — e também faz um erro de digitação no nome de uma
  função de UI falhar calado.
- **Erro dentro do frame para o jogo** e mostra "FALHA NO PROTOCOLO" na tela
  (`main.js`). Tela congelada com essa mensagem = olhar o console.
- **Nenhuma tela pode depender de animação para aparecer** (`.screen.on` é
  opaca no repouso). Já aconteceu de o menu ficar invisível para sempre.
- **O alvo de toque é `#app`, não o canvas**: as telas cobrem o canvas e
  engoliriam o toque.

---

## 7. Divergências entre doc/config e código — o que foi feito

Levantadas em 19/09/2026 lendo o código e **resolvidas no mesmo dia**. Regra
seguida: **nenhum número que o jogador sente mudou de valor**. Onde o CFG e o
código discordavam, o CFG passou a ter o valor que o jogo já usava.

**Valores do `config.js` que ninguém lia:**

| Valor | O que foi feito | Por quê |
|---|---|---|
| `INPUT_QUEUE_MAX` (2) | `input.js` lê do CFG (`queueMax()`) | mesmo valor; ligar era trivial |
| `SWIPE_THRESHOLD` (24) | `input.js` lê do CFG (`swipeMin()`) | idem |
| `FLASH_FADE_MS` (180) | `fx.js` lê em `FX.reset()` | idem |
| `SHAKE.DECAY/MAX_PX/DIVISOR` (1,6 / 14 / 25) | `fx.js` lê (`shakeCfg()`) | idem |
| `MAX_RINGS` (48) | `fx.js` dimensiona o pool por ele | idem |
| `MAX_TEXTS` | **24 → 32** no CFG, e o `fx.js` passou a ler | o jogo sempre usou 32 |
| `SNAKE.HUE_SPRITES` (36), `SNAKE.TRAIL_ALPHA` (0,45) | `renderer.js` lê no `init()` | mesmo valor |
| `SNAKE.HEAD_LIGHT` (65) | **removido** | o renderer usa 58/78 na cabeça e 50/68 no corpo; ligar mudaria a cor |
| `gridLine`, `gridGlow`, `pulsa` dos setores e o matiz gerado em `sectorInfo` | **removidos** | a cor real vem de `SECTOR_HUE` em `background.js`, com cores diferentes; ligar mudaria a tela |
| `bpmFor` | **removido** | ninguém chamava; a conta é feita no `audio.js` com `CFG.AUDIO` |

Achados na mesma varredura, fora da lista original:

| Valor | O que foi feito |
|---|---|
| `COMBO_SEMITONE_CAP` (18) | `audio.js` lê (teto do tom do som de comer) |
| `PORTAL.COR` (violet) | `renderer.js` lê |
| `SHIELD_PUSHBACK` | removido — o escudo rebobina a cobra, não recua células |
| `DEATH.CHROMA_MS` | removido — duplicava `JUICE.death.chroma`, que é o lido |
| `TITLE`, `SUBTITLE`, `MODE_IDS`, `POWER.*.icone`, `AUDIO.ROOT`, `AUDIO.STEPS` e parte de `TXT` | ficaram, marcados como "NÃO USADO" no comentário (texto está no `index.html`; o chip do HUD não mostra ícone; o scheduler tem 16 passos fixos) |

**Doc × código:** o `ARCHITECTURE.md` foi corrigido para dizer o que o código
faz — escudo e ZEN rebobinam a cobra inteira; caçador nasce a ≥ 10 casas, ou
5, ou qualquer uma quando falta espaço; FÚRIA dá +25 por muro; cooldown de
portal existe mas não dispara na prática (inferência pela leitura); CAÔS
começa no índice 3 = SETOR 04 e só sobe com 2000 pontos; ZEN sem portal e com
banner "ARENA LIMPA"; `FX.burstDelay` existe e não é usado; registro de recorde
com `modoId` e as quatro chaves de storage; cor da grade em `background.js`;
laço real do `main.js`; Enter e gamepad nos controles; alvo "Linux/Firefox"
marcado como da máquina original.

---

## 8. Bugs corrigidos e o que ficou

Corrigidos em 19/09/2026 (cada um tem teste normal agora):

1. **ZEN anunciava o que não tem.** O banner da troca de setor dizia "MUROS
   INTERNOS · PORTAIS · 1 CAÇADOR" numa arena vazia. `sectorSub()` em
   `game.js` agora olha o modo (no ZEN: "ARENA LIMPA") e conta os caçadores
   por `desiredHunters()`, o mesmo número que o jogo põe na arena.
2. **`CFG.INPUT_QUEUE_MAX` e `CFG.SWIPE_THRESHOLD` eram ignorados** — ligados
   (seção 7).
3. **A lista de recordes jogava fora o `modoId`** e só mostrava o nome certo
   porque o `modo` gravado já vinha em maiúsculas. `loadScores()` em `ui.js`
   agora guarda o `modoId`; registro antigo sem ele continua mostrando o
   `modo`.

**Deixado como está, de propósito:** o "RECORDE" do HUD só muda quando a
partida acaba (ele mostra `Game.best`, gravado no `saveRecord()`), mesmo que
você já tenha passado dele no meio do jogo. É uma escolha de design plausível
— o número de cima é "o recorde a bater", e o "NOVO RECORDE!" aparece na tela
de fim. Se quiser que acompanhe ao vivo, o lugar é o `syncHUD` em `ui.js`
(mostrar `max(best, score)`); há teste em `testes/ui.test.js` que fixa o
comportamento atual e precisaria mudar junto.

O que foi conferido e **não** é problema: arena sempre conexa, sem beco sem
saída e com fuga para a cobra (40 sementes nos testes + uma varredura avulsa
de 3.600 arenas com cobras tortas, sem nenhuma falha); cobra nunca em cima de
muro, comida nunca em muro/portal/cobra e caçador nunca em muro/portal em 27
mil ticks sorteados.

---

## 9. Como verificar depois de mexer

1. `node --test` — tem que terminar com `ℹ fail 0`.
2. Subir o preview (`cobrona`, porta 8777) ou abrir o `index.html` e jogar:
   menu → CLÁSSICO → comer, pausar, morrer, ENTER de novo. Para ver setor
   alto sem jogar 5 minutos, no console da página:
   `COBRA.Game.score = 2490` e comer uma comida.
3. Console sem erro e nenhuma tela "FALHA NO PROTOCOLO".

Conferido em 19/09/2026, depois das correções: servidor na 8777 respondendo
200 para o `index.html`, o CSS e os 12 scripts, zero 404. No Chrome do MCP
`chrome-devtools`: ESPAÇO começou a partida; forçando pontos pelo console, o
CLÁSSICO subiu para o SETOR 07 com 45 muros, 4 portais e 4 caçadores
desenhados (banner "MUROS INTERNOS · PORTAIS · 4 CAÇADORES") e o ZEN subiu
para o SETOR 04 com arena vazia e banner "ARENA LIMPA"; console vazio, sem
"FALHA NO PROTOCOLO". **Não conferido nessa data:** uma partida inteira jogada
à mão, som, toque e gamepad.
