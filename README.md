# GE200 Web

Controle da pedaleira **Mooer GE200 (modelo original, 2017)** pelo navegador, sem instalar nada.
Site estático (GitHub Pages, HTTPS), interface em português, tema escuro, feito para celular.

> Projeto não oficial, sem relação com a Mooer. Use por sua conta e risco.

## Estado

| Fase | O que | Estado |
|---|---|---|
| 0 | Estudo do protocolo → [PROTOCOL.md](PROTOCOL.md) | feito |
| 1 | Página de diagnóstico (só leitura) | feito — WebHID confirmado no Windows |
| 2 | Leitura de identificação, presets e parâmetros | feito — 200 presets lidos no aparelho |
| 3 | Troca de preset (anterior/próximo/lista, confirmação, dry-run) | feito, aguardando teste no aparelho |
| 4 | Edição de parâmetros, Preset Volume, backup, dry-run | — |
| 5 | Auto-nivelador de volume (experimental) | — |
| 6 | Biblioteca/setlist offline (PWA) | — |

## Descoberta importante

A interface de controle da GE200 é **HID** (classe 3). O Chrome bloqueia interfaces HID no WebUSB,
então o transporte certo é o **WebHID**. No Windows o WebHID funciona com o driver padrão (sem admin).
No Android depende da versão do Chrome. Detalhes em [PROTOCOL.md](PROTOCOL.md#consequência-importante-para-o-navegador-).

## Desenvolvimento

```bash
npm install
npm test        # testes do protocolo (vitest)
npm run dev     # servidor local (localhost conta como contexto seguro)
npm run build   # gera dist/
```

Estrutura:
- `src/protocol/` — codificação/decodificação de frames, CRC (puro, com testes)
- `src/usb/` — transporte e diagnóstico WebUSB / WebHID
- `src/ui/` — interface e log

O deploy no GitHub Pages é automático a cada push na `main` (`.github/workflows/deploy.yml`).

## Créditos e licença

O protocolo vem do [MooerManager](https://github.com/ThijsWithaar/MooerManager), de **Thijs Withaar**,
que fez a engenharia reversa da GE200 (licença GPL-2.0). O algoritmo de CRC, as tabelas de comandos, os nomes
de amps/cabs e os formatos de dados foram portados de lá. O formato do arquivo `.mo` também usa o
[mooerMoConvert](https://github.com/sidekickDan/mooerMoConvert) de sidekickDan.

Por ser um trabalho derivado de código GPL-2.0, este projeto também é distribuído sob a **GPL-2.0** (veja [LICENSE](LICENSE)).
