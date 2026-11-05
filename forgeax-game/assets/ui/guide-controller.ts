// 《荒岛合纵：破箱局》HUD 控制器
// 驱动顶部仪表盘、队伍状态、触屏摇杆动作与结算弹窗

import type { GameHost } from '@forgeax/engine/app';
import { mountUi, type UiAsset, type UiInstance } from '@forgeax/engine/ui';
import { bindUiLocalization, createUiLocalization } from '@forgeax/engine/ui/localization';
import { installVaseControls } from './vase-controls.ts';
import { installPlayerControls } from './player-controls.ts';
import { ISLAND_CONTROL_CHANNEL, type IslandTouchMessage } from '../island/island.pack.ts';

export async function createGuideUi(
  asset: UiAsset,
  host: Pick<GameHost, 'uiRoot' | 'controlMode' | 'port' | 'presentationPort'>,
): Promise<UiInstance> {
  const root = host.uiRoot;
  if (!root) throw new Error('game-3d UI requires GameHost.uiRoot in the presentation realm');

  const localized = await createUiLocalization(asset, { lng: 'en' });
  if (!localized.ok) throw localized.error;
  const i18n = localized.value;

  const mounted = mountUi(asset, {
    root,
    layer: 50,
  });
  if (!mounted.ok) throw mounted.error;
  const ui = mounted.value;
  const releases: (() => void)[] = [() => ui.dispose()];
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const failures: unknown[] = [];
    for (const release of releases.reverse()) {
      try {
        release();
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Guide UI disposal failed');
  };

  try {
    const shadow = ui.host.shadowRoot;
    const port = host.presentationPort ?? host.port;

    // 兼顾原有契约测试的控制器桩
    const playerControls = port && shadow ? installPlayerControls(shadow, port) : undefined;
    if (playerControls) releases.push(() => playerControls.dispose());
    const vaseControls =
      port && shadow
        ? installVaseControls(shadow, port, (key, options) => i18n.t(key, options))
        : undefined;
    if (vaseControls) releases.push(() => vaseControls.dispose());
    else {
      shadow
        ?.querySelector<HTMLButtonElement>('[data-ui-part="vase-controls"] button')
        ?.setAttribute('disabled', '');
    }

    const vaseToggle = shadow?.querySelector<HTMLButtonElement>('[data-ui-part="vase-toggle"]');
    let lastMode: string | undefined;
    let vaseOpen = true;

    const update = () => {
      const mode = host.controlMode?.read() ?? 'pointer';
      const locked = mode === 'pointer-locked';
      if (lastMode !== mode) {
        playerControls?.reset();
        vaseOpen = mode !== 'touch';
        lastMode = mode;
      }
      ui.host.classList.toggle('touch', mode === 'touch');
      ui.host.classList.toggle('controls-ready', playerControls !== undefined);
      ui.host.classList.toggle('vase-open', vaseOpen);
      ui.host.classList.toggle('locked', locked);
      playerControls?.setEnabled(mode === 'touch' && !vaseOpen);
      if (vaseToggle) {
        vaseToggle.setAttribute('aria-expanded', String(vaseOpen));
        vaseToggle.textContent = i18n.t(vaseOpen ? 'closeVase' : 'openVase');
      }
      const label = ui.host.shadowRoot?.querySelector<HTMLElement>('[data-ui-slot="lock"]');
      if (label) {
        label.textContent = i18n.t(
          locked
            ? 'lock'
            : mode === 'touch'
              ? playerControls
                ? 'touch'
                : 'touchUnavailable'
              : 'unlock',
        );
      }
      if (vaseControls) vaseControls.localize();
      else {
        const button = shadow?.querySelector<HTMLButtonElement>(
          '[data-ui-part="vase-controls"] button',
        );
        if (button) button.textContent = i18n.t('vase.generate');
        const status = shadow?.querySelector<HTMLElement>('[data-ui-part="vase-status"]');
        if (status) status.textContent = i18n.t('vase.unavailable');
      }
      ui.host.lang = i18n.resolvedLanguage ?? i18n.language;
    };

    if (vaseToggle) {
      const toggleVase = () => {
        playerControls?.reset();
        vaseOpen = !vaseOpen;
        update();
      };
      vaseToggle.addEventListener('click', toggleVase);
      releases.push(() => vaseToggle.removeEventListener('click', toggleVase));
    }

    if (host.controlMode) releases.push(host.controlMode.subscribe(update));
    releases.push(bindUiLocalization(ui, i18n, update));

    const sendTouch = (msg: Omit<IslandTouchMessage, 'channel'>) => {
      if (port) {
        port.postMessage({ channel: ISLAND_CONTROL_CHANNEL, ...msg });
      }
    };

    // 绑定触屏摇杆与按键
    if (shadow) {
      const stick = shadow.querySelector<HTMLElement>('[data-ui-part="move-stick"]');
      const thumb = shadow.querySelector<HTMLElement>('[data-ui-part="move-thumb"]');
      if (stick && thumb) {
        let activeId = -1;
        const onDown = (e: PointerEvent) => {
          if (activeId !== -1) return;
          activeId = e.pointerId;
          stick.setPointerCapture(e.pointerId);
          handleMove(e);
        };
        const handleMove = (e: PointerEvent) => {
          const rect = stick.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const maxR = rect.width * 0.38;
          let dx = (e.clientX - cx) / maxR;
          let dy = (e.clientY - cy) / maxR;
          const len = Math.hypot(dx, dy);
          if (len > 1) {
            dx /= len;
            dy /= len;
          }
          thumb.style.transform = `translate(${dx * maxR}px, ${dy * maxR}px)`;
          sendTouch({ kind: 'move', x: dx, y: dy });
        };
        const onUp = (e: PointerEvent) => {
          if (e.pointerId !== activeId) return;
          activeId = -1;
          thumb.style.transform = 'translate(0px, 0px)';
          sendTouch({ kind: 'reset' });
        };
        stick.addEventListener('pointerdown', onDown);
        stick.addEventListener('pointermove', (e) => {
          if (e.pointerId === activeId) handleMove(e);
        });
        stick.addEventListener('pointerup', onUp);
        stick.addEventListener('pointercancel', onUp);
      }

      const btnAlly = shadow.querySelector<HTMLElement>('[data-ui-part="btn-ally"]');
      if (btnAlly) {
        btnAlly.addEventListener('click', () => sendTouch({ kind: 'ally' }));
      }
      const btnDash = shadow.querySelector<HTMLElement>('[data-ui-part="btn-dash"]');
      if (btnDash) {
        btnDash.addEventListener('click', () => sendTouch({ kind: 'dash' }));
      }
      const btnKick = shadow.querySelector<HTMLElement>('[data-ui-part="btn-kick"]');
      if (btnKick) {
        let kickPointer = -1;
        btnKick.addEventListener('pointerdown', (e) => {
          kickPointer = e.pointerId;
          sendTouch({ kind: 'kick', held: true });
        });
        const stopKick = (e: PointerEvent) => {
          if (e.pointerId === kickPointer) {
            kickPointer = -1;
            sendTouch({ kind: 'kick', held: false });
          }
        };
        btnKick.addEventListener('pointerup', stopKick);
        btnKick.addEventListener('pointercancel', stopKick);
      }
      const btnSpeed = shadow.querySelector<HTMLElement>('[data-ui-part="btn-speed"]');
      if (btnSpeed) {
        btnSpeed.addEventListener('click', () => sendTouch({ kind: 'speed' }));
      }
      const btnRestart = shadow.querySelector<HTMLElement>('[data-ui-part="btn-restart"]');
      if (btnRestart) {
        btnRestart.addEventListener('click', () => {
          sendTouch({ kind: 'restart' });
          const modal = shadow.querySelector<HTMLElement>('[data-ui-part="result-modal"]');
          if (modal) modal.classList.add('hidden');
        });
      }
    }

    // 接收来自引擎的 HUD 状态更新
    const timerElem = shadow?.querySelector<HTMLElement>('[data-ui-part="match-timer"]');
    const phaseElem = shadow?.querySelector<HTMLElement>('[data-ui-part="match-phase"]');
    const survElem = shadow?.querySelector<HTMLElement>('[data-ui-part="survivors-count"]');
    const treasureElem = shadow?.querySelector<HTMLElement>('[data-ui-part="player-treasure"]');
    const hpFill = shadow?.querySelector<HTMLElement>('[data-ui-part="hp-fill"]');
    const statusHint = shadow?.querySelector<HTMLElement>('[data-ui-part="player-status-hint"]');
    const kickContainer = shadow?.querySelector<HTMLElement>('[data-ui-part="kick-charge-container"]');
    const kickPct = shadow?.querySelector<HTMLElement>('[data-ui-part="kick-pct"]');
    const kickFill = shadow?.querySelector<HTMLElement>('[data-ui-part="kick-fill"]');
    const resultModal = shadow?.querySelector<HTMLElement>('[data-ui-part="result-modal"]');
    const resultTitle = shadow?.querySelector<HTMLElement>('[data-ui-part="result-title"]');
    const resultSub = shadow?.querySelector<HTMLElement>('[data-ui-part="result-subtitle"]');
    const statTreasure = shadow?.querySelector<HTMLElement>('[data-ui-part="stat-treasure"]');
    const statBreaks = shadow?.querySelector<HTMLElement>('[data-ui-part="stat-breaks"]');
    const statBetrayals = shadow?.querySelector<HTMLElement>('[data-ui-part="stat-betrayals"]');
    const statKills = shadow?.querySelector<HTMLElement>('[data-ui-part="stat-kills"]');
    const statRank = shadow?.querySelector<HTMLElement>('[data-ui-part="stat-rank"]');

    if (port) {
      const onHudMessage = (event: MessageEvent) => {
        if (disposed) return;
        const state = event.data as Record<string, unknown> | undefined;
        if (!state || state.channel !== 'island/hud-state') return;

        const elapsed = typeof state.elapsed === 'number' ? state.elapsed : 0;
        const left = Math.max(0, 300 - elapsed);
        const mm = Math.floor(left / 60);
        const ss = Math.floor(left % 60);
        if (timerElem) {
          timerElem.textContent = `${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
        }

        const phase =
          state.phase === 'final'
            ? '最终混战 · 结盟解除'
            : (state.shrink as number) > 0
              ? '荒岛缩圈中'
              : elapsed < 60
                ? '寻找队友 · 合作打怪'
                : elapsed < 120
                  ? '宝箱成长 · 背叛频发'
                  : '外部掠夺 · 争夺宝物';
        if (phaseElem) phaseElem.textContent = phase;

        const aliveCount = typeof state.aliveCount === 'number' ? state.aliveCount : 10;
        if (survElem) survElem.textContent = `存活 ${aliveCount}/10`;

        const pTreas = typeof state.playerTreasure === 'number' ? state.playerTreasure : 0;
        const breaks = typeof state.chestBreaks === 'number' ? state.chestBreaks : 0;
        if (treasureElem) treasureElem.textContent = `◆ ${pTreas} · 爆箱 ${breaks}`;

        if (hpFill) {
          const hp = typeof state.hp === 'number' ? Math.max(0, state.hp) : 100;
          hpFill.style.width = `${hp}%`;
          hpFill.style.background = hp > 30 ? '#7ee08a' : '#ff5a4a';
        }

        const partnerName = state.partnerName as string | null;
        if (statusHint) {
          statusHint.textContent = partnerName
            ? `队友 ${partnerName} · 长按 F 踢箱`
            : '单人 · 靠近他人按 E 结盟';
        }

        if (kickContainer && kickPct && kickFill) {
          const charge = typeof state.kickCharge === 'number' ? state.kickCharge : 0;
          if (charge > 0 && partnerName) {
            kickContainer.style.display = 'block';
            const pct = Math.min(100, Math.round(charge * 100));
            kickPct.textContent = `${pct}%`;
            kickFill.style.width = `${pct}%`;
          } else {
            kickContainer.style.display = 'none';
          }
        }

        // 胜负结算展示
        if (state.gameOver && resultModal && resultModal.classList.contains('hidden')) {
          resultModal.classList.remove('hidden');
          const isWinner = state.isAlive === true;
          if (resultTitle) {
            resultTitle.textContent = isWinner
              ? '胜利！你是最后幸存者'
              : `${state.winnerName ?? '其他玩家'} 获胜`;
          }
          if (resultSub) {
            resultSub.textContent = isWinner
              ? '精彩的生存与合纵决战！'
              : '荒岛形势瞬息万变，再试一次！';
          }
          if (statTreasure) statTreasure.textContent = String(pTreas);
          if (statBreaks) statBreaks.textContent = String(breaks);
          if (statBetrayals) statBetrayals.textContent = String(state.betrayals ?? 0);
          if (statKills) statKills.textContent = String(state.kills ?? 0);
          if (statRank) statRank.textContent = `${isWinner ? '1' : Math.max(2, 11 - aliveCount)} / 10`;
        }
      };
      port.addEventListener('message', onHudMessage);
      releases.push(() => port.removeEventListener('message', onHudMessage));
    }

    update();

    return { host: ui.host, signal: ui.signal, resourceUrl: ui.resourceUrl, dispose };
  } catch (cause) {
    try {
      dispose();
    } catch (cleanupCause) {
      throw new AggregateError([cause, cleanupCause], 'Guide UI initialization failed');
    }
    throw cause;
  }
}
