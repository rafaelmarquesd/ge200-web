/** Explicações em português para os erros típicos de WebUSB/WebHID. */

import type { EnvInfo } from './env';

export function errText(e: unknown): string {
  if (e instanceof DOMException) return `${e.name}: ${e.message}`;
  if (e instanceof Error) return `${e.name}: ${e.message}${e.stack ? '\n' + e.stack : ''}`;
  return String(e);
}

export function explainError(step: string, e: unknown, env: EnvInfo): string | null {
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  const msg = (e instanceof Error || e instanceof DOMException ? e.message : String(e)).toLowerCase();

  if (name === 'NotFoundError' && step === 'requestDevice') {
    return 'Nenhum dispositivo foi escolhido. Ou você fechou a janela, ou a GE200 não apareceu na lista. ' +
      'Se não apareceu: confira o cabo (no celular, precisa ser OTG), ligue a pedaleira e tente de novo.';
  }
  if (msg.includes('protected class')) {
    return 'O Chrome bloqueou esta interface porque ela é de uma "classe protegida" (HID, áudio, armazenamento...). ' +
      'A interface de controle da GE200 (nº 3) é HID, então pelo WebUSB ela nunca pode ser usada, em nenhum sistema. ' +
      'O caminho certo é o WebHID (botão "Conectar via WebHID"), quando o navegador tiver.';
  }
  if (name === 'SecurityError' && step === 'requestDevice') {
    return 'O navegador recusou o acesso. Normalmente é por falta de HTTPS, por a página estar dentro de um iframe sem permissão, ' +
      'ou por uma política da empresa que bloqueia WebUSB/WebHID (comum em PCs corporativos).';
  }
  if (env.os === 'windows' && (step === 'open' || step === 'claimInterface' || step === 'selectConfiguration')) {
    if (name === 'NetworkError' || name === 'SecurityError' || msg.includes('access denied') || msg.includes('unable to claim')) {
      return 'No Windows, o WebUSB só consegue usar um dispositivo (ou uma interface dele) se o driver dele for o WinUSB. ' +
        'A GE200 usa os drivers padrão do Windows (áudio USB e HID), e trocar para WinUSB exige administrador (ex.: Zadig). ' +
        'Não precisa: no Windows use o WebHID, que funciona com o driver HID padrão, sem instalar nada.';
    }
  }
  if (env.os === 'android' && step === 'open' && (name === 'SecurityError' || msg.includes('access denied'))) {
    return 'O Android negou o acesso. Quando aparecer a pergunta "Permitir que o Chrome acesse GE200?", toque em OK. ' +
      'Se não aparecer, desconecte e reconecte o cabo OTG e tente de novo.';
  }
  if (name === 'InvalidStateError') {
    return 'O dispositivo está num estado inesperado (talvez já aberto em outra aba, ou foi desconectado). Feche outras abas desta página e reconecte o cabo.';
  }
  if (name === 'NotAllowedError' && step === 'open') {
    return 'O navegador não permitiu abrir o dispositivo. Pode ser que outro programa (ex.: Mooer Studio) esteja usando a pedaleira, ou uma política do sistema bloqueia.';
  }
  return null;
}
