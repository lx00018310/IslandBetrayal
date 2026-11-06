// 《荒岛分赃》HUD 控制器
// 驱动顶部仪表盘、组队选择/邀请横幅、触屏摇杆动作、三选一肉鸽升级面板、Boss全局血条、队伍列表动态同步与结算弹窗

import type { GameHost } from '@forgeax/engine/app';
import { mountUi, type UiAsset, type UiInstance } from '@forgeax/engine/ui';
import { bindUiLocalization, createUiLocalization } from '@forgeax/engine/ui/localization';
import { installVaseControls } from './vase-controls.ts';
import { installPlayerControls } from './player-controls.ts';
import { ISLAND_CONTROL_CHANNEL, type IslandTouchMessage } from '../island/island.pack.ts';
import type { UpgradeOption } from '../island/simulation.ts';
import {
  STAT_FACTORS,
  STAT_NAMES,
  STAT_TARGETS,
  type CarryRelic,
  type StatFactor,
  type StatTarget,
} from '../island/stats.ts';

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
    if (port) {
      port.start?.();
    }

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

    // 当前候选目标与邀请状态缓存
    let activeIncomingInviteId: number | null = null;
    let activeIncomingFromId: number | null = null;
    let activeCandidateId: number | null = null;
    let activeUpgradePending = false;

    // 绑定触屏与交互按键
    if (shadow) {
      const stick = shadow.querySelector<HTMLElement>('[data-ui-part="move-stick"]');
      const thumb = shadow.querySelector<HTMLElement>('[data-ui-part="move-thumb"]');
      if (stick && thumb) {
        let activeId = -1;
        const resetStick = () => {
          activeId = -1;
          thumb.style.transform = 'translate(0px, 0px)';
          sendTouch({ kind: 'reset' });
        };
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
          if (e.pointerId === activeId) resetStick();
        };
        stick.addEventListener('pointerdown', onDown);
        stick.addEventListener('pointermove', (e) => {
          if (e.pointerId === activeId) handleMove(e);
        });
        stick.addEventListener('pointerup', onUp);
        stick.addEventListener('pointercancel', onUp);
        stick.addEventListener('lostpointercapture', resetStick);
      }

      // 组队 / 接受主按钮（唯一操作按键 Space / 组队触控按钮，R03）
      const triggerMainChoice = () => {
        if (activeIncomingInviteId !== null) {
          sendTouch({ kind: 'accept', inviteId: activeIncomingInviteId });
        } else if (activeCandidateId !== null) {
          sendTouch({ kind: 'invite', targetId: activeCandidateId });
        } else {
          sendTouch({ kind: 'team' });
        }
      };

      const btnChoiceMain = shadow.querySelector<HTMLElement>('[data-ui-part="btn-choice-main"]');
      if (btnChoiceMain) {
        btnChoiceMain.addEventListener('click', triggerMainChoice);
      }
      const btnAllyTouch = shadow.querySelector<HTMLElement>('[data-ui-part="btn-ally-touch"]');
      if (btnAllyTouch) {
        btnAllyTouch.addEventListener('click', triggerMainChoice);
      }

      // 兼容性保留隐藏插槽绑定
      const btnDash = shadow.querySelector<HTMLElement>('[data-ui-part="btn-dash"]');
      if (btnDash) {
        btnDash.addEventListener('click', triggerMainChoice);
      }
      const btnSpeed = shadow.querySelector<HTMLElement>('[data-ui-part="btn-speed"]');
      if (btnSpeed) {
        btnSpeed.addEventListener('click', () => sendTouch({ kind: 'speed' }));
      }

      // 升级三选一卡片点击处理
      for (let i = 0; i < 3; i++) {
        const cardBtn = shadow.querySelector<HTMLElement>(`[data-ui-part="upgrade-card-${i}"]`);
        if (cardBtn) {
          cardBtn.addEventListener('click', () => {
            if (activeUpgradePending) {
              sendTouch({ kind: 'upgrade', choiceIndex: i });
            }
          });
        }
      }
    }

    // 无限模式秘策与宝物选择状态
    let selectedStatIndex = 0;
    let selectedFactorIndex = 0;
    let selectedRelicIndex = 0;
    let cachedOwnedRelics: CarryRelic[] = [];
    let currentMode: 'normal' | 'endless' = 'endless';

    // 无限模式选择弹窗元素
    const ruleModal = shadow?.querySelector<HTMLElement>('[data-ui-part="endless-rule-modal"]');
    const relicModal = shadow?.querySelector<HTMLElement>('[data-ui-part="endless-relic-modal"]');
    const relicCardsContainer = shadow?.querySelector<HTMLElement>('[data-ui-part="relic-cards"]');
    const btnConfirmRule = shadow?.querySelector<HTMLButtonElement>('[data-ui-part="btn-confirm-rule"]');
    const btnConfirmRelic = shadow?.querySelector<HTMLButtonElement>('[data-ui-part="btn-confirm-relic"]');
    const btnResetEndless = shadow?.querySelector<HTMLButtonElement>('[data-ui-part="btn-reset-endless"]');
    const btnSwitchMode = shadow?.querySelector<HTMLButtonElement>('[data-ui-part="btn-switch-mode"]');
    const worldBanner = shadow?.querySelector<HTMLElement>('[data-ui-part="world-banner"]');
    const worldBannerText = shadow?.querySelector<HTMLElement>('[data-ui-part="world-banner-text"]');
    const modeBadge = shadow?.querySelector<HTMLElement>('[data-ui-part="mode-badge"]');

    if (shadow) {
      // 秘策属性卡片点击
      for (let s = 0; s < 5; s++) {
        const card = shadow.querySelector<HTMLElement>(`[data-ui-part="rule-card-${s}"]`);
        if (card) {
          card.addEventListener('click', () => {
            selectedStatIndex = s;
            sendTouch({ kind: 'rule_highlight', stat: STAT_TARGETS[s] });
            updateRuleModalSelection();
          });
        }
      }

      // 修正倍率胶囊点击
      for (let f = 0; f < 4; f++) {
        const pill = shadow.querySelector<HTMLElement>(`[data-ui-part="factor-pill-${f}"]`);
        if (pill) {
          pill.addEventListener('click', () => {
            selectedFactorIndex = f;
            sendTouch({ kind: 'rule_highlight', factor: STAT_FACTORS[f] });
            updateRuleModalSelection();
          });
        }
      }

      if (btnConfirmRule) {
        btnConfirmRule.addEventListener('click', () => {
          const stat = STAT_TARGETS[selectedStatIndex] ?? 'damage';
          const factor = STAT_FACTORS[selectedFactorIndex] ?? 1.2;
          sendTouch({ kind: 'rule_select', stat, factor });
        });
      }

      if (btnConfirmRelic) {
        btnConfirmRelic.addEventListener('click', () => {
          const chosen = cachedOwnedRelics[selectedRelicIndex] ?? null;
          sendTouch({
            kind: 'relic_select',
            relicKind: chosen?.kind ?? null,
            relicLevel: chosen?.level ?? 1,
          });
        });
      }

      if (btnResetEndless) {
        btnResetEndless.addEventListener('click', () => {
          sendTouch({ kind: 'restart' });
        });
      }
      if (btnSwitchMode) {
        btnSwitchMode.addEventListener('click', () => {
          sendTouch({ kind: 'mode_select', mode: currentMode === 'endless' ? 'normal' : 'endless' });
        });
      }
    }

    const updateRuleModalSelection = () => {
      if (!shadow) return;
      for (let s = 0; s < 5; s++) {
        const card = shadow.querySelector<HTMLElement>(`[data-ui-part="rule-card-${s}"]`);
        if (card) card.classList.toggle('selected', s === selectedStatIndex);
        const value = shadow.querySelector<HTMLElement>(`[data-ui-part="rule-stat-val-${s}"]`);
        const pct = Math.round(((STAT_FACTORS[selectedFactorIndex] ?? 1.2) - 1) * 100);
        if (value) value.textContent = `${pct > 0 ? '+' : ''}${pct}%`;
      }
      for (let f = 0; f < 4; f++) {
        const pill = shadow.querySelector<HTMLElement>(`[data-ui-part="factor-pill-${f}"]`);
        if (pill) pill.classList.toggle('selected', f === selectedFactorIndex);
      }
    };

    // 接收来自引擎的 HUD 状态更新
    const timerElem = shadow?.querySelector<HTMLElement>('[data-ui-part="match-timer"]');
    const phaseElem = shadow?.querySelector<HTMLElement>('[data-ui-part="match-phase"]');
    const challengeStatsElem = shadow?.querySelector<HTMLElement>('[data-ui-part="challenge-stats"]');
    const playerLevelElem = shadow?.querySelector<HTMLElement>('[data-ui-part="player-level"]');
    const playerXpTextElem = shadow?.querySelector<HTMLElement>('[data-ui-part="player-xp-text"]');
    const xpFill = shadow?.querySelector<HTMLElement>('[data-ui-part="xp-fill"]');
    const survElem = shadow?.querySelector<HTMLElement>('[data-ui-part="survivors-count"]');
    const treasureElem = shadow?.querySelector<HTMLElement>('[data-ui-part="player-treasure"]');
    const teamListElem = shadow?.querySelector<HTMLElement>('[data-ui-part="team-list"]');
    const hpFill = shadow?.querySelector<HTMLElement>('[data-ui-part="hp-fill"]');
    const statusHint = shadow?.querySelector<HTMLElement>('[data-ui-part="player-status-hint"]');
    const warningHint = shadow?.querySelector<HTMLElement>('[data-ui-part="distance-warning-hint"]');
    const choiceBanner = shadow?.querySelector<HTMLElement>('[data-ui-part="choice-banner"]');
    const choiceText = shadow?.querySelector<HTMLElement>('[data-ui-part="choice-text"]');
    const btnChoiceMain = shadow?.querySelector<HTMLElement>('[data-ui-part="btn-choice-main"]');
    const btnChoiceIgnore = shadow?.querySelector<HTMLElement>('[data-ui-part="btn-choice-ignore"]');

    // Boss 血条
    const bossHud = shadow?.querySelector<HTMLElement>('[data-ui-part="boss-hud"]');
    const bossHpText = shadow?.querySelector<HTMLElement>('[data-ui-part="boss-hp-text"]');
    const bossHpFill = shadow?.querySelector<HTMLElement>('[data-ui-part="boss-hp-fill"]');

    // 升级弹窗与卡片
    const upgradeModal = shadow?.querySelector<HTMLElement>('[data-ui-part="upgrade-modal"]');

    // 结算弹窗
    const resultModal = shadow?.querySelector<HTMLElement>('[data-ui-part="result-modal"]');
    const btnRestart = shadow?.querySelector<HTMLButtonElement>('[data-ui-part="btn-restart"]');
    const resultTitle = shadow?.querySelector<HTMLElement>('[data-ui-part="result-title"]');
    const resultSub = shadow?.querySelector<HTMLElement>('[data-ui-part="result-subtitle"]');
    const statTreasure = shadow?.querySelector<HTMLElement>('[data-ui-part="stat-treasure"]');
    const statBreaks = shadow?.querySelector<HTMLElement>('[data-ui-part="stat-breaks"]');
    const statDisbands = shadow?.querySelector<HTMLElement>('[data-ui-part="stat-disbands"]');
    const statBetrayals = shadow?.querySelector<HTMLElement>('[data-ui-part="stat-betrayals"]');
    const statKills = shadow?.querySelector<HTMLElement>('[data-ui-part="stat-kills"]');
    const statRank = shadow?.querySelector<HTMLElement>('[data-ui-part="stat-rank"]');
    const challengeProgress = shadow?.querySelector<HTMLElement>('[data-ui-part="challenge-progress"]');

    if (btnRestart) {
      btnRestart.addEventListener('click', () => {
        btnRestart.setAttribute('disabled', '');
        sendTouch({ kind: 'next_round' });
      });
    }

    if (port) {
      const onHudMessage = (event: MessageEvent) => {
        if (disposed) return;
        const state = event.data as Record<string, unknown> | undefined;
        if (!state || state.channel !== 'island/hud-state') return;

        // 若重开已重置或不在结算展示阶段，隐藏结算弹窗并恢复再来一局按钮状态
        if (!state.gameOver) {
          if (resultModal && !resultModal.classList.contains('hidden')) {
            resultModal.classList.add('hidden');
          }
          if (btnRestart) {
            btnRestart.removeAttribute('disabled');
          }
        }

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
                  ? '宝箱成长 · 谨防断线'
                  : '外部掠夺 · 争夺宝物';
        if (phaseElem) phaseElem.textContent = phase;

        // 连续挑战累计时间统计
        const challengeElapsed = typeof state.challengeElapsed === 'number' ? state.challengeElapsed : elapsed;
        const roundsCompleted = typeof state.roundsCompleted === 'number' ? state.roundsCompleted : 1;
        const cMm = Math.floor(challengeElapsed / 60);
        const cSs = Math.floor(challengeElapsed % 60);
        if (challengeStatsElem) {
          challengeStatsElem.textContent = `挑战 ${cMm.toString().padStart(2, '0')}:${cSs.toString().padStart(2, '0')} · 第 ${state.roundIndex ?? 1} 局`;
        }

        // 经验条与等级同步
        const lvl = typeof state.playerLevel === 'number' ? state.playerLevel : 1;
        const xp = typeof state.playerXp === 'number' ? state.playerXp : 0;
        const xpNext = typeof state.playerXpNext === 'number' ? state.playerXpNext : 5;
        if (playerLevelElem) playerLevelElem.textContent = `LV.${lvl}`;
        if (playerXpTextElem) playerXpTextElem.textContent = `${xp} / ${xpNext} XP`;
        if (xpFill) {
          const xpPct = Math.min(100, Math.round((xp / xpNext) * 100));
          xpFill.style.width = `${xpPct}%`;
        }

        // 升级三选一面板弹窗同步
        const isUpgradePending = state.pendingUpgrade === true && !state.gameOver;
        activeUpgradePending = isUpgradePending;
        const choices = state.upgradeChoices as UpgradeOption[] | undefined;

        if (upgradeModal) {
          if (isUpgradePending && choices && choices.length >= 3) {
            upgradeModal.classList.remove('hidden');
            for (let i = 0; i < 3; i++) {
              const c = choices[i]!;
              const badge = shadow?.querySelector<HTMLElement>(`[data-ui-part="card-badge-${i}"]`);
              const title = shadow?.querySelector<HTMLElement>(`[data-ui-part="card-title-${i}"]`);
              const desc = shadow?.querySelector<HTMLElement>(`[data-ui-part="card-desc-${i}"]`);
              const preview = shadow?.querySelector<HTMLElement>(`[data-ui-part="card-preview-${i}"]`);
              const card = shadow?.querySelector<HTMLElement>(`[data-ui-part="upgrade-card-${i}"]`);
              const highlight = (state.endless as { upgradeHighlight?: number } | undefined)?.upgradeHighlight ?? 0;
              card?.classList.toggle('highlighted', highlight === i);

              if (badge) badge.textContent = c.type === 'weapon' ? '技能' : '属性';
              if (title) title.textContent = c.title;
              if (desc) desc.textContent = c.description;
              if (preview) preview.textContent = `${c.currentValue} → ${c.nextValue}`;
            }
          } else {
            upgradeModal.classList.add('hidden');
          }
        }

        // Boss 全局血条同步
        const boss = state.boss as { alive: boolean; hp: number; maxHp: number } | null | undefined;
        if (bossHud) {
          if (boss && boss.alive) {
            bossHud.classList.remove('hidden');
            if (bossHpText) bossHpText.textContent = `${Math.max(0, boss.hp)} / ${boss.maxHp} HP`;
            if (bossHpFill) {
              const pct = Math.min(100, Math.max(0, Math.round((boss.hp / boss.maxHp) * 100)));
              bossHpFill.style.width = `${pct}%`;
            }
          } else {
            bossHud.classList.add('hidden');
          }
        }

        const aliveCount = typeof state.aliveCount === 'number' ? state.aliveCount : 10;
        if (survElem) survElem.textContent = `存活 ${aliveCount}/10`;

        const pTreas = typeof state.playerTreasure === 'number' ? state.playerTreasure : 0;
        const breaks = typeof state.chestBreaks === 'number' ? state.chestBreaks : 0;
        const disbands = typeof state.playerDisbands === 'number' ? state.playerDisbands : 0;
        if (treasureElem) treasureElem.textContent = `◆ ${pTreas} · 爆箱 ${breaks}`;

        if (hpFill) {
          const hp = typeof state.hp === 'number' ? Math.max(0, state.hp) : 100;
          const maxHp = typeof state.maxHp === 'number' ? state.maxHp : 100;
          const pct = Math.min(100, Math.max(0, hp / maxHp * 100));
          hpFill.style.width = `${pct}%`;
          hpFill.style.background = pct > 30 ? '#7ee08a' : '#ff5a4a';
        }

        // 动态同步场上队伍列表
        const teams = state.teams as
          | Array<{ aName: string; bName: string; treasure: number }>
          | undefined;
        if (teamListElem) {
          if (teams && teams.length > 0) {
            teamListElem.innerHTML = teams
              .map(
                (t) =>
                  `<div class="team-item">● ${t.aName}+${t.bName}  ◆${t.treasure}</div>`,
              )
              .join('');
          } else {
            teamListElem.innerHTML = '<div class="team-item empty-team">等待结盟中...</div>';
          }
        }

        const partnerName = state.partnerName as string | null;
        const partnerDist = state.partnerDistance as number | null;
        const isWarning = state.isWarning === true;
        const ownChest = state.ownChest as
          | { treasure: number; hp: number; maxHp: number }
          | null
          | undefined;

        if (statusHint) {
          if (partnerName) {
            const chestText = ownChest
              ? ` · 宝箱 ◆${ownChest.treasure} (${ownChest.hp}/${ownChest.maxHp})`
              : ' · 宝箱已破';
            statusHint.textContent = `队友 ${partnerName} · 距离 ${partnerDist ?? 0}m${chestText}`;
          } else {
            statusHint.textContent = '单人 · 靠近角色可邀请组队';
          }
        }

        if (warningHint) {
          if (isWarning && partnerName) {
            warningHint.textContent = `⚠️ 距离过远 (${partnerDist ?? 0}/5.0m)！超距断线爆箱！`;
            warningHint.classList.remove('hidden');
          } else {
            warningHint.classList.add('hidden');
          }
        }

        // 组队邀请与候选横幅展示
        const incoming = state.incomingInvite as
          | { id: number; fromId: number; fromName: string; timeLeft: number }
          | null
          | undefined;
        const outgoing = state.outgoingInvite as
          | { id: number; toId: number; toName: string; timeLeft: number }
          | null
          | undefined;
        const candidate = state.candidate as
          | { id: number; name: string; distance: number; canInvite: boolean; reason?: string }
          | null
          | undefined;

        if (incoming) {
          activeIncomingInviteId = incoming.id;
          activeIncomingFromId = incoming.fromId;
          activeCandidateId = null;
          if (choiceBanner && choiceText && btnChoiceMain) {
            choiceText.textContent = `${incoming.fromName} 邀请与你组队 (${incoming.timeLeft}s)`;
            btnChoiceMain.textContent = '接受 (Space)';
            btnChoiceMain.style.display = 'inline-block';
            choiceBanner.classList.remove('hidden');
          }
        } else if (outgoing) {
          activeIncomingInviteId = null;
          activeIncomingFromId = null;
          activeCandidateId = null;
          if (choiceBanner && choiceText && btnChoiceMain) {
            choiceText.textContent = `已向 ${outgoing.toName} 发送邀请... 等待回应 (${outgoing.timeLeft}s)`;
            btnChoiceMain.style.display = 'none';
            choiceBanner.classList.remove('hidden');
          }
        } else if (candidate && candidate.canInvite && !partnerName) {
          activeIncomingInviteId = null;
          activeIncomingFromId = null;
          activeCandidateId = candidate.id;
          if (choiceBanner && choiceText && btnChoiceMain) {
            choiceText.textContent = `附近发现 ${candidate.name} (${candidate.distance}m)`;
            btnChoiceMain.textContent = '组队 (Space)';
            btnChoiceMain.style.display = 'inline-block';
            choiceBanner.classList.remove('hidden');
          }
        } else {
          activeIncomingInviteId = null;
          activeIncomingFromId = null;
          activeCandidateId = null;
          if (choiceBanner) {
            choiceBanner.classList.add('hidden');
          }
        }

        // 无限模式阶段弹窗同步（rule-pick / relic-pick / round-result）
        const endlessState = state.endless as
          | {
              mode: 'normal' | 'endless';
              roundIndex: number;
              phase: 'playing' | 'round-result' | 'rule-pick' | 'relic-pick';
              ruleAnnouncement: string | null;
              upgradeHighlight?: number;
              ruleStatIndex?: number;
              ruleFactorIndex?: number;
              relicHighlight?: number;
              ownedRelics?: CarryRelic[];
            }
          | undefined;

        if (endlessState) {
          currentMode = endlessState.mode;
          if (btnSwitchMode) btnSwitchMode.textContent = currentMode === 'endless' ? '新开普通单局' : '新开无限挑战';
          if (modeBadge) {
            modeBadge.textContent =
              endlessState.mode === 'endless'
                ? `无限挑战 · 第 ${endlessState.roundIndex} 局`
                : '普通单局';
          }

          // 秘策弹窗控制
          if (ruleModal) {
            if (endlessState.phase === 'rule-pick') {
              ruleModal.classList.remove('hidden');
              if (typeof endlessState.ruleStatIndex === 'number') {
                selectedStatIndex = endlessState.ruleStatIndex;
              }
              if (typeof endlessState.ruleFactorIndex === 'number') {
                selectedFactorIndex = endlessState.ruleFactorIndex;
              }
              updateRuleModalSelection();
            } else {
              ruleModal.classList.add('hidden');
            }
          }

          // 宝物选择弹窗控制
          if (relicModal) {
            if (endlessState.phase === 'relic-pick') {
              relicModal.classList.remove('hidden');
              cachedOwnedRelics = endlessState.ownedRelics ?? [];
              if (typeof endlessState.relicHighlight === 'number') {
                selectedRelicIndex = endlessState.relicHighlight;
              }

              if (relicCardsContainer) {
                const RELIC_NAMES: Record<string, string> = {
                  knife: '环绕飞刀',
                  arrow: '穿透箭矢',
                  bomb: '范围炸弹',
                };
                let html = '';
                cachedOwnedRelics.forEach((r, idx) => {
                  const isSel = idx === selectedRelicIndex;
                  html += `
                    <button type="button" class="relic-card ${isSel ? 'selected' : ''}" data-relic-idx="${idx}">
                      <span class="relic-kind-badge">战斗宝物</span>
                      <strong class="relic-name">${RELIC_NAMES[r.kind] ?? r.kind}</strong>
                      <span class="relic-level">LV.${r.level}</span>
                    </button>
                  `;
                });
                const isNoneSel = selectedRelicIndex >= cachedOwnedRelics.length;
                html += `
                  <button type="button" class="relic-card ${isNoneSel ? 'selected' : ''}" data-relic-idx="${cachedOwnedRelics.length}">
                    <span class="relic-kind-badge" style="background:#8fb6c9">空手</span>
                    <strong class="relic-name">轻装出发</strong>
                    <span class="relic-level">无宝物</span>
                  </button>
                `;
                if (relicCardsContainer.innerHTML !== html) {
                  relicCardsContainer.innerHTML = html;
                  relicCardsContainer.querySelectorAll('.relic-card').forEach((btn) => {
                    btn.addEventListener('click', (e) => {
                      const idxStr = (e.currentTarget as HTMLElement).getAttribute('data-relic-idx');
                      if (idxStr !== null) {
                        selectedRelicIndex = parseInt(idxStr, 10);
                        sendTouch({ kind: 'relic_highlight', choiceIndex: selectedRelicIndex });
                      }
                    });
                  });
                }
              }
            } else {
              relicModal.classList.add('hidden');
            }
          }

          // 全局全场修正提示横幅
          if (worldBanner && worldBannerText) {
            if (endlessState.ruleAnnouncement) {
              worldBannerText.textContent = endlessState.ruleAnnouncement;
              worldBanner.classList.remove('hidden');
            } else {
              worldBanner.classList.add('hidden');
            }
          }
        }

        // 胜负结算展示（R02 & R10：准确判断 winnerId 与真实名次）
        if (resultModal) {
          if (state.gameOver && (endlessState?.mode === 'normal' || endlessState?.phase === 'round-result')) {
            resultModal.classList.remove('hidden');
            if (btnRestart) btnRestart.textContent = endlessState?.mode === 'normal' ? '再来一局 (Space)' : '进入下局秘策选择 (Space)';
            const isWinner = state.isWinner === true;
            if (resultTitle) {
              resultTitle.textContent = isWinner
                ? '你赢了！'
                : `${state.winnerName ?? '其他角色'} 获胜`;
            }
            if (resultSub) {
              resultSub.textContent = isWinner
                ? '精彩的合作攒宝与断线分赃决战！'
                : '荒岛形势瞬息万变，换个策略再试一次！';
            }
            if (statTreasure) statTreasure.textContent = String(pTreas);
            if (statBreaks) statBreaks.textContent = String(breaks);
            if (statDisbands) statDisbands.textContent = String(disbands);
            if (statBetrayals) statBetrayals.textContent = String(disbands);
            if (statKills) statKills.textContent = String(state.kills ?? 0);
            const rank = typeof state.playerRank === 'number' ? state.playerRank : isWinner ? 1 : Math.max(2, 11 - aliveCount);
            if (statRank) statRank.textContent = `第 ${rank} 名 / 10`;

            if (challengeProgress) {
              challengeProgress.textContent = `${cMm.toString().padStart(2, '0')}:${cSs.toString().padStart(2, '0')} / 15:00 (共 ${roundsCompleted} 局)`;
            }
          } else {
            resultModal.classList.add('hidden');
          }
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
