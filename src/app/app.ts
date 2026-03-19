import { Component, OnInit, signal, ViewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Config, Message, Messages, Preferences } from '../../server/src/shared-types';
import { forEach } from '@tubular/util';
import { FormsModule } from '@angular/forms';
import { PreferencesService } from '../preferences.service';
import { FileUploadEvent, MessageEntry } from '../message-entry/message-entry';
import { shouldIgnoreClick, startClickSuppress } from '../main';
import { applyTheme, getThemeMenuStyle, getThemes } from '../themes';
import { MessageList } from '../message-list/message-list';
import { ColorSelector } from '../color-selector/color-selector';
import { Uploader } from '../uploader';

const REPOLL_RATE = 10000;

@Component({
  selector: 'chat-root',
  imports: [ColorSelector, FormsModule, MessageEntry, MessageList],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  protected getThemeMenuStyle = getThemeMenuStyle;
  protected themes = getThemes();

  private readonly chime = new Audio('assets/notify.wav');
  private readonly prefs: Preferences;

  // noinspection TypeScriptFieldCanBeMadeReadonly
  private baseTitle = 'Chat';
  private chatActive = true;
  private _color = 0;
  private lastMessageId: string;
  private _messageEntry: MessageEntry;
  private messageTimer: any;
  private pendingFocus = false;
  private unseenMessages = 0;
  private uploader: Uploader;

  protected connectionTrouble = signal(false);
  protected darkMode = signal(false);
  protected email= signal('');
  protected inChat = signal(false);
  protected localTime = signal(true);
  protected messageEntrySignal = signal<MessageEntry>(undefined);
  protected messages = signal([] as Message[]);
  protected name = signal('');
  protected newOnBottom = signal(true);
  protected navigation = signal([] as { name: string, url: string; target?: string }[]);
  protected notifySound = signal(true);
  protected participants = signal([] as string[]);
  protected showThemes = signal(false);
  protected title = signal(this.baseTitle);
  protected tripCode = signal('');

  get color(): number { return this._color; }
  set color(value: number) {
    if (this._color !== value) {
      this._color = value;
      this.updateColor();
    }
  }

  get messageEntry(): MessageEntry { return this._messageEntry; }
  @ViewChild(MessageEntry) set messageEntry(value: MessageEntry) {
    if (this._messageEntry !== value) {
      this._messageEntry = value;
      setTimeout(() => this.messageEntrySignal.set(value), 0);

      if (this.pendingFocus) {
        this.pendingFocus = false;
        this.messageEntry?.focus(this.color);
      }
      else
        this.messageEntry?.setColor(this.color);
    }
  }

  constructor(private httpClient: HttpClient, private prefService: PreferencesService) {
    this.uploader = new Uploader(this.httpClient);
    this.prefs = this.prefService.get();
    forEach(this.prefs as Record<string, any>, (key, value) => (this as any)[key] && (this as any)[key]?.set(value));

    const configStr = localStorage.getItem('gchat-config');
    const root = document.documentElement;

    if (configStr) {
      try {
        const config = JSON.parse(configStr) as Config;

        document.title = this.baseTitle = config.title;
        this.title.set(config.title);
        this.navigation.set(config.navigation);
        root.style.setProperty('--primary-background', config.backgroundColor || '#DDD');
      }
      catch {}
    }

    this.setTheme(this.prefs.theme);

    httpClient.get<Config>('/api/config').subscribe({
      next: (config: Config): void => {
        this.connectionTrouble.set(false);
        document.title = config.title;
        this.title.set(config.title);
        this.navigation.set(config.navigation);
        root.style.setProperty('--primary-background', config.backgroundColor || '#DDD');
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
    this.messageTimer = setTimeout(() => this.getMessages(), REPOLL_RATE);
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
          this.checkChatActive();

          let newMessageCount = 1;
          const previousLastMessageIndex = this.lastMessageId ?
            messages.messages.findIndex(m => m.hash === this.lastMessageId) : -1;

          if (previousLastMessageIndex >= 0)
            newMessageCount = messages.messages.length - previousLastMessageIndex - 1;

          this.lastMessageId = messages.messages.at(-1).hash;

          if (!this.newOnBottom())
            messages.messages.reverse();

          if (previousLastMessageIndex !== messages.messages.length - 1) {
            if (this.messages().length > 0 && !this.chatActive) {
              this.unseenMessages += newMessageCount;
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
    this.prefs.color = this.color;
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

  protected upload(evt: FileUploadEvent): void {
    this.uploader.upload(evt.file, evt.quill, this.tripCode());
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
    this.color = color;
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

  protected isAdmin(): boolean {
    return false;
  }

  private adjustScrolling(): void {
    setTimeout(() => {
      const messages = document.querySelector('chat-message-list');

      if (this.newOnBottom())
        messages.scrollTop = messages.scrollHeight;
      else
        messages.scrollTop = 0;
    });
  }

  protected setTheme(theme: string): void {
    if (shouldIgnoreClick())
      return;

    applyTheme(theme);
    this.showThemes.set(false);
    this.darkMode.set(this.themes.find(t => t.name === theme)?.darkMode || false);
    this.prefs.theme = theme;
    this.prefService.set(this.prefs);
    setTimeout(() => this.messageEntry?.updateColor(false));
  }
}
