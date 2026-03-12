import { Component, OnInit, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Message, Messages, Preferences } from '../../server/src/shared-types';
import { parseColor } from '@tubular/util';
import { FormsModule } from '@angular/forms';
import { PreferencesService } from '../preferences.service';

@Component({
  selector: 'app-root',
  imports: [FormsModule, RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  private readonly prefs: Preferences;

  private messageTimer: any;

  comment = signal('');
  email= signal('');
  inChat = signal(false);
  messages = signal([] as Message[]);
  name = signal('');
  participants = signal([] as string[]);

  constructor(private httpClient: HttpClient, private prefService: PreferencesService) {
    this.prefs = this.prefService.get();
    this.email.set(this.prefs?.email || '');
    this.name.set(this.prefs?.name || '');
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
        this.messages.set(messages.messages);
        this.participants.set(messages.participants);

        this.messageTimer = setTimeout(() => this.getMessages(), 10000);
      },
      error: (_error): void => {
        this.messageTimer = setTimeout(() => this.getMessages(), 10000);
      }
    });
  }

  enterChat(): void {
    this.prefs.name = this.name();
    this.prefs.email = this.email();
    this.prefService.set(this.prefs);

    this.httpClient.post('/api/enter', {}, { params: this.prefs as any }).subscribe({
      next: (): void => this.inChat.set(true),
      error: (_error): void => this.inChat.set(false)
    });
  }

  leaveChat(): void {
    this.httpClient.post('/api/leave', {}, { params: this.prefs as any }).subscribe({
      next: (): void => this.inChat.set(false),
      error: (_error): void => {}
    });
  }

  sendComment(_evt: Event): void {
    const params = { ...this.prefs, comment: this.comment() };

    this.httpClient.post('/api/send', {}, { params }).subscribe({
      next: (): void => {
        this.inChat.set(true);
        this.comment.set('');
        this.getMessages();
      },
      error: (_error): void => this.inChat.set(false)
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
}
