import { ChangeDetectorRef, Component, inject, OnInit, signal, ViewChild, WritableSignal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  Config, DmSession, NotifySound, Message, Messages, ParticipantInfo, Preferences, TypingStatus, MAX_DM_AGE
} from '../../server/src/shared-types';
import { clone, forEach, isAndroid, isEqual, processMillis } from '@tubular/util';
import { FormsModule } from '@angular/forms';
import { PreferencesService } from '../preferences.service';
import { FileUploadEvent, MessageEntry, MessageUpdateEvent } from '../message-entry/message-entry';
import {
  NotificationHandler, notify, registerNotificationHandler, setIsTypingFunction, shouldIgnoreClick, startClickSuppress,
  userscriptAction
} from '../main';
import { applyTheme, getThemeMenuStyle, getThemes, resetDefaultThemeBackground } from '../themes';
import { DeleteEvent, EditEvent, MessageList } from '../message-list/message-list';
import { ColorSelector } from '../color-selector/color-selector';
import { Uploader } from '../uploader';
import { TabsModule } from 'primeng/tabs';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { toObservable } from '@angular/core/rxjs-interop';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService } from 'primeng/api';
import { SelectModule } from 'primeng/select';
import { SliderModule } from 'primeng/slider';
import { ToggleButtonModule } from 'primeng/togglebutton';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { isIOS, isSafari } from '@tubular/util';
import ReconnectingWebSocket from 'reconnecting-websocket';

const REPOLL_RATE = 20000; // 20 seconds
const REPOLL_RATE_SLACK = 5000; // 5 seconds
const REPOLL_RATE_QUICK = 5000; // 5 seconds
const REPOLL_RATE_CHECK_PROGRESS = 2500; // 2.5 seconds
const REPOLL_RATE_429 = 60000; // 1 minute
const CONSIDER_AFK_TIME = 600000; // 10 minutes

interface DmInfo {
  closed?: boolean;
  id: number;
  lastEnter?: number;
  lastLeave?: number;
  leftMainChat?: boolean;
  messages: WritableSignal<Message[]>;
  missed: WritableSignal<number>;
  name: string;
  viewed?: boolean;
}

@Component({
  selector: 'chat-root',
  imports: [ColorSelector, ConfirmDialogModule, DecimalPipe, FormsModule, MessageEntry, MessageList,
            NgTemplateOutlet, SelectModule, SliderModule, TabsModule, ToastModule, ToggleButtonModule],
  providers: [MessageService],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  protected getThemeMenuStyle = getThemeMenuStyle;
  protected themes = getThemes();

  private readonly chime = new Audio('assets/notify.wav');
  private readonly chimeDM = new Audio('assets/notifyDM.wav');
  private readonly doorClose = new Audio('assets/door-close.mp3');
  private readonly doorOpen = new Audio('assets/door-open.mp3');
  private readonly messageService = inject(MessageService);
  private readonly prefs: Preferences;

  private activity = false;
  // noinspection TypeScriptFieldCanBeMadeReadonly
  private baseTitle = 'Chat';
  private chatActive = true;
  private confirmCallback: (approved: boolean) => void;
  private dmsJustClosed = new Map<number, number>();
  private lastActive = 0;
  private lastReceiveTime = 0
  private _messageEntry: MessageEntry;
  private messageTimer: any;
  private messageTimerLastDelay = Number.MAX_SAFE_INTEGER;
  private pendingFocus = false;
  private uploader: Uploader;
  private webSocket: ReconnectingWebSocket;

  protected allowDMs = signal(false);
  protected alwaysChanging = signal(1);
  protected color = signal(0);
  protected connectionTrouble = signal(false);
  protected darkMode = signal(false);
  protected disableEditor = signal(false);
  protected dms = signal([] as DmInfo[]);
  protected email = signal('');
  protected framed = /\bframed=true\b/.test(location.toString());
  protected inChat = signal(false);
  protected isIosSafari = signal(isSafari() && isIOS());
  protected lastSuccessfulLegacyPoll = signal(-1);
  protected localTime = signal(true);
  protected messageEntrySignal = signal<MessageEntry>(undefined);
  protected messages = signal([] as Message[]);
  protected name = signal('');
  protected nameLastPolled = '';
  protected newOnBottom = signal(true);
  protected navigation = signal([] as { name: string; url: string; target?: string }[]);
  protected notificationMessage = signal('');
  protected notificationType = signal('');
  protected notifySound = signal('never' as NotifySound);
  protected panelToggle = signal(false);
  protected participants = signal([] as ParticipantInfo[]);
  protected selectedChat = signal(0);
  protected sending = signal(false);
  protected showConfirmation = signal(false);
  protected showNotification = signal(false);
  protected showThemes = signal(false);
  protected title = signal(this.baseTitle);
  protected tripCode = signal('');
  protected typingStatus = {} as TypingStatus;
  protected unseenMessages = signal(0);
  protected volume = signal(3);

  protected notifyOptions = [
    { label: 'No notification sounds', value: 'never' },
    { label: 'Notify in background', value: 'background' },
    { label: 'Notify always', value: 'always' },
  ];

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

  constructor(
    private httpClient: HttpClient,
    private prefService: PreferencesService,
    private changeRef: ChangeDetectorRef,
    private confirmationService: ConfirmationService
  ) {
    this.uploader = new Uploader(this.httpClient);
    setInterval(() => this.alwaysChanging.set(1 + Math.random()), 500);
    this.prefs = this.prefService.get();
    forEach(this.prefs as Record<string, any>, (key, value) => (this as any)[key] && (this as any)[key]?.set(value));

    const configStr = localStorage.getItem('gchat-config');
    const root = document.documentElement;

    if (configStr) {
      try {
        const config = JSON.parse(configStr) as Config;

        this.baseTitle = config.title;
        this.title.set(config.title);
        this.updateTitle();
        root.style.setProperty('--primary-background', config.backgroundColor || '#DDD');
        this.navigation.set(config.navigation);
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
        this.baseTitle = config.title;
        this.title.set(config.title);
        this.updateTitle();
        this.navigation.set(config.navigation);
        this.connectToWebSocket(config.wsPort);
        localStorage.setItem('gchat-config', JSON.stringify(config));
      },
      error: (_error): void => this.connectionTrouble.set(true)
    });

    document.addEventListener('keydown', (event: KeyboardEvent) => {
      this.activity = true;

      if (event.key === 'Escape' && this.showNotification()) {
        event.preventDefault();
        this.showNotification.set(false);
      }
      else if (event.key === 'Escape' && this.showThemes()) {
        event.preventDefault();
        this.showThemes.set(false);
      }
      else if (event.key === 'Escape' && this.showConfirmation()) {
        event.preventDefault();
        this.showConfirmation.set(false);
        this.confirmCallback && this.confirmCallback(false);
      }
      else if (event.key === 'Escape') {
        event.preventDefault();
        this.messageEntry.cancelEdit();
      }
      else if (event.key === 'Enter' && this.showConfirmation()) {
        event.preventDefault();
        this.showConfirmation.set(false);
        this.confirmCallback && this.confirmCallback(true);
      }
      else if (event.key === 'Enter' && this.name().trim() && !this.inChat()) {
        event.preventDefault();
        this.enterMainChat().finally();
      }
      else if (event.key === 'p' && (event.ctrlKey || event.metaKey) && this.framed &&
               this.messageEntry?.getText().trim() === 'peek') {
        event.preventDefault();
        userscriptAction('peek').catch(err => notify('error', err));
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

    let blurTime = Number.MAX_SAFE_INTEGER;

    document.addEventListener('visibilitychange', () => {
      this.checkChatActive(document.hidden ? undefined : true);

      if (document.hidden)
        blurTime = processMillis();
      else
        this.adjustScrolling(processMillis() < blurTime + 15000);
    });

    window.addEventListener('blur', () => { blurTime = processMillis(); this.checkChatActive(); });
    window.addEventListener('focus', () => { this.checkChatActive(true); this.adjustScrolling(processMillis() < blurTime + 15000) });
    window.addEventListener('scroll', () => this.checkChatActive(true));
    window.addEventListener('mousemove', () => (this.activity = true) && (this.lastActive = processMillis()));
    window.addEventListener('beforeunload', () => this.inChat() && this.leaveMainChat());

    toObservable(this.color).subscribe(color => this.prefs.color = color);
    toObservable(this.sending).subscribe(() => this.updateDisableEditor());
    toObservable(this.selectedChat).subscribe(() => this.updateDisableEditor());
    toObservable(this.allowDMs).subscribe(() => this.getMessages());
  }

  ngOnInit(): void {
    registerNotificationHandler(this.notify);
    setIsTypingFunction(this.isTyping);
    this.initToken().then(() => this.getMessages());

    // Make sure message polling is running
    setInterval(() => {
      if (processMillis() > this.lastReceiveTime + REPOLL_RATE + REPOLL_RATE_SLACK)
        this.getMessages();
    }, 1000);
  }

  private connectToWebSocket(wsPort?: number): void {
    if (wsPort < 0 || this.webSocket)
      return;

    const protocol = (/https/.test(location.protocol) ? 'wss' : 'ws');
    const port = (wsPort ?? location.port) || (protocol === 'wss' ? 443 : 80);

    this.webSocket = new ReconnectingWebSocket(`${protocol}://${location.hostname}:${port}`);
    this.webSocket.addEventListener('message', evt => {
      const parts = evt.data.split('\t');
      const message = parts[0];
      const data = parts.length > 1 ? JSON.parse(parts[1]) : undefined;

      switch (message) {
        case 'newDirectMessages':
          this.getDirectMessages();
          break;
        case 'newMessages':
          this.getMessages();
          break;
        case 'typing':
          this.setTypingStatus(data as TypingStatus);
          break;
      }
    });
  }

  private getDirectMessages(): void {
    this.saveTripCode();
    this.httpClient.get<DmSession[]>('/api/dms',
      { params: { name: this.name(), tripCode: this.tripCode(), openDms: this.openDmList() } }).subscribe({
        next: data => {
          if (!(data as any).errorMessage) {
            this.connectionTrouble.set(false);
            this.receiveDirectMessages(data);
          }
          else
            this.connectionTrouble.set(true);
      },
      error: (error): void => {
        this.connectionTrouble.set(true);
        this.repollMessages(error.status === 429 ? REPOLL_RATE_429 : REPOLL_RATE_QUICK);
      }
    });
  }

  private openDmList(): string {
    return this.dms().map(dm => dm.id).join('_');
  }

  private setTypingStatus(ts: TypingStatus): void {
    if (!ts) return;

    const now = processMillis();

    Object.keys(ts).forEach(key => ts[key].since = now - ts[key].since);
    this.typingStatus = ts;
  }

  protected isTyping = (name: string, dm: number): boolean => {
    const ts = this.typingStatus;

    return name !== this.name() && ts && ts[name]?.dm === dm && ts[name]?.since > processMillis() - 5000;
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
    this.lastActive = processMillis();

    if (active)
      this.activity = active;

    this.chatActive = document.hasFocus() && !document.hidden;

    if (this.chatActive) {
      if (this.selectedChat() === 0)
        this.unseenMessages.set(0);
      else {
        const dms = clone(this.dms(), true);

        dms[this.selectedChat() - 1].missed.set(0);
        this.dms.set(dms);
      }

      this.updateTitle();
    }
  }

  private repollMessages(delay = REPOLL_RATE): void {
    if (this.messageTimer && delay >= this.messageTimerLastDelay)
      return;
    else if (this.messageTimer)
      clearTimeout(this.messageTimer);

    this.lastReceiveTime = processMillis() + delay;
    this.messageTimerLastDelay = delay;
    this.messageTimer = setTimeout(() => this.getMessages(), delay);
  }

  private lastGetMessagesTime = -10000;

  protected getMessages(force = false): void {
    if (this.messageTimer) {
      clearTimeout(this.messageTimer);
      this.messageTimer = undefined;
    }

    const now = processMillis();

    if (!force && now - this.lastGetMessagesTime < 2000)
      return;

    this.lastGetMessagesTime = now;
    const wasActive = this.activity;
    this.activity = false;
    const nameChanged = this.name() !== this.nameLastPolled;
    this.nameLastPolled = this.name();

    this.httpClient.get<Messages>('/api/messages',
      {
        params: {
          active: wasActive,
          allowDMs: this.allowDMs(),
          force: this.messages().length < 1 || nameChanged,
          framed: this.framed,
          inChat: this.inChat(),
          name: this.name(),
          openDms: this.openDmList(),
          tripCode: this.tripCode()
        }
      }).subscribe({
      next: (messages: Messages): void => {
        if (!messages.errorMessage) {
          this.lastReceiveTime = processMillis();
          this.connectionTrouble.set(false);
          this.checkChatActive();
          this.lastSuccessfulLegacyPoll.set(messages.lastSuccessfulLegacyPoll);

          if (!isEqual(messages.messages, [null])) {
            const newMessages = (messages.deleteCount || messages.append) ? clone(this.messages(), true) : messages.messages;

            if (messages.deleteCount)
              newMessages.splice(0, messages.deleteCount);

            if (messages.append)
              newMessages.push(...messages.messages);

            // Safety check: Make sure no glitch causes client to choke on an ever-growing message list
            if (newMessages.length > 4000)
              newMessages.splice(newMessages.length - 4000);

            const changed = !isEqual(newMessages, this.messages());
            const newMessageCount = this.countNewMessages(this.messages(), newMessages);

            if (changed) {
              if (this.messages().length > 0) {
                if (!this.chatActive || this.selectedChat() !== 0) {
                  this.unseenMessages.set(this.unseenMessages() + newMessageCount);
                  this.updateTitle();
                }

                if (newMessageCount)
                  this.playNotificationSound();
              }

              this.messages.set(newMessages);
              this.adjustScrolling(true);
            }

            this.enterLeaveCheck(0, newMessages);
          }

          this.participants.set(messages.participants);
        }
        else
          this.connectionTrouble.set(true);

        this.receiveDirectMessages(messages.dms);
        this.messageEntry?.setProgress(messages.progress);
        this.repollMessages(messages.progress > 0 ? REPOLL_RATE_CHECK_PROGRESS : REPOLL_RATE);
      },
      error: (error): void => {
        this.connectionTrouble.set(true);
        this.repollMessages(error.status === 429 ? REPOLL_RATE_429 : REPOLL_RATE_QUICK);
      }
    });
  }

  protected updateTitle(): void {
    const unseen = this.unseenMessages() + this.dms().reduce((sum, dm) => sum + dm.missed(), 0);

    document.title = `${unseen ? '(' + unseen + ') ' : ''}${this.baseTitle}`;
    userscriptAction('updateTitle', document.title).finally();
  }

  protected async enterMainChat(): Promise<void> {
    this.prefs.name = this.name();
    this.prefs.email = this.email();
    this.prefService.set(this.prefs);

    if (this.framed) {
      try {
        await userscriptAction(5000, 'enterChatRoom', this.name(), this.email(), this.color());
      }
      catch (err) {
        notify('error', String(err));
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

        if (this.selectedChat() > 0) {
          const dms = clone(this.dms(), true);

          this.reenterDm(dms[this.selectedChat() - 1]);
          this.dms.set(dms);
        }

        this.changeRef.detectChanges();
        this.delayedAdjustScrolling();
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

  protected async leaveMainChat(): Promise<void> {
    if (this.framed) {
      try {
        await userscriptAction(5000, 'leaveChatRoom');
      }
      catch (err) {
        notify('error', String(err));
        return;
      }
    }

    const params = { ...this.prefs, framed: this.framed };

    this.httpClient.post('/api/leave', {}, { params }).subscribe({
      next: (): void => {
        this.connectionTrouble.set(false);
        this.inChat.set(false);
        this.dms.set(this.dms().map(dm => (dm.leftMainChat = true) && dm));
        this.delayedAdjustScrolling();
      },
      error: (_error): void => this.connectionTrouble.set(true)
    });
  }

  private saveTripCode(): void {
    if (this.prefs.tripCode !== this.tripCode()) {
      this.prefs.tripCode = this.tripCode();
      this.prefService.set(this.prefs);
    }
  }

  protected getDMId(): number {
    return this.selectedChat() === 0 ? 0 : this.dms()[this.selectedChat() - 1]?.id ?? -1;
  }

  protected async sendComment(comment: string): Promise<void> {
    if (this.sending() || !comment?.trim() || (this.selectedChat() > 0 && !await this.verifyAllowingDMs()))
      return;

    this.sending.set(true);
    comment = comment.replace(/[\n\r]+/g, ' ').trimEnd();

    const dm = this.getDMId();

    if (this.framed && dm === 0) {
      try {
        await userscriptAction(10000, 'sendChatMessage', comment, this.color(), this.tripCode());
      }
      catch (err) {
        if (err === 'Timed out')
          err = 'Original chat site not accepting messages. Refreshing your browser might help.';

        notify('error', String(err));
        this.sending.set(false);
        return;
      }
    }

    this.saveTripCode();

    const params = { ...this.prefs, framed: this.framed, dm };

    this.httpClient.post('/api/send', { comment }, { params }).subscribe({
      next: (): void => {
        this.connectionTrouble.set(false);
        this.inChat.set(true);
        this.changeRef.detectChanges();
        this.sending.set(false);
        this.messageEntry.reset();
        setTimeout(() => this.getMessages(true), 500);
      },
      error: (error): void => {
        if (error.error?.error) {
          notify('error', error.error.error);

          if (error.error.closed) {
            const dms = clone(this.dms(), true);
            const dmi = dms.find(d => d.id === dm);

            if (dmi) {
              dmi.closed = true;
              this.dms.set(dms);
              this.tabChanged(this.selectedChat());
              this.updateDisableEditor();
            }
          }
        }
        else
          this.connectionTrouble.set(true);

        this.sending.set(false);
      }
    });
  }

  protected editMessage(evt: EditEvent): void {
    this.messageEntry.editMessage(evt);
  }

  protected updateMessage(evt: MessageUpdateEvent): void {
    this.saveTripCode();

    const params = clone(evt) as any;
    const bbCode = evt.bbCode;

    delete params.callback;
    delete params.bbCode;
    params.name = this.name();
    params.tripCode = this.tripCode();

    this.httpClient.put('/api/update', { bbCode, framed: this.framed }, { params }).subscribe({
      next: (): void => {
        evt.callback && evt.callback(true);
        setTimeout(() => this.getMessages(true), 500);
      },
      error: (error): void => {
        notify('error', error.error?.error || 'Failed to update message');
        console.error(error);
        evt.callback && evt.callback(false);
      }
    });
  }

  protected deleteMessage(evt: DeleteEvent): void {
    this.saveTripCode();
    this.notificationMessage.set('Are you sure you want to delete this message?');
    this.showConfirmation.set(true);
    this.confirmCallback = (approved: boolean): void => {
      if (approved) {
        const params = { chatIndex: evt.chatIndex, framed: this.framed, msgId: evt.msgId, name: this.name(), tripCode: this.tripCode() };

        this.httpClient.delete('/api/delete', { params }).subscribe({
          next: (): void => {
            setTimeout(() => this.getMessages(true), 500);
          },
          error: (error): void => {
            notify('error', error.error?.error || 'Failed to delete message');
            console.error(error);
          }
        })
      }
    }
  }

  protected upload(evt: FileUploadEvent): void {
    const doUpload = () => {
      this.uploader.upload(evt, this.name(), this.tripCode()).finally();
    }

    if (this.selectedChat() > 0) {
      if (!this.tripCode()?.trim() && !evt.external) {
        notify('error', 'You cannot upload files in a private chat with setting a tripcode.');
        return;
      }

      if (!evt.external && !this.prefs.suppressUploadWarning) {
        this.confirmationService.confirm({
          key: 'app',
          message: 'This upload will be visible on the uploader page. ' +
            'Your messages here are private, but uploads are not.<br><br>\nAre you sure you want to proceed?' +
            '<br><br>\nIf you continue, you will not be warned again.',
          header: 'This upload is not private',
          icon: 'pi pi-info-circle',
          rejectLabel: 'Cancel',
          rejectButtonProps: {
            label: 'Cancel',
            severity: 'secondary',
            outlined: true
          },
          acceptButtonProps: {
            label: 'Continue',
            severity: 'danger'
          },
          accept: () => {
            this.prefs.suppressUploadWarning = true;
            this.prefService.set(this.prefs);
            doUpload();
          },
          reject: () => {}
        })

        return;
      }
    }

    doUpload();
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
    this.adjustScrolling();
    this.pendingFocus = true;
  }

  protected toggleAllowDMs(): void {
    this.prefs.allowDMs = this.allowDMs();
    this.prefService.set(this.prefs);
    setTimeout(() => this.getMessages());
  }

  protected isAdmin(): boolean {
    return false;
  }

  private reenterDm(dm: DmInfo): void {
    if (dm?.id && ((!dm.viewed && !dm.closed) || dm.leftMainChat)) {
      dm.viewed = true;
      dm.leftMainChat = false;
      this.httpClient.post('/api/start-chat', { framed: this.framed }, { params: {
          id: dm.id,
          name: dm.name,
          self: this.name(),
          tripCode: this.tripCode(),
        } }).subscribe({ next: () => { } });
    }
  }

  protected tabChanged(value: number | string): void {
    this.selectedChat.set(value as number);
    this.checkChatActive(true);

    if (value as number > 0) {
      const dms = clone(this.dms(), true);
      const dm = dms.at(value as number - 1);

      if (this.chatActive) {
        dm.missed.set(0);
        this.updateTitle();
      }

      if (this.inChat())
        this.reenterDm(dm);

      this.dms.set(dms);
    }

    this.delayedAdjustScrolling();
  }

  private updateDisableEditor(): void {
    this.disableEditor.set(this.sending() || (this.selectedChat() > 0 && !!this.dms()[this.selectedChat() - 1]?.closed));
  }

  protected adjustScrolling(onlyWhenClose = false): void {
    const messages = document.querySelector('p-tabpanel.p-tabpanel-active chat-message-list .message-content');
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

  protected delayedAdjustScrolling(onlyWhenClose = false): void {
    setTimeout(() => this.adjustScrolling(onlyWhenClose), 250);
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
        userscriptAction('revert').catch(err => notify('error', err));
    }
  }

  private async verifyAllowingDMs(): Promise<boolean> {
    if (this.prefs.allowDMs)
      return true;

    return new Promise<boolean>(resolve => {
      this.confirmationService.confirm({
        key: 'app',
        message: 'You can only send direct messages if you allow them yourself.<br><br>\n' +
          'Activate DMs?',
        header: 'Your "Allow DMs" setting is unchecked.',
        icon: 'pi pi-info-circle',
        rejectLabel: 'Not now',
        rejectButtonProps: {
          label: 'Not now',
          severity: 'secondary',
          outlined: true
        },
        acceptButtonProps: {
          label: 'Yes',
          severity: 'success'
        },
        accept: () => {
          this.allowDMs.set(true);
          this.prefs.allowDMs = true;
          this.prefService.set(this.prefs);
          resolve(true);
        },
        reject: () => resolve(false)
      })
    });
  }

  protected async startDmChat(name: string): Promise<void> {
    if (name === this.name() || !await this.verifyAllowingDMs())
      return;

    const match = this.dms().findIndex(dm => dm.name === name);

    if (match >= 0) {
      this.selectedChat.set(match + 1);
      return;
    }

    this.saveTripCode();
    this.notificationMessage.set(`Are you sure you want to DM "${name}"?`);
    this.showConfirmation.set(true);
    this.confirmCallback = (approved: boolean): void => {
      if (!approved)
        return;

      this.httpClient.post<{ id: number }>('/api/start-chat', { framed: this.framed }, {
          params: {
            self: this.name(),
            tripCode: this.tripCode(),
            name
          } }).subscribe({
        next: data => {
          const match = this.dms().findIndex(dm => dm.id === data.id);

          if (match >= 0) {
            this.selectedChat.set(match + 1);
            return;
          }

          const dms = clone(this.dms(), true);

          dms.push({ id: data.id, name, viewed: true, messages: signal<Message[]>([]), missed: signal(0) });
          this.dms.set(dms);
          this.selectedChat.set(dms.length);
        },
        error: (error): void => notify('error', error.error?.error || 'Failed to start chat')
      })
    }
  }

  protected closeDmChat(evt: Event, tabIndex: number): void {
    const dms = clone(this.dms(), true);
    const id = dms[tabIndex].id;
    const viewed = !!dms[tabIndex].viewed;

    this.selectedChat.set(0);
    evt.preventDefault();
    evt.stopPropagation();
    dms.splice(tabIndex, 1);
    this.dms.set(dms);
    this.dmsJustClosed.set(id, processMillis());
    this.httpClient.post('/api/leave-chat', {}, { params: { framed: this.framed, self: this.name(), id, viewed } })
      .subscribe({ next: () => this.changeRef.detectChanges(), error: () => this.changeRef.detectChanges() });
  }

  private countNewMessages(oldMessages: Message[], newMessages: Message[]): number {
    const latest = oldMessages.reduce((acc, msg) => Math.max(acc, !msg.style.match(/^[EL]$/) ? msg.msgId : 0, 0), 0);

    return newMessages.reduce((acc, msg) => acc + (!msg.isMe && !msg.style.match(/^[EL]$/) && msg.msgId > latest ? 1 : 0), 0);
  }

  private enterLeaveCheck(dm: number, messages: Message[]): void {
    let dms = this.dms();
    let entered = false;
    let left = false;

    if (!dms[-1]) {
      dms[-1] = { lastEnter: Date.now() / 1000, lastLeave: Date.now() / 1000 } as any;
      this.dms.set(dms);
      dms = this.dms();
    }

    const latestEnter = messages.reduce((acc, msg) => Math.max(acc, msg.style === 'E' ? msg.time : 0, 0), 0);
    const latestLeave = messages.reduce((acc, msg) => Math.max(acc, msg.style === 'L' ? msg.time : 0, 0), 0);

    if (latestEnter > 0 && (!dms[dm - 1].lastEnter || dms[dm - 1].lastEnter < latestEnter)) {
      dms[dm - 1].lastEnter = latestEnter;
      entered = true;
    }

    if (latestLeave > 0 && (!dms[dm - 1].lastLeave || dms[dm - 1].lastLeave < latestLeave)) {
      dms[dm - 1].lastLeave = latestLeave;
      left = true;
    }

    if (entered || left)
      this.dms.set(dms);

    if (left)
      this.playNotificationSound(0, this.doorClose);

    if (entered)
      this.playNotificationSound(0, this.doorOpen);
  }

  protected receiveDirectMessages(dms: DmSession[]): void {
    const currentDMs = clone(this.dms(), true);
    const now = Date.now() / 1000;
    let changed = false;
    let totalNewMessages = 0;
    let notificationTab = this.selectedChat() || -1;

    for (let i = currentDMs.length - 1; i >= 0; --i) {
      if (dms.findIndex(d => d.id === currentDMs[i].id) < 0) {
        const messages = currentDMs[i].messages();
        const newMessages = messages.filter(m => m.time > now - MAX_DM_AGE);

        if (newMessages.length !== messages.length) {
          currentDMs[i].messages.set(newMessages);
          changed = true;
        }
      }
    }

    for (const dm of dms) {
      let index = currentDMs.findIndex(d => d.id === dm.id);

      if (isEqual(dm.messages, [null]))
        continue
      else if (index >= 0) {
        const currentDM = currentDMs[index];
        const oldMessages = currentDM.messages();

        if (!isEqual(oldMessages, dm.messages)) {
          const newMessages = this.countNewMessages(oldMessages, dm.messages);

          if (newMessages > 0 && index + 1 !== this.selectedChat())
            notificationTab = index + 1;

          totalNewMessages += newMessages;

          if (notificationTab !== this.selectedChat())
            currentDM.missed.set(currentDM.missed() + newMessages);

          currentDM.messages.set(dm.messages);
          changed = true;
        }
      }
      else if (this.prefs.allowDMs && !this.dmsJustClosed.get(dm.id)) {
        currentDMs.push({ id: dm.id, name: dm.name, messages: signal(dm.messages), missed: signal(0) });
        totalNewMessages += 1;
        notificationTab = currentDMs.length;
        changed = true;
        index = currentDMs.length - 1;
      }

      this.enterLeaveCheck(index, currentDMs[index].messages && currentDMs[index].messages());
    }

    const minuteAgo = processMillis() - 60000;
    [...this.dmsJustClosed.keys()].forEach(id => this.dmsJustClosed.get(id) < minuteAgo && this.dmsJustClosed.delete(id));

    for (const dm of currentDMs) {
      if (dms.findIndex(d => d.id === dm.id) < 0) {
        dm.closed = true;
        changed = true;
      }
    }

    if (changed) {
      this.dms.set(currentDMs);
      this.updateDisableEditor();
      this.updateTitle();
      this.adjustScrolling(true);
    }

    if (totalNewMessages > 0)
      this.playNotificationSound(notificationTab);
  }

  private isIdle(): boolean {
    return this.lastActive < processMillis() - CONSIDER_AFK_TIME;
  }

  private playNotificationSound(chat = 0, sound = chat !== 0 ? this.chimeDM : this.chime): void {
    const idleOrInactive = this.isIdle() || !this.chatActive;

    sound.volume = this.volume() / 100;

    if (this.notifySound() === 'always' ||
        (this.notifySound() === 'background' && (idleOrInactive || this.selectedChat() !== chat)))
      sound.play().catch(() => this.audioFailed());
  }

  private audioFailed(): void {
    this.messageService.add({
      life: 10000,
      key: 'tc',
      severity: 'warning',
      summary: 'Notification sound was disallowed'
    });
  }

  protected playSampleVolume(): void {
    this.chime.volume = this.volume() / 100;
    this.chime.play().catch(() => this.audioFailed());
    this.prefs.volume = this.volume();
    this.prefService.set(this.prefs);
  }

  protected getLegacyAge(): number {
    return (Math.floor(Date.now() / 1000) - this.lastSuccessfulLegacyPoll()) / 60;
  }
}
