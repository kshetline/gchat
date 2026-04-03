import { ChangeDetectorRef, Component, effect, OnInit, signal, ViewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Config, Message, Messages, ParticipantInfo, Preferences } from '../../server/src/shared-types';
import { clone, forEach, isAndroid, isEqual } from '@tubular/util';
import { FormsModule } from '@angular/forms';
import { PreferencesService } from '../preferences.service';
import { FileUploadEvent, MessageEntry, MessageUpdateEvent } from '../message-entry/message-entry';
import { awaitMessage, NotificationHandler, notify, registerNotificationHandler, shouldIgnoreClick, startClickSuppress } from '../main';
import { applyTheme, getThemeMenuStyle, getThemes, resetDefaultThemeBackground } from '../themes';
import { EditEvent, MessageList } from '../message-list/message-list';
import { ColorSelector } from '../color-selector/color-selector';
import { Uploader } from '../uploader';

const REPOLL_RATE = 5000;

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

  private activity = false;
  // noinspection TypeScriptFieldCanBeMadeReadonly
  private baseTitle = 'Chat';
  private chatActive = true;
  private confirmCallback: (approved: boolean) => void;
  private lastMessageId: string;
  private _messageEntry: MessageEntry;
  private messageTimer: any;
  private pendingFocus = false;
  private unseenMessages = 0;
  private uploader: Uploader;

  protected color = signal(0);
  protected connectionTrouble = signal(false);
  protected darkMode = signal(false);
  protected email = signal('');
  protected framed = /\bframed=true\b/.test(location.toString());
  protected inChat = signal(false);
  protected localTime = signal(true);
  protected maxFileSizeInMb = signal(15000);
  protected messageEntrySignal = signal<MessageEntry>(undefined);
  protected messages = signal([] as Message[]);
  protected name = signal('');
  protected newOnBottom = signal(true);
  protected navigation = signal([] as { name: string; url: string; target?: string }[]);
  protected notificationMessage = signal('');
  protected notificationType = signal('');
  protected notifySound = signal(true);
  protected participants = signal([] as ParticipantInfo[]);
  protected showConfirmation = signal(false);
  protected showNotification = signal(false);
  protected showThemes = signal(false);
  protected title = signal(this.baseTitle);
  protected tripCode = signal('');

  get messageEntry(): MessageEntry { return this._messageEntry; }
  @ViewChild(MessageEntry) set messageEntry(value: MessageEntry) {
    if (this._messageEntry !== value) {
      this._messageEntry = value;
      setTimeout(() => this.messageEntrySignal.set(value), 0);

      if (this.pendingFocus && !isAndroid())
        this.messageEntry?.focus(this.color());
      else
        this.messageEntry?.setColor(this.color());

      this.pendingFocus = false;
    }
  }

  constructor(private httpClient: HttpClient, private prefService: PreferencesService, private changeRef: ChangeDetectorRef) {
    this.uploader = new Uploader(this.httpClient);
    this.prefs = this.prefService.get();
    forEach(this.prefs as Record<string, any>, (key, value) => (this as any)[key] && (this as any)[key]?.set(value));

    const configStr = localStorage.getItem('gchat-config');
    const root = document.documentElement;

    if (configStr) {
      try {
        const config = JSON.parse(configStr) as Config;

        document.title = this.baseTitle = config.title;
        parent.postMessage(['updateTitle', config.title], '*');
        this.title.set(config.title);
        root.style.setProperty('--primary-background', config.backgroundColor || '#DDD');
        this.navigation.set(config.navigation);
        this.maxFileSizeInMb.set(config.fileSizeLimitInMb || 15000);
      }
      catch {}
    }

    this.setTheme(this.prefs.theme);

    httpClient.get<Config>('/api/config').subscribe({
      next: (config: Config): void => {
        root.style.setProperty('--primary-background', config.backgroundColor || '#DDD');
        resetDefaultThemeBackground();
        this.setTheme(this.prefs.theme);
        this.connectionTrouble.set(false);
        document.title = config.title;
        parent.postMessage(['updateTitle', config.title], '*');
        this.title.set(config.title);
        this.navigation.set(config.navigation);
        this.maxFileSizeInMb.set(config.fileSizeLimitInMb || 15000);
        localStorage.setItem('gchat-config', JSON.stringify(config));
      },
      error: (_error): void => this.connectionTrouble.set(true)
    });

    document.addEventListener('keydown', (event: KeyboardEvent) => {
      this.activity = true;

      if (event.key === 'Escape' && this.showNotification()) {
        this.showNotification.set(false);
        event.preventDefault();
      }
      else if (event.key === 'Escape' && this.showThemes()) {
        this.showThemes.set(false);
        event.preventDefault();
      }
      else if (event.key === 'Escape' && this.showConfirmation()) {
        this.showConfirmation.set(false);
        this.confirmCallback && this.confirmCallback(false);
        event.preventDefault();
      }
      else if (event.key === 'Escape') {
        this.messageEntry.cancelEdit();
        event.preventDefault();
      }
      else if (event.key === 'Enter' && this.showConfirmation()) {
        this.showConfirmation.set(false);
        this.confirmCallback && this.confirmCallback(true);
        event.preventDefault();
      }
      else if (event.key === 'Enter' && this.name().trim() && !this.inChat()) {
        this.enterChat().finally();
        event.preventDefault();
      }
    });

    document.addEventListener('mousedown', (evt: MouseEvent) => {
      this.activity = true;

      if (!document.getElementById('theme-select')?.contains(evt.target as Node) && this.showThemes()) {
        this.showThemes.set(false);
        evt.preventDefault();
        startClickSuppress();
      }
    });

    document.addEventListener('visibilitychange', () => this.checkChatActive(true));
    window.addEventListener('blur', () => this.checkChatActive(true));
    window.addEventListener('focus', () => this.checkChatActive(true));
    window.addEventListener('mousemove', () => this.activity = true);
    window.addEventListener('beforeunload', () => this.inChat() && this.leaveChat());

    effect(() => this.prefs.color = this.color());
  }

  ngOnInit(): void {
    registerNotificationHandler(this.notify);
    this.initToken().then(() => this.getMessages());
  }

  private async initToken(): Promise<void> {
    if (!localStorage.getItem('chat-token')) {
      const { token } = await firstValueFrom(this.httpClient.get<{ token: string }>('/api/token'));
      localStorage.setItem('chat-token', token);
    }
  }

  notify: NotificationHandler = (type, message): void => {
    this.notificationType.set(type);
    this.notificationMessage.set(message);
    this.showNotification.set(true);
  };

  protected hideNotification() {
    this.showNotification.set(false);
  }

  protected confirm() {
    this.showConfirmation.set(false);
    this.confirmCallback && this.confirmCallback(true);
  }

  protected dontConfirm() {
    this.showConfirmation.set(false);
    this.confirmCallback && this.confirmCallback(false);
  }

  private checkChatActive(active?: boolean): void {
    if (active)
      this.chatActive = active;

    this.chatActive = document.hasFocus() && !document.hidden;

    if (this.chatActive) {
      this.unseenMessages = 0;
      document.title = this.baseTitle;
      parent.postMessage(['updateTitle', this.baseTitle], '*');
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

    const wasActive = this.activity;
    this.activity = false;

    this.httpClient.get<Messages>('/api/messages',
      { params: { name: this.name(), tripCode: this.tripCode(), active: wasActive, force: this.messages().length < 1 } }).subscribe({
      next: (messages: Messages): void => {
        if (!messages.errorMessage) {
          this.connectionTrouble.set(false);
          this.checkChatActive();

          if (!isEqual(messages.messages, [null])) {
            let newMessageCount = 1;
            const previousLastMessageIndex = this.lastMessageId ?
              messages.messages.findIndex(m => m.hash === this.lastMessageId) : -1;

            if (previousLastMessageIndex >= 0)
              newMessageCount = messages.messages.length - previousLastMessageIndex - 1;

            this.lastMessageId = messages.messages.at(-1).hash;

            if (!this.newOnBottom())
              messages.messages.reverse();

            const changed = !isEqual(messages.messages, this.messages());

            if (changed || previousLastMessageIndex !== messages.messages.length - 1) {
              if (this.messages().length > 0 && !this.chatActive) {
                this.unseenMessages += newMessageCount;
                document.title = `(${this.unseenMessages}) ${this.baseTitle}`;
                parent.postMessage(['updateTitle', document.title], '*');

                if (this.prefs.notifySound)
                  this.chime.play().finally();
              }

              this.messages.set(messages.messages);
              this.adjustScrolling(true);
            }
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

  protected async enterChat(): Promise<void> {
    this.prefs.name = this.name();
    this.prefs.email = this.email();
    this.prefService.set(this.prefs);

    if (this.framed) {
      setTimeout(() => parent.postMessage(['enterChatRoom', this.name(), this.email(), this.color()], '*'));
      const error = await awaitMessage('enterChatRoom', 5000);

      if (error) {
        notify('error', error);
        return;
      }
    }

    if (this.prefs.name.includes('#')) {
      [this.prefs.name, this.prefs.tripCode] = this.prefs.name.split('#');
      this.name.set(this.prefs.name);
      this.tripCode.set(this.prefs.tripCode);
    }

    const params = { ...this.prefs, framed: this.framed };

    this.httpClient.post('/api/enter', {}, { params }).subscribe({
      next: (): void => {
        this.connectionTrouble.set(false);
        this.pendingFocus = true;
        this.inChat.set(true);
        this.changeRef.detectChanges();
        setTimeout(() => this.adjustScrolling(), 250);
      },
      error: (error): void => {
        if (error.status === 400 && error.error?.error)
          notify('error', error.error.error);
        else
          this.connectionTrouble.set(true);

        this.repollMessages();
      }
    });
  }

  protected async leaveChat(): Promise<void> {
    if (this.framed) {
      setTimeout(() => parent.postMessage(['leaveChatRoom'], '*'));
      const error = await awaitMessage('leaveChatRoom', 5000);

      if (error) {
        notify('error', error);
        return;
      }
    }

    const params = { ...this.prefs, framed: this.framed };

    this.httpClient.post('/api/leave', {}, { params }).subscribe({
      next: (): void => {
        this.connectionTrouble.set(false);
        this.inChat.set(false);
        setTimeout(() => this.adjustScrolling());
      },
      error: (_error): void => this.connectionTrouble.set(true)
    });
  }

  protected async sendComment(comment: string): Promise<void> {
    if (!comment?.trim())
      return;

    this.messageEntry.sendEnabled(false);

    if (this.framed) {
      setTimeout(() => parent.postMessage(['sendChatMessage', comment, this.color(), this.tripCode()], '*'));
      const error = await awaitMessage('sendChatMessage', 5000);

      if (error) {
        notify('error', error);
        this.messageEntry.sendEnabled(true);
        return;
      }
    }

    const params = { ...this.prefs, comment, framed: this.framed };

    this.httpClient.post('/api/send', {}, { params }).subscribe({
      next: (): void => {
        this.connectionTrouble.set(false);
        this.inChat.set(true);
        this.changeRef.detectChanges();
        this.messageEntry.reset();
        setTimeout(() => this.getMessages(), 500);
      },
      error: (_error): void => {
        this.connectionTrouble.set(true);
        this.messageEntry.sendEnabled(true);
      }
    });
  }

  protected editMessage(evt: EditEvent): void {
    this.messageEntry.editMessage(evt);
  }

  protected updateMessage(evt: MessageUpdateEvent): void {
    const params = clone(evt) as any;

    delete params.callback;
    params.name = this.name();
    params.tripCode = this.tripCode();

    this.httpClient.put('/api/update', null, { params }).subscribe({
      next: (): void => {
        evt.callback && evt.callback(true);
        setTimeout(() => this.getMessages(), 500);
      },
      error: (error): void => {
        notify('error', error.error?.error || 'Failed to update message');
        console.error(error);
        evt.callback && evt.callback(false);
      }
    });
  }

  protected deleteMessage(msgId: number): void {
    this.notificationMessage.set('Are you sure you want to delete this message?');
    this.showConfirmation.set(true);
    this.confirmCallback = (approved: boolean): void => {
      if (approved) {
        const params = { msgId, name: this.name(), tripCode: this.tripCode() };

        this.httpClient.delete('/api/delete', { params }).subscribe({
          next: (): void => {
            setTimeout(() => this.getMessages(), 500);
          },
          error: (error): void => {
            notify('error', error.error?.error || 'Failed to delete message');
            console.error(error);
          }
        })
      }
    }
  }

  protected async upload(evt: FileUploadEvent): Promise<void> {
    await this.uploader.upload(evt.file, evt.quill, this.name(), this.tripCode());
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

  protected isAdmin(): boolean {
    return false;
  }

  private adjustScrolling(onlyWhenClose = false): void {
    const messages = document.querySelector('chat-message-list .message-content');
    // Need to check closeness before any new messages are added.
    const close = this.newOnBottom() ?
      messages.scrollTop >= messages.scrollHeight - messages.clientHeight - 30 :
      messages.scrollTop <= 30;

    setTimeout(() => {
      if (this.newOnBottom() && (!onlyWhenClose || close)) {
        messages.scrollTop = messages.scrollHeight;

        if (isAndroid())
          setTimeout(() => messages.scrollTop = messages.scrollHeight, 250);
      }
      else if (!this.newOnBottom() && (!onlyWhenClose || close))
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

  protected revert(): void {
    this.notificationMessage.set('Revert to original chat room style and features?');
    this.showConfirmation.set(true);
    this.confirmCallback = (approved: boolean): void => {
      if (approved)
        parent.postMessage(['revert'], '*');
    }
  }
}
