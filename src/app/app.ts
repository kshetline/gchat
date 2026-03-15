import { Component, OnInit, signal, ViewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Config, Message, Messages, Preferences } from '../../server/src/shared-types';
import { forEach, isEqual } from '@tubular/util';
import { FormsModule } from '@angular/forms';
import { PreferencesService } from '../preferences.service';
import { MessageEntry } from '../message-entry/message-entry';
import { colors, getTextBackground } from '../main';

const matchEmoji = /(\uD83C[\uD000-\uDFFF]|\uD83D[\uD000-\uDFFF]|\uD83E[\uD000-\uDFFF])/g;

@Component({
  selector: 'app-root',
  imports: [FormsModule, MessageEntry],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  colors = colors;
  getTextBackground = getTextBackground;

  private readonly chime = new Audio('assets/notify.wav');
  private readonly prefs: Preferences;

  private messageTimer: any;

  color = signal(0);
  email= signal('');
  inChat = signal(false);
  localTime = signal(true);
  messages = signal([] as Message[]);
  name = signal('');
  newOnBottom = signal(true);
  navigation = signal([] as { name: string, url: string; target?: string }[]);
  notifySound = signal(true);
  participants = signal([] as string[]);
  title = signal('Chat');
  tripCode = signal('');

  @ViewChild(MessageEntry) private messageEntry: MessageEntry;

  constructor(private httpClient: HttpClient, private prefService: PreferencesService) {
    this.prefs = this.prefService.get();
    forEach(this.prefs as Record<string, any>, (key, value) => (this as any)[key]?.set(value));

    const configStr = localStorage.getItem('gchat-config');

    if (configStr) {
      try {
        const config = JSON.parse(configStr) as Config;

        document.title = config.title;
        this.title.set(config.title);
        this.navigation.set(config.navigation);
      }
      catch {}
    }

    httpClient.get<Config>('/api/config').subscribe({
      next: (config: Config): void => {
        document.title = config.title;
        this.title.set(config.title);
        this.navigation.set(config.navigation);
        localStorage.setItem('gchat-config', JSON.stringify(config));
      },
      error: (_error): void => {}
    })
  }

  ngOnInit(): void {
    this.getMessages();
  }

  protected getMessages(): void {
    if (this.messageTimer) {
      clearTimeout(this.messageTimer);
      this.messageTimer = undefined;
    }

    this.httpClient.get<Messages>('/api/messages', { params: { name: this.name() }}).subscribe({
      next: (messages: Messages): void => {
        if (!messages.errorMessage) {
          if (!this.newOnBottom())
            messages.messages.reverse();

          if (!isEqual(this.messages(), messages.messages)) {
            if (this.messages().length > 0 && this.prefs.notifySound)
              this.chime.play().finally();

            this.messages.set(messages.messages);
            this.adjustScrolling();
          }

          this.participants.set(messages.participants);
        }
      },
      complete: (): void => {
        this.messageTimer = setTimeout(() => this.getMessages(), 10000);
      }
    });
  }

  updateColor(): void {
    this.prefs.color = this.color();
    this.prefService.set(this.prefs);
  }

  enterChat(): void {
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
        this.inChat.set(true);
        setTimeout(() => {
          this.adjustScrolling();
          this.messageEntry.focus(this.color());
        });
      },
      error: (_error): void => this.inChat.set(false)
    });
  }

  leaveChat(): void {
    this.httpClient.post('/api/leave', {}, { params: this.prefs as any }).subscribe({
      next: (): void => {
        this.inChat.set(false);
        setTimeout(() => this.adjustScrolling());
      },
      error: (_error): void => {}
    });
  }

  sendComment(comment: string): void {
    if (!comment?.trim())
      return;

    this.messageEntry.sendEnabled(false);

    const params = { ...this.prefs, comment };

    this.httpClient.post('/api/send', {}, { params }).subscribe({
      next: (): void => {
        this.inChat.set(true);
        this.messageEntry.reset();
        setTimeout(() => this.getMessages(), 500);
      },
      error: (_error): void => this.messageEntry.sendEnabled(true)
    });
  }

  formatLocal(timestamp: string): string {
    return new Date(timestamp + 'Z').toLocaleString();
  }

  magnifyEmoji(text: string): string {
    return text.replace(matchEmoji, '<span class="big-emoji">$1</span>');
  }

  toggleNotifySound(): void {
    this.prefs.notifySound = this.notifySound();
    this.prefService.set(this.prefs);
  }

  toggleLocalTime(): void {
    this.prefs.localTime = this.localTime();
    this.prefService.set(this.prefs);
  }

  setColor(color: number): void {
    this.color.set(color);
    this.prefs.color = color;
    this.prefService.set(this.prefs);
  }

  toggleMessageOrder(): void {
    this.prefs.newOnBottom = this.newOnBottom();
    this.prefService.set(this.prefs);
    this.messages.set(this.messages().reverse());
    this.adjustScrolling();
    setTimeout(() => this.messageEntry?.focus(), 250);
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
}
