import { Component, ElementRef, input, OnInit, output, signal } from '@angular/core';
import { Message } from '../../server/src/shared-types';
import { colorFromStyle, getLuminance, getTextBackground, kaomoji, notify } from '../main';
import { htmlUnescape } from '@tubular/util';
import { MessageEntry } from '../message-entry/message-entry';
import { HttpClient } from '@angular/common/http';

const matchEmoji = /(((\uD83C[\uD000-\uDFFF]|\uD83D[\uD000-\uDFFF]|\uD83E[\uD000-\uDFFF])[\uFE00-\uFE0F]*?\u200D?)+)/g;
const QUOTE_MARKER = '\u00A0◀︎ ';

export interface EditEvent {
  bbCode: string;
  color: number;
  msgId: number;
  time: string;
}

@Component({
  selector: 'chat-message-list',
  imports: [],
  templateUrl: './message-list.html',
  styleUrl: './message-list.scss',
})
export class MessageList implements OnInit {
  private lastSelectedText = '';

  protected showScrollToBottom = signal(false);
  protected showScrollToTop = signal(false);
  protected toolHash = signal('');
  protected toolTimer: any;

  darkMode = input.required<boolean>();
  inChat = input.required<boolean>();
  isAdmin = input.required<boolean>();
  isAtBottom = input.required<boolean>();
  localTime = input.required<boolean>();
  messageEntry = input.required<MessageEntry>();
  messages = input.required<Message[]>();
  name = input.required<string>();
  tripCode = input.required<string>();

  connectionTrouble = output<string>();
  edit = output<EditEvent>();

  constructor(private elemRef: ElementRef, private httpClient: HttpClient) {
    document.addEventListener('mouseup', () => setTimeout(() => this.lastSelectedText = window.getSelection().toString()));
  }

  ngOnInit(): void {
    const messages = this.elemRef?.nativeElement?.querySelector('.message-content');

    if (messages)
      messages.addEventListener('scroll', () => {
        this.showScrollToBottom.set(this.isAtBottom() && messages.scrollTop < messages.scrollHeight - messages.clientHeight - 10);
        this.showScrollToTop.set(!this.isAtBottom() && messages.scrollTop > 10);
      });
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

  protected adjustMarkup(text: string): string {
    let start = '';
    let end = text;
    const pos = text.indexOf(QUOTE_MARKER);

    if (pos >= 0) {
      start = text.substring(0, pos + QUOTE_MARKER.length);
      end = text.substring(pos + QUOTE_MARKER.length);
    }

    end = end.replace(matchEmoji, '<span class="big-emoji">$1</span>');
    text = start + end;

    return text.replace(/(\u2000(.+?)\u2000)/g, (_$0, $1, $2) =>
      kaomoji.includes($2) ? `<span class="kaomoji">${$1}</span>` : $1
    );
  }

  protected formatTime(time: number): string {
    if (this.localTime())
      return new Date(time * 1000).toLocaleString();
    else
      return new Date(time * 1000).toISOString().substring(0, 19).replace('T', ' ');
  }

  protected getBackground(message: Message): string {
    return getTextBackground(this.getColor(message), this.darkMode());
  }

  protected getColor(message: Message): string {
    let color = colorFromStyle(message.style);

    if (this.darkMode() && (color === '#000' || color === '#000000' || color === 'black'))
      color = '#DDD';

    return color;
  }

  protected isFocused(message: Message): boolean {
    return this.inChat() && this.toolHash() === message.hash;
  }

  protected isLight(message: Message): boolean {
    return getLuminance(this.getBackground(message)) > 127;
  }

  protected quoteMessage(message: Message): void {
    let quote = htmlUnescape(message.html.replace(/<.+?>/g, '')).replace(/\s+/g, ' ');

    if (this.lastSelectedText && quote.includes(this.lastSelectedText))
      quote = this.lastSelectedText;

    this.messageEntry().insertQuote(message.name, quote.trim());
  }

  protected editMessage(message: Message): void {
    this.httpClient.get<any>('/api/can-edit',
      { params: { name: this.name(), tripCode: this.tripCode(), msgId: message.msgId } }).subscribe({
      next: (response): void => {
        this.edit.emit({ bbCode: response.bbCode, color: response.color,
          msgId: message.msgId, time: this.formatTime(message.time) });
      },
      error: (error): void => {
        if (error.status === 400 && error.error?.error)
          notify('error', error.error.error);
       else
         this.connectionTrouble.emit(error.message || error.toString());
       }
    });
  }

  protected deleteMessage(_message: Message): void {
    alert('Delete not yet implemented');
  }

  protected scrollToBottom() {
    const messages = document.querySelector('chat-message-list .message-content');

    if (messages)
      messages.scrollTop = messages.scrollHeight;
  }

  protected scrollToTop() {
    const messages = document.querySelector('chat-message-list .message-content');

    if (messages)
      messages.scrollTop = 0;
  }
}
