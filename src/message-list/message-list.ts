import { Component, input, signal } from '@angular/core';
import { Message } from '../../server/src/shared-types';
import { colorFromStyle, getLuminance, getTextBackground, kaomoji } from '../main';
import { htmlUnescape } from '@tubular/util';
import { MessageEntry } from '../message-entry/message-entry';

const matchEmoji = /(\uD83C[\uD000-\uDFFF]|\uD83D[\uD000-\uDFFF]|\uD83E[\uD000-\uDFFF])/g;

@Component({
  selector: 'chat-message-list',
  imports: [],
  templateUrl: './message-list.html',
  styleUrl: './message-list.scss',
})
export class MessageList {
  private lastSelectedText = '';

  protected toolHash = signal('');
  protected toolTimer: any;

  darkMode = input.required<boolean>();
  inChat = input.required<boolean>();
  isAdmin = input.required<boolean>();
  localTime = input.required<boolean>();
  messageEntry = input.required<MessageEntry>();
  messages = input.required<Message[]>();
  name = input.required<string>();

  constructor() {
    document.addEventListener('mouseup', () => setTimeout(() => this.lastSelectedText = window.getSelection().toString()));
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
    return text.replace(matchEmoji, '<span class="big-emoji">$1</span>')
    .replace(/(\u2000(.+?)\u2000)/g, (_$0, $1, $2) =>
      kaomoji.includes($2) ? `<span class="kaomoji">${$1}</span>` : $1
    );
  }

  protected formatLocal(timestamp: string): string {
    return new Date(timestamp + 'Z').toLocaleString();
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

  protected isMe(message: Message): boolean {
    return message.name === this.name();
  }

  protected quoteMessage(message: Message): void {
    let quote = htmlUnescape(message.text.replace(/<.+?>/g, '')).replace(/\s+/g, ' ');

    if (this.lastSelectedText && quote.includes(this.lastSelectedText))
      quote = this.lastSelectedText;

    this.messageEntry().insertQuote(message.name, quote.trim());
  }

  protected editMessage(_message: Message): void {
    alert('Edit not yet implemented');
  }

  protected deleteMessage(_message: Message): void {
    alert('Delete not yet implemented');
  }
}
