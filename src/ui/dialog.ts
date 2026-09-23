/**
 * 遊戲式對話框：名牌 + 打字機文字 + 繼續指示。
 * 文字顯示進度由 SpeechPlayer 決定，所以字與嘴型同步。
 * Phase 2 會在這裡加上選項按鈕（agent 呼叫 ask 工具時）。
 */
export class DialogBox {
  private root: HTMLElement;
  private nameEl: HTMLElement;
  private textEl: HTMLElement;
  private hideTimer = 0;
  private lastKey = '';

  constructor(parent: HTMLElement, onClick: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'dialog';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="dialog-name"></div>
      <div class="dialog-text"></div>
      <div class="dialog-next" aria-hidden="true">▼</div>`;
    this.nameEl = this.root.querySelector('.dialog-name')!;
    this.textEl = this.root.querySelector('.dialog-text')!;
    this.root.addEventListener('click', onClick);
    parent.appendChild(this.root);
  }

  update(d: { name: string; text: string; revealed: number; speaking: boolean } | null): void {
    if (!d) return;
    const key = `${d.name}|${d.text}|${d.revealed}|${d.speaking}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    window.clearTimeout(this.hideTimer);
    this.root.hidden = false;
    this.root.classList.remove('fading');
    this.nameEl.textContent = d.name;
    this.nameEl.hidden = !d.name;
    // 已顯示的部分 + 未顯示部分（透明佔位，避免文字換行時跳動）
    this.textEl.innerHTML = '';
    const shown = document.createElement('span');
    shown.textContent = d.text.slice(0, d.revealed);
    const rest = document.createElement('span');
    rest.className = 'dialog-ghost';
    rest.textContent = d.text.slice(d.revealed);
    this.textEl.append(shown, rest);
    this.root.classList.toggle('done', !d.speaking);
    if (!d.speaking) {
      this.hideTimer = window.setTimeout(() => {
        this.root.classList.add('fading');
        this.hideTimer = window.setTimeout(() => (this.root.hidden = true), 600);
      }, 9000);
    }
  }
}
