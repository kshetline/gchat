import { Component, ElementRef, input, OnInit, output, signal } from '@angular/core';
import { kaomoji, Message } from '../../server/src/shared-types';
import { colorFromStyle, getLuminance, getTextBackground, notify } from '../main';
import { debounce, htmlUnescape, isString } from '@tubular/util';
import { MessageEntry } from '../message-entry/message-entry';
import { HttpClient } from '@angular/common/http';
import { SafeHtmlPipe } from '../safe-html-pipe/safe-html-pipe';

const matchEmoji = /(((\uD83C[\uD000-\uDFFF]|\uD83D[\uD000-\uDFFF]|\uD83E[\uD000-\uDFFF])[\uFE00-\uFE0F]*?(\u200D.)?)+)/g;
const QUOTE_MARKER = '\u00A0◀︎ ';
const QUOTE_MARKER_PATTERN = /\u00A0[◀︎◁◂⏴] /;
const QUOTE_NAME_PATTERN = /<u>([^>]+)<\/u>:/;

export interface DeleteEvent {
  chatIndex: number;
  msgId: number;
}

export interface EditEvent {
  bbCode: string;
  chatIndex: number;
  color: number;
  msgId: number;
  time: string;
}

@Component({
  selector: 'chat-message-list',
  imports: [SafeHtmlPipe],
  templateUrl: './message-list.html',
  styleUrl: './message-list.scss',
})
export class MessageList implements OnInit {
  private lastSelectedText = '';

  protected showScrollToBottom = signal(false);
  protected showScrollToTop = signal(false);
  protected toolHash = signal('');
  protected toolTimer: any;

  chatIndex = input<number>(0);
  closed = input<boolean>(false);
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
  delete = output<DeleteEvent>();
  edit = output<EditEvent>();

  private scrollCheck = debounce(100, () => {
    const messages = this.elemRef?.nativeElement?.querySelector('.message-content');

    if (messages) {
      this.showScrollToBottom.set(this.isAtBottom() && messages.scrollTop < messages.scrollHeight - messages.clientHeight - 10);
      this.showScrollToTop.set(!this.isAtBottom() && messages.scrollTop > 10);
    }
  });

  constructor(private elemRef: ElementRef, private httpClient: HttpClient) {
    document.addEventListener('mouseup', () => setTimeout(() => this.lastSelectedText = window.getSelection().toString()));
  }

  ngOnInit(): void {
    const messages = this.elemRef?.nativeElement?.querySelector('.message-content');

    if (messages) {
      messages.addEventListener('scroll', () => this.scrollCheck());
      setTimeout(this.scrollCheck, 100);
      new ResizeObserver(() => this.scrollCheck()).observe(messages);
    }
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

  protected adjustMarkup(text: string, currentColor: string): string {
    let start = '';
    let qm = '';
    let end = text;
    const match = text.match(QUOTE_MARKER_PATTERN);

    if (match) {
      start = text.substring(0, match.index);
      qm = QUOTE_MARKER;

      const nameMatch = start.match(QUOTE_NAME_PATTERN);
      let startWrapped = false;

      if (nameMatch) {
        const mostRecentMessage = this.messages().findLast(msg => msg.name === nameMatch[1] && msg.style?.length > 2);
        const bgColor = this.getBackground(mostRecentMessage);
        const color = this.getColor(mostRecentMessage);

        if (color && color !== currentColor) {
          start = `<span style="background-color: ${bgColor}; color: ${color}; padding: 1px 2px">${start}</span>`;
          startWrapped = true;
        }
      }

      if (!startWrapped) {
        let bg = this.getBackground(currentColor);

        bg = bg === '#333' ? '#444' : (bg === '#CCC' ? '#BBB' : bg);
        start = `<span style="background-color: ${bg}; padding: 1px 2px">${start}</span>`;
      }

      end = text.substring(match.index + match[0].length);
    }

    start = start.replace(matchEmoji, '<span class="straight-emoji">$1</span>');
    end = end.replace(matchEmoji, '<span class="big-emoji">$1</span>');
    text = start + qm + end;

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

  protected getBackground(message: Message | string): string {
    if (document.body.classList.contains('theme-li1999'))
      return 'transparent';
    else if (isString(message))
      return getTextBackground(message, this.darkMode());
    else
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
    return document.body.classList.contains('theme-li1999') || getLuminance(this.getBackground(message)) > 127;
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
        this.edit.emit({ bbCode: response.bbCode, color: response.color, chatIndex: this.chatIndex(),
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

  protected deleteMessage(message: Message): void {
    this.delete.emit({ chatIndex: this.chatIndex(), msgId: message.msgId });
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

  protected getImages(html: string): string[] {
    const pos = html.indexOf(' &lt; ');

    if (pos > 0)
      html = html.substring(pos);
    else {
      const match = html.match(QUOTE_MARKER_PATTERN);

      if (match)
        html = html.substring(match.index + match[0].length);
    }

    return html.split(/\bhref="(http(s?):\/\/.+?\.(avif|gif|jpeg|jpg|png|svg|webp))"/g).filter((_s, i) => (i - 1) % 4 === 0);
  }

  protected hasImages(html: string): boolean {
    return this.getImages(html).length > 0;
  }
}
