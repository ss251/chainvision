import { renderLensPage } from '@chainvision/shared';
import { GlassesController } from './controller.js';

const pairCodeEl = document.getElementById('pair-code')!;
const connStatusEl = document.getElementById('conn-status')!;
const lensPreviewEl = document.getElementById('lens-preview')!;
const voiceInput = document.getElementById('voice-input') as HTMLInputElement;

function copyTextFallback(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', 'true');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
}

const controller = new GlassesController((state, session, status) => {
  pairCodeEl.textContent = session?.code ?? state.pairingCode ?? '------';
  connStatusEl.textContent = `${status}${session?.pairedAt ? ' · PAIRED' : ' · UNPAIRED'}`;
  const layout = renderLensPage(state);
  const text = layout.textObject.map((c) => c.content).filter(Boolean).join('\n---\n');
  lensPreviewEl.textContent =
    layout.mode === 'idle'
      ? '[BLANK IDLE LENS · 0 LIT CHARACTERS · WATCHING TESTNETS]'
      : text;
});

document.getElementById('copy-code')?.addEventListener('click', () => {
  const code = pairCodeEl.textContent?.trim() ?? '';
  if (code && code !== '------') {
    copyTextFallback(code);
    connStatusEl.textContent = `Copied pairing code ${code}`;
  }
});

document.getElementById('btn-sync')?.addEventListener('click', () => {
  void controller.syncNow();
});

document.getElementById('btn-positions')?.addEventListener('click', () => {
  void controller.cyclePositions();
});

document.getElementById('btn-blank')?.addEventListener('click', () => {
  void controller.dismissToBlank();
});

document.getElementById('btn-voice')?.addEventListener('click', () => {
  const phrase = voiceInput.value.trim();
  if (phrase) {
    void controller.sendVoiceText(phrase);
  }
});

void controller.init();
