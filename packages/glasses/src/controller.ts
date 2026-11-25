import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import {
  renderLensPage,
  validateLensLayout,
  type LensPageLayout,
  type LensViewState,
  type PairingSession,
  type WsServerMessage,
} from '@chainvision/shared';

// The one place the backend origin is set; app.json's network whitelist must list the same origin.
const BACKEND_ORIGIN: string = import.meta.env.VITE_CHAINVISION_BACKEND;
const WS_URL = `${BACKEND_ORIGIN.replace(/^http/, 'ws')}/ws`;
const STORAGE_KEY = 'chainvision_state_v1';
const SWIPE_DEBOUNCE_MS = 650;
const TAP_LOCKOUT_MS = 1500;

export class GlassesController {
  private bridge: EvenAppBridge | null = null;
  private ws: WebSocket | null = null;
  private startupCreated = false;
  private lastLayout: LensPageLayout | null = null;
  private state: LensViewState = { mode: 'idle', paired: false };
  private session: PairingSession | null = null;

  private isRecording = false;
  private pcmChunks: Uint8Array[] = [];
  private lastSwipeAt = 0;
  private lastTapAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onUiUpdate: (state: LensViewState, session: PairingSession | null, status: string) => void;

  constructor(
    onUiUpdate: (state: LensViewState, session: PairingSession | null, status: string) => void,
  ) {
    this.onUiUpdate = onUiUpdate;
  }

  async init(): Promise<void> {
    this.bridge = await waitForEvenAppBridge();

    // Restore persisted state for Android WebView suspension resilience
    try {
      const saved = await this.bridge.getLocalStorage(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<LensViewState>;
        if (parsed.pairingCode) {
          this.state.pairingCode = parsed.pairingCode;
        }
      }
    } catch {
      // ignore storage read error
    }

    await this.renderToGlasses(this.state);

    this.bridge.onEvenHubEvent((event) => {
      void this.handleEvenHubEvent(event);
    });

    this.connectWebSocket();
    await this.fetchInitialState();
  }

  private async fetchInitialState(): Promise<void> {
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/state`);
      if (!res.ok) return;
      const data = (await res.json()) as { state: LensViewState; session: PairingSession };
      this.state = data.state;
      this.session = data.session;
      await this.persistState();
      await this.renderToGlasses(this.state);
      this.onUiUpdate(this.state, this.session, 'Connected (HTTP + WS)');
    } catch {
      this.onUiUpdate(this.state, this.session, `Backend offline at ${BACKEND_ORIGIN}`);
    }
  }

  private connectWebSocket(): void {
    try {
      this.ws = new WebSocket(WS_URL);
      this.ws.onopen = () => {
        this.ws?.send(JSON.stringify({ type: 'register', client: 'glasses' }));
        this.onUiUpdate(this.state, this.session, 'Live WS connected');
      };
      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as WsServerMessage;
          if (msg.type === 'state') {
            if (!this.isRecording) {
              this.state = msg.state;
              this.session = msg.session;
              void this.persistState();
              void this.renderToGlasses(this.state);
              this.onUiUpdate(this.state, this.session, 'Live WS synced');
            }
          }
        } catch {
          // ignore malformed WS payload
        }
      };
      this.ws.onclose = () => {
        this.onUiUpdate(this.state, this.session, 'Reconnecting WS...');
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connectWebSocket(), 2500);
      };
    } catch {
      // retry
    }
  }

  private async persistState(): Promise<void> {
    if (!this.bridge) return;
    try {
      await this.bridge.setLocalStorage(
        STORAGE_KEY,
        JSON.stringify({ pairingCode: this.session?.code ?? this.state.pairingCode }),
      );
    } catch {
      // ignore
    }
  }

  private buildMenuObject() {
    // <= 10 items, <= 32 UTF-8 bytes each, non-zero itemID
    return [
      { itemID: 1, title: 'Voice (4s)' },
      { itemID: 2, title: 'Positions' },
      { itemID: 3, title: 'Sync Testnets' },
      { itemID: 4, title: 'Blank Screen' },
    ];
  }

  private async renderToGlasses(viewState: LensViewState): Promise<void> {
    if (!this.bridge) return;
    const layout = renderLensPage(viewState);
    const check = validateLensLayout(layout);
    if (!check.valid) {
      console.error('[ChainVision] Layout validation failed:', check.errors);
      return;
    }

    const textObjects = layout.textObject.map(
      (c) =>
        new TextContainerProperty({
          containerID: c.containerID,
          containerName: c.containerName,
          xPosition: c.xPosition,
          yPosition: c.yPosition,
          width: c.width,
          height: c.height,
          content: c.content,
          isEventCapture: c.isEventCapture,
          borderWidth: c.borderWidth,
          borderColor: c.borderColor,
          borderRadius: c.borderRadius,
          paddingLength: c.paddingLength,
        }),
    );

    if (!this.startupCreated) {
      await this.bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({
          containerTotalNum: layout.containerTotalNum,
          textObject: textObjects,
        }),
      );
      this.startupCreated = true;
      this.lastLayout = layout;
      return;
    }

    // Use flicker-free textContainerUpgrade when container layout structure matches
    const sameShape =
      this.lastLayout &&
      this.lastLayout.containerTotalNum === layout.containerTotalNum &&
      this.lastLayout.textObject.every(
        (prev, i) =>
          prev.containerID === layout.textObject[i]?.containerID &&
          prev.isEventCapture === layout.textObject[i]?.isEventCapture &&
          prev.borderWidth === layout.textObject[i]?.borderWidth &&
          prev.xPosition === layout.textObject[i]?.xPosition &&
          prev.yPosition === layout.textObject[i]?.yPosition &&
          prev.width === layout.textObject[i]?.width &&
          prev.height === layout.textObject[i]?.height,
      );

    if (sameShape) {
      for (const c of layout.textObject) {
        await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: c.containerID,
            containerName: c.containerName,
            contentOffset: 0,
            contentLength: c.content.length,
            content: c.content,
          }),
        );
      }
      this.lastLayout = layout;
      return;
    }

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: layout.containerTotalNum,
        textObject: textObjects,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(this.buildMenuObject().length > 0 ? ({ menuObject: this.buildMenuObject() } as any) : {}),
      }),
    );
    this.lastLayout = layout;
  }

  private async handleEvenHubEvent(event: EvenHubEvent): Promise<void> {
    // 1. Live audio stream frames during voice capture
    if (event.audioEvent?.audioPcm) {
      if (this.isRecording) {
        const raw = event.audioEvent.audioPcm;
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(Object.values(raw));
        this.pcmChunks.push(bytes);
      }
      return;
    }

    // 2. Contextual menu actions (fallback path for voice/positions/blank)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const menuId = (event as any).menuEvent?.itemID ?? (event as any).sysEvent?.menuItemId;
    if (menuId) {
      if (menuId === 1) {
        await this.captureTimedVoice(4000);
      } else if (menuId === 2) {
        await this.cyclePositions();
      } else if (menuId === 3) {
        await this.syncNow();
      } else if (menuId === 4) {
        await this.dismissToBlank();
      }
      return;
    }

    // 3. Foreground lifecycle events (must be idempotent; menu close fires FOREGROUND_EXIT_EVENT)
    const sysType = event.sysEvent?.eventType;
    if (
      sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT ||
      sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT
    ) {
      return;
    }

    // 4. Long press start/release for hold-to-speak voice capture
    if (sysType === OsEventTypeList.LONG_PRESS_EVENT) {
      await this.startVoiceCapture();
      return;
    }
    if (sysType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) {
      await this.finishVoiceCapture();
      return;
    }

    // 5. Extract gesture from sysEvent / textEvent / listEvent.
    // Protobuf drops enum 0 (CLICK_EVENT) to undefined, so check DOUBLE_CLICK and SCROLL first!
    const envelope = event.sysEvent ?? event.textEvent ?? event.listEvent;
    if (!envelope) return;

    const evType = envelope.eventType;

    // Double-tap is ALWAYS reserved for native Even Hub exit on root page
    if (evType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      if (this.isRecording) {
        this.isRecording = false;
        await this.bridge?.audioControl(false).catch(() => {});
      }
      await this.bridge?.shutDownPageContainer(1);
      return;
    }

    // Swipe up: cycle through live testnet protocol positions
    if (evType === OsEventTypeList.SCROLL_TOP_EVENT) {
      if (Date.now() - this.lastSwipeAt < SWIPE_DEBOUNCE_MS) return;
      this.lastSwipeAt = Date.now();
      await this.cyclePositions();
      return;
    }

    // Swipe down: cancel / dismiss back to blank idle screen
    if (evType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      if (Date.now() - this.lastSwipeAt < SWIPE_DEBOUNCE_MS) return;
      this.lastSwipeAt = Date.now();
      await this.dismissToBlank();
      return;
    }

    // Single tap (CLICK_EVENT = 0 or undefined inside envelope) checked LAST
    if (evType === OsEventTypeList.CLICK_EVENT || evType === undefined) {
      if (Date.now() - this.lastTapAt < TAP_LOCKOUT_MS) return;
      this.lastTapAt = Date.now();
      await this.handleSingleTap();
    }
  }

  private async handleSingleTap(): Promise<void> {
    if (this.state.mode === 'signal' && this.state.signal) {
      const action = this.state.signal.action;
      if (action) {
        await fetch(`${BACKEND_ORIGIN}/api/actions/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actionId: action.id, source: 'glasses_tap' }),
        });
      } else {
        await this.dismissToBlank();
      }
      return;
    }

    if (
      (this.state.mode === 'alert' || this.state.mode === 'confirm') &&
      this.state.pendingAction
    ) {
      const actionId = this.state.pendingAction.id;
      await fetch(`${BACKEND_ORIGIN}/api/actions/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionId, source: 'glasses_tap' }),
      });
      return;
    }

    if (this.state.mode === 'idle') {
      await this.cyclePositions();
      return;
    }

    if (['result', 'error', 'brief', 'notice'].includes(this.state.mode)) {
      await this.dismissToBlank();
    }
  }

  private async startVoiceCapture(): Promise<void> {
    if (!this.bridge || this.isRecording) return;
    this.isRecording = true;
    this.pcmChunks = [];
    const listeningState: LensViewState = { ...this.state, mode: 'voice_listening', voiceTranscript: '' };
    await this.renderToGlasses(listeningState);
    this.onUiUpdate(listeningState, this.session, 'Recording mic PCM...');
    await this.bridge.audioControl(true);
  }

  private async finishVoiceCapture(): Promise<void> {
    if (!this.bridge || !this.isRecording) return;
    this.isRecording = false;
    await this.bridge.audioControl(false).catch(() => {});

    const totalLen = this.pcmChunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of this.pcmChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.pcmChunks = [];

    if (merged.length < 3200) {
      await this.dismissToBlank();
      return;
    }

    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/voice/pcm`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: merged,
      });
      const json = (await res.json()) as { state?: LensViewState };
      if (json.state) {
        this.state = json.state;
        await this.renderToGlasses(this.state);
        this.onUiUpdate(this.state, this.session, 'Voice intent parsed');
      }
    } catch {
      await this.dismissToBlank();
    }
  }

  private async captureTimedVoice(durationMs: number): Promise<void> {
    await this.startVoiceCapture();
    setTimeout(() => {
      void this.finishVoiceCapture();
    }, durationMs);
  }

  async sendVoiceText(transcript: string): Promise<void> {
    const res = await fetch(`${BACKEND_ORIGIN}/api/voice/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript }),
    });
    const data = (await res.json()) as { state?: LensViewState };
    if (data.state) {
      this.state = data.state;
      await this.renderToGlasses(this.state);
      this.onUiUpdate(this.state, this.session, 'Voice command prepared');
    }
  }

  async showBrief(): Promise<void> {
    const res = await fetch(`${BACKEND_ORIGIN}/api/brief`, { method: 'POST' });
    const data = (await res.json()) as { state?: LensViewState };
    if (data.state) {
      this.state = data.state;
      await this.renderToGlasses(this.state);
      this.onUiUpdate(this.state, this.session, 'What matters');
    }
  }

  async syncNow(): Promise<void> {
    const res = await fetch(`${BACKEND_ORIGIN}/api/sync`, { method: 'POST' });
    const data = (await res.json()) as { state?: LensViewState };
    if (data.state) {
      this.state = data.state;
      await this.renderToGlasses(this.state);
      this.onUiUpdate(this.state, this.session, 'Testnets synced');
    }
  }

  async cyclePositions(): Promise<void> {
    const res = await fetch(`${BACKEND_ORIGIN}/api/view/positions`, { method: 'POST' });
    const data = (await res.json()) as { state?: LensViewState };
    if (data.state) {
      this.state = data.state;
      await this.renderToGlasses(this.state);
      this.onUiUpdate(this.state, this.session, 'Viewing positions');
    }
  }

  async dismissToBlank(): Promise<void> {
    const res = await fetch(`${BACKEND_ORIGIN}/api/actions/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: this.state.pendingAction?.id }),
    });
    const data = (await res.json()) as { state?: LensViewState };
    if (data.state) {
      this.state = data.state;
      await this.renderToGlasses(this.state);
      this.onUiUpdate(this.state, this.session, 'Idle (blank lens)');
    }
  }
}
