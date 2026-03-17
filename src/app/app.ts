import { Component, OnInit, signal, ViewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Config, Message, Messages, Preferences } from '../../server/src/shared-types';
import { forEach, htmlUnescape, isEqual } from '@tubular/util';
import { FormsModule } from '@angular/forms';
import { PreferencesService } from '../preferences.service';
import { MessageEntry } from '../message-entry/message-entry';
import { colorByIndex, colorFromStyle, colors, getTextBackground, kaomoji, shouldIgnoreClick, startClickSuppress } from '../main';

const matchEmoji = /(\uD83C[\uD000-\uDFFF]|\uD83D[\uD000-\uDFFF]|\uD83E[\uD000-\uDFFF])/g;

@Component({
  selector: 'app-root',
  imports: [FormsModule, MessageEntry],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  protected colorByIndex = colorByIndex;
  protected colors = colors;

  private readonly chime = new Audio('assets/notify.wav');
  private readonly prefs: Preferences;

  private baseTitle = 'Chat'
  private chatActive = true;
  private lastSelectedText = '';
  private _messageEntry: MessageEntry
  private messageTimer: any;
  private pendingFocus = false;
  private unseenMessages = 0;

  protected color = signal(0);
  protected connectionTrouble = signal(false);
  protected darkMode = signal(false);
  protected email= signal('');
  protected inChat = signal(false);
  protected localTime = signal(true);
  protected messages = signal([] as Message[]);
  protected name = signal('');
  protected newOnBottom = signal(true);
  protected navigation = signal([] as { name: string, url: string; target?: string }[]);
  protected notifySound = signal(true);
  protected participants = signal([] as string[]);
  protected showThemes = signal(false);
  protected title = signal(this.baseTitle);
  protected toolHash = signal('');
  protected toolTimer: any;
  protected tripCode = signal('');

  get messageEntry(): MessageEntry { return this._messageEntry; }
  @ViewChild(MessageEntry) set messageEntry(value: MessageEntry) {
    this._messageEntry = value;

    if (this.pendingFocus) {
      this.pendingFocus = false;
      this.messageEntry?.focus(this.color());
    }
    else
      this.messageEntry?.setColor(this.color());
  }

  constructor(private httpClient: HttpClient, private prefService: PreferencesService) {
    this.prefs = this.prefService.get();
    forEach(this.prefs as Record<string, any>, (key, value) => (this as any)[key] && (this as any)[key]?.set(value));
    this.setTheme(this.prefs.theme);

    const configStr = localStorage.getItem('gchat-config');
    const root = document.documentElement;

    if (configStr) {
      try {
        const config = JSON.parse(configStr) as Config;

        document.title = this.baseTitle = config.title;
        this.title.set(config.title);
        this.navigation.set(config.navigation);
        root.style.setProperty('--primary-bkg', config.backgroundColor || '#DDD');
      }
      catch {}
    }

    httpClient.get<Config>('/api/config').subscribe({
      next: (config: Config): void => {
        this.connectionTrouble.set(false);
        document.title = config.title;
        this.title.set(config.title);
        this.navigation.set(config.navigation);
        root.style.setProperty('--primary-bkg', config.backgroundColor || '#DDD');
        localStorage.setItem('gchat-config', JSON.stringify(config));
      },
      error: (_error): void => this.connectionTrouble.set(true)
    });

    document.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape' && this.showThemes()) {
        this.showThemes.set(false);
        event.preventDefault();
      }
    })

    document.addEventListener('mousedown', (evt: MouseEvent) => {
      if (!document.getElementById('theme-select')?.contains(evt.target as Node) && this.showThemes()) {
        this.showThemes.set(false);
        evt.preventDefault();
        startClickSuppress();
      }
    })

    document.addEventListener('mouseup', () => setTimeout(() => this.lastSelectedText = window.getSelection().toString()));

    document.addEventListener('visibilitychange', () => this.checkChatActive());
    window.addEventListener('blur', () => this.checkChatActive());
    window.addEventListener('focus', () => this.checkChatActive());
  }

  ngOnInit(): void {
    this.getMessages();
  }

  private checkChatActive(): void {
    this.chatActive = document.hasFocus() && !document.hidden;

    if (this.chatActive) {
      this.unseenMessages = 0;
      document.title = this.baseTitle;
    }
  }

  private repollMessages(): void {
    this.messageTimer = setTimeout(() => this.getMessages(), 10000);
  }

  protected getMessages(): void {
    if (this.messageTimer) {
      clearTimeout(this.messageTimer);
      this.messageTimer = undefined;
    }

    this.httpClient.get<Messages>('/api/messages', { params: { name: this.name() }}).subscribe({
      next: (messages: Messages): void => {
        if (!messages.errorMessage) {
          this.connectionTrouble.set(false);

          if (!this.newOnBottom())
            messages.messages.reverse();

          if (!isEqual(this.messages(), messages.messages)) {
            if (this.messages().length > 0 && !this.chatActive) {
              this.unseenMessages++;
              document.title = `(${this.unseenMessages}) ${this.baseTitle}`;

              if (this.prefs.notifySound)
                this.chime.play().finally();
            }

            this.messages.set(messages.messages);
            this.adjustScrolling();
          }

          this.participants.set(messages.participants);
        }
        else
          this.connectionTrouble.set(true);

        this.repollMessages();
      },
      error: (_error): void => {
        this.connectionTrouble.set(true);
        this.repollMessages();
      }
    });
  }

  protected updateColor(): void {
    this.prefs.color = this.color();
    this.prefService.set(this.prefs);
  }

  protected enterChat(): void {
    this.prefs.name = this.name();
    this.prefs.email = this.email();
    this.prefService.set(this.prefs);

    if (this.prefs.name.includes('#')) {
      [this.prefs.name, this.prefs.tripCode] = this.prefs.name.split('#');
      this.name.set(this.prefs.name);
      this.tripCode.set(this.prefs.tripCode);
    }

    this.httpClient.post('/api/enter', {}, { params: this.prefs as any }).subscribe({
      next: (): void => {
        this.connectionTrouble.set(false)
        this.pendingFocus = true;
        this.inChat.set(true);
        setTimeout(() => this.adjustScrolling(), 250);
      },
      error: (_error): void => {
        this.connectionTrouble.set(true);
        this.inChat.set(false);
      }
    });
  }

  protected leaveChat(): void {
    this.httpClient.post('/api/leave', {}, { params: this.prefs as any }).subscribe({
      next: (): void => {
        this.connectionTrouble.set(false)
        this.inChat.set(false);
        setTimeout(() => this.adjustScrolling());
      },
      error: (_error): void => this.connectionTrouble.set(true)
    });
  }

  protected sendComment(comment: string): void {
    if (!comment?.trim())
      return;

    this.messageEntry.sendEnabled(false);

    const params = { ...this.prefs, comment };

    this.httpClient.post('/api/send', {}, { params }).subscribe({
      next: (): void => {
        this.connectionTrouble.set(false)
        this.inChat.set(true);
        this.messageEntry.reset();
        setTimeout(() => this.getMessages(), 500);
      },
      error: (_error): void => {
        this.connectionTrouble.set(true);
        this.messageEntry.sendEnabled(true);
      }
    });
  }

  protected formatLocal(timestamp: string): string {
    return new Date(timestamp + 'Z').toLocaleString();
  }

  protected adjustMarkup(text: string): string {
    return text.replace(matchEmoji, '<span class="big-emoji">$1</span>')
      .replace(/(\u2000(.+?)\u2000)/g, (_$0, $1, $2) =>
        kaomoji.includes($2) ? `<span class="kaomoji">${$1}</span>` : $1
      );
  }

  protected toggleNotifySound(): void {
    this.prefs.notifySound = this.notifySound();
    this.prefService.set(this.prefs);
  }

  protected toggleLocalTime(): void {
    this.prefs.localTime = this.localTime();
    this.prefService.set(this.prefs);
  }

  protected setColor(color: number): void {
    this.color.set(color);
    this.prefs.color = color;
    this.prefService.set(this.prefs);
  }

  protected toggleMessageOrder(): void {
    this.prefs.newOnBottom = this.newOnBottom();
    this.prefService.set(this.prefs);
    this.messages.set(this.messages().reverse());
    this.adjustScrolling();
    this.pendingFocus = true;
  }

  protected isMe(message: Message): boolean {
    return message.name === this.name();
  }

  protected isAdmin(): boolean {
    return false;
  }

  protected focusMessage(message: Message, state: boolean): void {
    if (state) {
      if (this.toolTimer) {
        clearTimeout(this.toolTimer);
        this.toolTimer = undefined;
      }

      this.toolHash.set(message.hash);
    }
    else if (this.toolHash() === message.hash)
      this.toolTimer = setTimeout(() => this.toolHash.set(''), 2000);
  }

  protected quoteMessage(message: Message): void {
    let quote = htmlUnescape(message.text.replace(/<.+?>/g, '')).replace(/\s+/g, ' ');

    if (this.lastSelectedText && quote.includes(this.lastSelectedText))
      quote = this.lastSelectedText;

    this.messageEntry.insertQuote(message.name, quote.trim());
  }

  protected editMessage(_message: Message): void {
    alert('Not yet implemented');
  }

  protected deleteMessage(_message: Message): void {
    alert('Not yet implemented');
  }

  protected isFocused(message: Message) {
    return this.inChat() && this.toolHash() === message.hash;
  }

  private adjustScrolling(): void {
    setTimeout(() => {
      const messages = document.querySelector('#message-list');

      if (this.newOnBottom())
        messages.scrollTop = messages.scrollHeight;
      else
        messages.scrollTop = 0;
    });
  }

  protected setTheme(theme: string) {
    if (shouldIgnoreClick())
      return;

    Array.from(document.body.classList).forEach(c => c.startsWith('theme-') && document.body.classList.remove(c));

    if (theme)
      document.body.classList.add(`theme-${theme}`);

    this.showThemes.set(false);
    this.darkMode.set(/\bdark\b/.test(theme));

    if (this.darkMode())
      document.body.classList.add(`theme-dark`);

    this.prefs.theme = theme;
    this.prefService.set(this.prefs);
    setTimeout(() => this.messageEntry?.updateColor(false));
  }

  protected getColor(message: Message) {
    let color = colorFromStyle(message.style);

    if (this.darkMode() && (color === '#000' || color === '#000000' || color === 'black'))
      color = '#DDD';

    return color;
  }

  protected getBackground(message: Message) {
    return getTextBackground(this.getColor(message), this.darkMode());
  }
}
