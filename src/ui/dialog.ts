/**
 * 遊戲式對話框：名牌 + 打字機文字 + 繼續指示 + 選項。
 * 文字顯示進度由 SpeechPlayer 決定，所以字與嘴型同步。
 * 選項在台詞唸完後才浮現（像遊戲的選擇肢），唸的途中不會先跳出來。
 */

export interface Choices {
  id: string;
  options: string[];
  allowText: boolean;
  onAnswer: (index: number, text: string) => void;
}

export class DialogBox {
  private root: HTMLElement;
  private nameEl: HTMLElement;
  private textEl: HTMLElement;
  private choicesEl: HTMLElement;
  private hideTimer = 0;
  private lastKey = '';
  private choices: Choices | null = null;

  constructor(parent: HTMLElement, onClick: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'dialog';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="dialog-name"></div>
      <div class="dialog-text"></div>
      <div class="dialog-choices"></div>
      <div class="dialog-next" aria-hidden="true">▼</div>`;
    this.nameEl = this.root.querySelector('.dialog-name')!;
    this.textEl = this.root.querySelector('.dialog-text')!;
    this.choicesEl = this.root.querySelector('.dialog-choices')!;
    this.root.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.dialog-choices')) onClick();
    });
    // 數字鍵快速選擇
    window.addEventListener('keydown', (e) => {
      if (!this.choices || !this.root.classList.contains('done')) return;
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const n = Number(e.key);
      if (n >= 1 && n <= this.choices.options.length) this.pick(n - 1, this.choices.options[n - 1]);
    });
    parent.appendChild(this.root);
  }

  private show(): void {
    window.clearTimeout(this.hideTimer);
    this.root.hidden = false;
    this.root.classList.remove('fading');
  }

  private scheduleHide(ms: number): void {
    window.clearTimeout(this.hideTimer);
    if (this.choices) return; // 等待回答時不收起
    this.hideTimer = window.setTimeout(() => {
      this.root.classList.add('fading');
      this.hideTimer = window.setTimeout(() => (this.root.hidden = true), 600);
    }, ms);
  }

  private render(name: string, text: string, revealed: number): void {
    this.nameEl.textContent = name;
    this.nameEl.hidden = !name;
    // 已顯示的部分 + 未顯示部分（透明佔位，避免文字換行時跳動）
    const shown = document.createElement('span');
    shown.textContent = text.slice(0, revealed);
    const rest = document.createElement('span');
    rest.className = 'dialog-ghost';
    rest.textContent = text.slice(revealed);
    this.textEl.replaceChildren(shown, rest);
  }

  update(d: { name: string; text: string; revealed: number; speaking: boolean } | null): void {
    if (!d) return;
    const key = `${d.name}|${d.text}|${d.revealed}|${d.speaking}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.show();
    this.root.classList.remove('user');
    this.render(d.name, d.text, d.revealed);
    this.root.classList.toggle('done', !d.speaking);
    if (!d.speaking) this.scheduleHide(9000);
  }

  /** 顯示使用者自己的回答 */
  showUserLine(name: string, text: string): void {
    this.lastKey = '';
    this.show();
    this.root.classList.add('user', 'done');
    this.render(name, text, text.length);
    this.scheduleHide(2500);
  }

  showChoices(c: Choices): void {
    this.choices = c;
    this.choicesEl.replaceChildren();
    c.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.className = 'choice';
      b.style.setProperty('--i', String(i));
      b.innerHTML = `<span class="choice-key">${i + 1}</span>`;
      b.append(opt);
      b.addEventListener('click', () => this.pick(i, opt));
      this.choicesEl.appendChild(b);
    });
    if (c.allowText) {
      const form = document.createElement('form');
      form.className = 'choice-text';
      form.style.setProperty('--i', String(c.options.length));
      form.innerHTML = `<input type="text" maxlength="500" placeholder="輸入回覆…" /><button type="submit">送出</button>`;
      const input = form.querySelector('input')!;
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (v) this.pick(-1, v);
      });
      this.choicesEl.appendChild(form);
    }
    this.root.classList.add('has-choices');
    this.show();
  }

  clearChoices(id?: string): void {
    if (!this.choices || (id && this.choices.id !== id)) return;
    this.choices = null;
    this.choicesEl.replaceChildren();
    this.root.classList.remove('has-choices');
    if (this.root.classList.contains('done')) this.scheduleHide(1500);
  }

  private pick(index: number, text: string): void {
    const c = this.choices;
    if (!c) return;
    this.clearChoices();
    c.onAnswer(index, text);
  }
}
