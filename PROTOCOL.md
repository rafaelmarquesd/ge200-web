# Protocolo USB da Mooer GE200 (modelo original, 2017)

Documento da Fase 0. Fonte principal: [MooerManager](https://github.com/ThijsWithaar/MooerManager)
de Thijs Withaar (GPL-2.0), commit `bf6dd4a` (28/01/2025). Arquivos lidos:
`mooer.lib/MooerParser.h`, `mooer.lib/MooerParser.cc`, `mooer.lib/UsbConnection.cc`,
`mooer.gui/MooerManager.cc`, `mooer.lua` (dissector do Wireshark) e `doc/endpoints.txt` (saída do `lsusb -v`).
Fonte secundária para o formato de preset: [mooerMoConvert](https://github.com/sidekickDan/mooerMoConvert/blob/main/mooer.php).

Legenda usada em todo o documento:

| Marca | Significado |
|---|---|
| ✅ **Confirmado** | Está no código/captura do MooerManager e é usado por ele com o aparelho real (ou verificado por mim contra uma captura real). |
| 🟡 **Provável** | Está no código, mas o próprio autor marca como incerto, ou o código não usa, ou há inconsistência. |
| ❓ **Suposição** | Dedução minha. Não enviar sem antes confirmar no aparelho. |

---

## 1. Descritores USB ✅

Fonte: `doc/endpoints.txt` (lsusb do aparelho real).

- VID:PID **0x0483:0x5703**, fabricante "MOOER", produto "GE200", USB 2.0 Full Speed, 1 configuração (valor 1), alimentado pelo barramento (500 mA).
- Dispositivo **composto**, classe 0 (definida por interface), 4 interfaces:

| Interface | Alt | Classe | Endpoints | Uso |
|---|---|---|---|---|
| 0 | 0 | 0x01 Áudio / Control | – | Controle de áudio USB (volume/mute) |
| 1 | 0/1 | 0x01 Áudio / Streaming | `0x82` IN isócrono, 276 B | Gravação: áudio **da** pedaleira para o host, 2 canais, 24 bits, 44,1 kHz |
| 2 | 0/1 | 0x01 Áudio / Streaming | `0x01` OUT isócrono, 276 B | Reprodução: áudio **do** host para a pedaleira, 2 canais, 24 bits, 44,1 kHz |
| **3** | 0 | **0x03 HID** | `0x81` IN interrupt 64 B (intervalo 10 ms), `0x02` OUT interrupt 64 B (intervalo 10 ms) | **Controle (este protocolo)** |

- O descritor de relatório HID tem 27 bytes (o lsusb não conseguiu lê-lo).
  ✅ **Confirmado no aparelho (teste da Fase 1, Windows, Chrome 157, WebHID):** uma coleção com usagePage 0x0001,
  usage 0x0000, um relatório INPUT e um OUTPUT de **64 bytes, reportId 0 (sem report ID)**,
  itens 8 bits × 64, usages 0x00010001..0x00010008, faixa lógica 0..255 (o Chrome mostra 0..-1 por sinal).
  Não é uma coleção protegida: `open()` funcionou sem driver extra e sem admin.
- ✅ Durante a escuta passiva (sem enviar nada) a pedaleira **não mandou nenhum relatório**. Isso é compatível
  com ela só começar a reportar depois do pedido de identificação.

### Consequência importante para o navegador ✅

O MooerManager usa libusb e faz `libusb_interrupt_transfer` direto nos endpoints 0x02/0x81 da interface 3.
**A interface 3 é da classe HID**, e o Chrome **proíbe** `claimInterface()` em interfaces das classes
protegidas (áudio, HID, armazenamento, vídeo...) pelo WebUSB, em todos os sistemas
(erro `SecurityError: The requested interface implements a protected class.`).
Ou seja: **pelo WebUSB não dá para controlar a GE200**. O caminho é o **WebHID**:

| Plataforma | WebUSB | WebHID |
|---|---|---|
| Chrome/Edge Windows | Abre só com driver WinUSB, e mesmo assim a interface 3 é bloqueada por ser HID | ✅ Funciona com o driver HID padrão do Windows, **sem admin** |
| Chrome Android | `open()` funciona, `claimInterface(3)` é bloqueado | Não existia até ~Chrome 153. O Chromium anunciou dev trial no 154 e lançamento no 157. A Fase 1 testa isso |
| iPhone | não existe | não existe |

Os relatórios HID têm exatamente os mesmos 64 bytes que o MooerManager envia/recebe por libusb.
Com WebHID, envio = `device.sendReport(0, pacote64)` e recepção = evento `inputreport`
(✅ sem report ID, confirmado no aparelho; 🟡 o envio ainda será testado na Fase 2).

---

## 2. Camada de pacote (relatório de 64 bytes) ✅

Fonte: `Parser::SendSplitPacket`, `Parser::SendWithHeaderAndChecksum`, `RxFrame::process`.

```
byte 0      : N = quantidade de bytes úteis que vêm a seguir (1..63)
byte 1..N   : pedaço do fluxo de frames
byte N+1..63: lixo/preenchimento (o MooerManager reaproveita o buffer e não zera; nós zeramos)
```

Um frame maior que 63 bytes é enviado em vários pacotes seguidos, cada um com seu byte N
(`SendSplitPacket`, usado nos uploads e no preset `.mo`). A recepção funciona igual: o receptor
concatena os pedaços até completar o tamanho anunciado no cabeçalho do frame.

## 3. Camada de frame ✅

```
AA 55 | LEN_LO LEN_HI | CMD | PARAMS ... | CRC_HI CRC_LO
```

- **AA 55**: preâmbulo fixo.
- **LEN**: u16 *little-endian* = 1 (o CMD) + quantidade de PARAMS. Não conta preâmbulo nem CRC.
- **CMD**: código do comando/grupo (tabelas abaixo).
- **CRC**: u16 *big-endian*, calculado sobre `LEN_LO LEN_HI CMD PARAMS...` (sem o AA 55).
  Algoritmo: CRC-16 polinômio 0x1021, valor inicial 0x0000, sem reflexão, resultado invertido (`~crc`),
  ou seja, **CRC-16/GSM**.
  ✅ Verifiquei contra um pacote real capturado que está comentado em `SendPresetChange`:
  `0B AA 55 05 00 82 00 00 00 00 E0 0B` → CRC calculado = `0xE00B` (há teste unitário disso).
- Um frame que cabe num pacote tem até 57 bytes de payload (CMD+PARAMS).

### Observação sobre a remontagem no MooerManager 🟡
`RxFrame::process` considera o frame completo quando `bytes_recebidos_após_CMD >= LEN`, mas os bytes após
o CMD são `LEN-1` de params + 2 de CRC = `LEN+1`. Na prática funciona porque os pedaços são grandes;
nossa implementação espera exatamente `4 + LEN + 2` bytes e valida o CRC.

---

## 4. Comandos host → pedaleira

| CMD | Payload (após CMD) | O que faz | Status | Escreve na memória? |
|---|---|---|---|---|
| `84` | `00 00` | Pedido de identificação. O Mooer Studio manda **duas vezes** ao conectar. | ✅ | Não |
| *(sem frame)* | pacote cru `3F 00 01 02 03 04 00 …` (63 bytes) | "Flush" que o Mooer Studio manda depois da resposta de identificação. Não é um frame AA 55. | 🟡 função desconhecida | ❓ provavelmente não |
| `E0` | `00 00 00 00 00 00 00` | Pede a lista de presets: a pedaleira responde com os 200 presets (`A5`) e mais o estado. | ✅ | Não |
| `A6` | `idx` (0..199) | Troca o preset ativo. | ✅ | Não (só muda o preset ativo) |
| `82` | `menu` (+ zeros) | Troca o menu mostrado no display. FX=1, OD=2, AMP=3, CAB=4, NS=5, EQ=6, MOD=7, System=0x0B. O MooerManager troca o menu antes de editar um bloco. | ✅ | Não |
| `90` | 12 bytes `DeviceFormat::FX` | Edita o bloco FX/COMP do preset ativo (em tempo real, sem salvar). | ✅ | Não (buffer de edição) ❓ |
| `91` | 10 bytes `OD` | DS/OD | ✅ | idem |
| `93` | 16 bytes `Amp` | AMP | ✅ | idem |
| `94` | 12 bytes `Cab` | CAB | ✅ | idem |
| `95` | 10 bytes `NS` | NS GATE | ✅ | idem |
| `96` | 22 bytes `Equalizer` | EQ | ✅ | idem |
| `97` | 14 bytes `Mod` | MOD. ⚠️ **tipo ≥ 22 trava a GE200** (comentário no código). | ✅ | idem |
| `98` | 16 bytes `Delay` | DELAY (o MooerManager não tem botão para isso; a estrutura existe). | 🟡 | idem |
| `99` | 12 bytes `Reverb` | REVERB (idem). | 🟡 | idem |
| `A8` | `A5` + nome (15 bytes) | **Salva** o preset atual na memória. ⚠️ O código ignora o índice e manda sempre `A5` no 2º byte — incoerente. | 🟡 | **SIM — permanente** |
| `83` | preset de 512 bytes (formato arquivo) | Carrega um preset `.mo` no preset ativo. | 🟡 | ❓ |
| `A1` | 10 bytes `System` | Configurações globais (nível de entrada, saídas, cab L/R, trail, looper). | 🟡 | **provavelmente sim** |
| `A3` | 7 bytes `Pedal` | Atribuição do pedal de expressão. | 🟡 | ❓ |
| `E2` | uploads de 512 B + nome | Carrega modelo de amplificador `.amp` num slot USER. | 🟡 | **SIM — flash** |
| `E1` | uploads de 512 B + nome | Carrega IR `.wav` num slot de CAB USER. | 🟡 | **SIM — flash** |
| *(control transfers na interface de áudio)* | | `LoadGNR` mexe na interface de áudio; experimental e incompleto no próprio MooerManager. | ❓ | ❓ |

Nenhum comando de firmware/atualização aparece no MooerManager. **Este projeto não vai implementar nenhum.**

### Formato dos blocos em tempo real (`DeviceFormat`) ✅
Todos os campos são **u16 big-endian**, em sequência:

| Bloco | Campos |
|---|---|
| FX `90` | enabled, type, q, position, peak, level |
| OD `91` | enabled, type, volume, tone, gain |
| AMP `93` | enabled, type, gain, bass, mid, treble, pres, mst |
| CAB `94` | enabled, type, mic, center, distance, tube |
| NS `95` | enabled, type, attack, release, thresh |
| EQ `96` | enabled, type, band[6], + 6 bytes desconhecidos |
| MOD `97` | enabled, type, rate, level, depth, p4, p5 |
| DELAY `98` | enabled, type, level, fback, time, subd, p5, p6 |
| REVERB `99` | enabled, type, preDelay, level, decay, tone |

`type` começa em 1 (o MooerManager faz `índice_da_lista + 1`). Os nomes dos parâmetros vêm do código;
🟡 nomes como `q/position/peak` do FX dependem do tipo de efeito escolhido.

---

## 5. Mensagens pedaleira → host

| CMD | Conteúdo (após CMD, sem CRC) | Status |
|---|---|---|
| `10` | resposta de identificação: `?` + versão (5 ASCII, ex. "2.0.4") + nome (11 ASCII, "MOOER_GE200") | ✅ |
| `84` | versão (5) + modelo (11) — o código chama de `PedalAssignment_Maybe` | 🟡 |
| `A5` | `idx` + preset de 512 bytes (formato arquivo, §6). 200 deles depois de `E0`. | ✅ |
| `A6` | `idx` do preset ativo (também chega quando você troca de preset **na pedaleira**) | ✅ |
| `A9` | `idx` + dados do preset ativo (o MooerManager ignora) | 🟡 |
| `90`–`99` | blocos do preset ativo, mesmo formato u16 BE da tabela acima | ✅ |
| `A1` | System (10 bytes u8) | ✅ |
| `A2` | **Volume**: 1 byte. O código chama de "global patch volume". **Não apareceu** no dump real. | 🟡 ver §7 |
| `86` | ✅ **preset ativo completo** (512 bytes, formato salvo). Visto no aparelho: idêntico ao `A5` do preset ativo. Provavelmente é o buffer de edição. | ✅ |
| `BB` | `00 00` — visto no aparelho, significado desconhecido | ❓ |
| `A9` | ✅ **enviado espontaneamente quando o preset é salvo NO APARELHO**: `idx` + 512 bytes gravados | ✅ |
| `A8` | ✅ logo depois do `A9`: `idx` + nome (14 bytes). Ex.: `A8 1C "DEE CORE RIFF"`. Indica que o 2º byte do `A8` é o **índice do preset** — o `A8 A5` fixo do MooerManager parece ser um bug dele | ✅ (recebido) |
| `A3` | atribuição do pedal de expressão (7 bytes) | ✅ |
| `A4` | Rhythm/PatchAlternate (enviado ao apertar CTRL TAP) | 🟡 |
| `82` | menu ativo no display | ✅ |
| `89` | modo do footswitch (0 normal, 1 confirmação) | ✅ |
| `E3` / `85` | nomes dos 10 amps USER / 10 cabs USER (15 bytes cada) | ✅ |
| `E1` / `E2` | confirmação de upload | ✅ |

### Sequência real observada (Fase 2, firmware 2.0.4) ✅
1. Host `84 00 00` → pedaleira `10` (`84 "2.0.4" "MOOER_GE200"`, ou seja, o 1º byte é o próprio 0x84).
2. Host `E0 00×7` (**sem o flush** — não foi necessário) → 200× `A5` em ~16 s, depois
   `90 91 93 94 95 96 97 98 99`, `A1`, `A3`, `A4`, `BB`, `A6`, `84`, `85`, `E3`, `86`, `89`, `82`.
3. Trocando de preset **no pé**, a pedaleira manda só `A6 idx` — **não** reenvia os blocos nem o `86`.
5. ✅ Mexendo num bloco **na pedaleira** (ex.: liga/desliga DELAY), ela manda o frame ao vivo daquele bloco (`98 ...`).
   Quando o host edita (`93 ...`), **não** há eco.
6. ❓ `BB`: `00 00` na maioria das leituras, `01 00` numa leitura em que o preset ativo era outro. Talvez um flag; sem significado confirmado.
4. Zero erros de CRC em 229 frames.

### Sequência de conexão usada pelo Mooer Studio (segundo o MooerManager) ✅
1. `84 00 00` (identify) duas vezes.
2. Recebe `10` (identificação).
3. Manda o "flush" cru (🟡).
4. Manda `E0` (lista de presets).
5. Recebe 200× `A5`, mais `E3`, `85`, `A6`, blocos `90..99`, `A1`, `A2`, `A3` etc. (a ordem exata não está documentada).

---

## 6. Formato do preset (512 bytes, igual ao arquivo `.mo` a partir do offset 0x200) ✅

Conferido no aparelho (dump da Fase 2): os 9 blocos salvos do preset ativo batem byte a byte com os frames ao vivo `90..99`.

| Offset | Tamanho | Campo |
|---|---|---|
| 0 | 10 | ordem dos efeitos (ex.: `01..09 00`, ou `05 01 02 03 06 07 08 09 04 00` com EQ na frente) |
| 10 | 1 | ✅ **Preset Volume (0..100) — confirmado pelo usuário comparando com o display da pedaleira.** O MooerManager chamava 10–11 de "tamanho u16 BE". No dump: 149 presets com 100, toda a série "CF DC30" com 50, outros com 75, 80, 70, 98… Falta só confirmar com o display da pedaleira. |
| 11 | 1 | ❓ 0 ou 1 (31 presets com 1), significado desconhecido |
| 12 | 16 | nome (ASCII, completado com zeros) |
| 28 | 8 | FX/COMP: type, enabled, attack, thresh, ratio, level, -, - |
| 36 | 8 | DS/OD: type, enabled, volume, tone, gain, -, -, - |
| 44 | 8 | AMP: type, enabled, gain, bass, mid, treble, pres, mst |
| 52 | 8 | CAB: type, enabled, mic, center, distance, tube, -, - ✅ |
| 60 | 8 | NS: type, enabled, attack, release, thresh, … |
| 68 | 8 | EQ: type, enabled, bandas… (valor 12 = 0 dB) |
| 76 | 8 | MOD: type, enabled, rate, level, depth, p4, -, - ✅ |
| 84 | 8 | DELAY: type, enabled, level, feedback, ?, **subd (offset 89 ✅)**, ?, ? |
| 92 | 8 | REVERB: type, enabled, pre-delay, level, decay, tone |
| 344 | 6 | 3× u16 LE (ex. 100, 600, 1250): os mesmos 3 valores aparecem em BE no fim do frame ao vivo EQ `96` — provavelmente frequências do EQ custom 🟡 |
| 350 | 2 | DELAY time, u16 **little-endian** ✅ (preset 28: 140 = campo `time` do frame `98`; depois 1249) |
| 352 | 2 | DELAY p5, u16 LE ✅ (2498 = campo `p5` do frame `98`) |
| resto | | desconhecido |

Atenção: no arquivo/preset salvo os campos são **1 byte** e a ordem é `type, enabled`;
nos blocos em tempo real (§4) são **u16 BE** e a ordem é `enabled, type`.

---

## 7. Preset Volume ✅ (leitura) / 🟡 (escrita)

**Confirmado:** o Preset Volume é o **byte 10 do preset** (0..100), conferido no display da pedaleira. A mensagem `A2` não
aparece. Escrita (Fase 4, experimental): o app manda `83` + os 512 bytes do preset ativo (vindos do `86` ou do `A5`)
com só o byte 10 alterado, o que carrega no buffer de edição sem salvar. O usuário salva no botão da pedaleira,
e o app relê e compara com o backup. **O `A8` continua sem ser enviado.**

✅ Teste completo no aparelho (0.4.1): `83` com volume 100 → usuário salvou na pedaleira (`A9`/`A8 1C` recebidos)
→ releitura e comparação com o backup: única diferença "VOLUME 95→100". Trocar de preset no pé descarta o buffer.

✅ Teste no aparelho (0.4.0): depois do `83` com volume 95, a releitura trouxe `86` (buffer) com volume 95 e `A5`
(memória) com 100 — o comando foi aceito e não grava sozinho. Depois, descobrir
como escrever: (a) mandar o preset inteiro com `83` + salvar com `A8`, ou (b) algum comando direto. Nada disso será
enviado sem backup e confirmação.

Texto original da Fase 0. **Não está claro no MooerManager.** O que existe:
- Mensagem recebida `A2` com 1 byte, chamada de "The global patch volume". O MooerManager só lê e repassa via MIDI CC 7; **não há comando de envio**.
- Nenhum campo do preset de 512 bytes foi identificado como volume.

Hipóteses (a confirmar na Fase 2, só com leitura):
1. `A2` é o volume do preset ativo (o knob/menu de volume do patch na GE200). Se for, ele deve mudar quando você trocar de preset ou mexer no volume do patch na pedaleira, e a página vai mostrar.
2. O volume fica em algum offset desconhecido dos 512 bytes do preset. Plano: ler os 200 presets, mudar o volume de **um** preset na própria pedaleira, ler de novo e comparar (diff).
3. ❓ Escrever seria `AA 55 02 00 A2 <vol> CRC`. **Não será enviado** até as hipóteses 1/2 serem confirmadas.

---

## 8. Troca de preset (Fase 3) ✅
`A6 idx` enviado pelo app troca o preset (testado no aparelho). A pedaleira **não responde** com eco `A6`
quando a troca vem do host; só manda `A6` quando a troca é feita no pé.

## 9. Regras deste projeto para comandos

- Só leitura sem confirmação: `84`, `E0`.
- Escrita volátil, com confirmação na 1ª vez de cada tipo: `A6` (troca de preset), `82` + `90..97` (edição de blocos, igual ao MooerManager).
- `98`/`99` (DELAY/REVERB): **experimentais** (pedido do usuário). Mesmo formato u16 BE que a pedaleira manda,
  menu `82 08`/`82 09` por analogia (FX=1..MOD=7). Confirmação própria. **O tipo não pode mudar** até sabermos
  quantos tipos existem (tipo inválido trava a pedaleira no MOD).
- `83` (preset inteiro no buffer): só para o Preset Volume, exige backup da sessão e confirmação a cada envio.
- `A8` (salvar): **não enviado** (o 2º byte fixo `A5` pode ser o slot 166). Salvar = botão da própria pedaleira.
- **Nunca implementados**: `E1`, `E2`, `A1`, `A3`, control transfers de áudio, qualquer coisa de firmware, e o "flush".
