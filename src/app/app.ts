import { Component, OnInit, signal, ViewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Message, Messages, Preferences } from '../../server/src/shared-types';
import { forEach, isEqual, parseColor } from '@tubular/util';
import { FormsModule } from '@angular/forms';
import { PreferencesService } from '../preferences.service';
import { MessageEntry } from '../message-entry/message-entry';

@Component({
  selector: 'app-root',
  imports: [FormsModule, MessageEntry],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  private readonly chime = new Audio('assets/notify.wav');
  private readonly prefs: Preferences;

  private messageTimer: any;

  color = signal(0);
  colors = ['#000000', '#000080', '#4444cc', '#44cc44', '#cc9911', '#cc4444', '#cc6600', '',
            '#008040', '#33aaaa', '#cc44cc', '#800000', '#FF80C0', '#b87333', '#8ca9d9', '#4682b4'];
  email= signal('');
  inChat = signal(false);
  localTime = signal(true);
  messages = signal([] as Message[]);
  name = signal('');
  newOnBottom = signal(true);
  notifySound = signal(true);
  participants = signal([] as string[]);

  @ViewChild(MessageEntry) private readonly messageEntry: MessageEntry;

  constructor(private httpClient: HttpClient, private prefService: PreferencesService) {
    this.prefs = this.prefService.get();
    forEach(this.prefs as Record<string, any>, (key, value) => (this as any)[key]?.set(value));
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

    this.httpClient.post('/api/enter', {}, { params: this.prefs as any }).subscribe({
      next: (): void => {
        this.inChat.set(true);
        setTimeout(() => this.adjustScrolling());
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

  getTextBackground(style: string): string {
    const color = (/color:\s*([^;]+)\b/.exec(style) || [])[1];

    if (color) {
      const rgb = parseColor(color);

      if (rgb.r * 0.3 + rgb.g * 0.59 + rgb.b * 0.11 > 140)
        return '#333333';
    }

    return 'white';
  }

  formatLocal(timestamp: string): string {
    return new Date(timestamp + 'Z').toLocaleString();
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
