import { Component, ElementRef, EventEmitter, Output, signal, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import Quill from 'quill';
import { QuillModule  } from 'ngx-quill';
import { forEach } from '@tubular/util';
import { colors, getTextBackground } from '../main';
import { PickerComponent } from '@ctrl/ngx-emoji-mart';
import { Emoji, EmojiData } from '@ctrl/ngx-emoji-mart/ngx-emoji';

const Size = Quill.import('attributors/style/size') as any;
const sizeMap : Record<string, string>= { '0.625em': 's1', '0.8125em': 's2', '1em': 's3', '1.125em': 's4', '1.5em': 's5' };

Size.whitelist = Object.keys(sizeMap);
Quill.register(Size, true);

const tagMap: Record<string, string> = { 'bold': 'b', 'italic': 'i', 'size': '', 'strike': 's', 'underline': 'u' };
const recognizedAttributes = new Set(Object.keys(tagMap));

function quillOpsToBBCode(ops: any[]): string {
  let result = '';
  const stacks = new Map<string, any[]>();

  recognizedAttributes.forEach(attr => stacks.set(attr, []));

  for (const op of ops) {
    const attrs = new Set<string>();

    forEach(op.attributes, (key, value) => {
      if (recognizedAttributes.has(key)) {
        const stack = stacks.get(key);

        attrs.add(key);

        if (stack.at(-1) !== value) {
          if (key === 'size') {
            if (stack.at(-1)) {
              result += `[/${sizeMap[stack.at(-1)]}]`;
              stack.pop();
            }

            result += `[${sizeMap[value as string]}]`;
          }
          else
            result += `[${tagMap[key]}]`;

          stack.push(value);
        }
      }
    });

    recognizedAttributes.forEach(attr => {
      const stack = stacks.get(attr);

      if (stack.length > 0 && !attrs.has(attr)) {
        if (attr === 'size')
          result += `[/${sizeMap[stack.at(-1)]}]`;
        else
          result += `[/${tagMap[attr]}]`;

        stack.pop();
      }
    });

    result += op.insert.replace(/[\n\r]/g, '').replace(/\[/g, '[\u200B');
  }

  return result.trimEnd();
}

@Component({
  selector: 'app-message-entry',
  imports: [FormsModule, PickerComponent, QuillModule],
  templateUrl: './message-entry.html',
  styleUrl: './message-entry.scss',
})
export class MessageEntry {
  colors = colors;

  private quill: Quill;

  color = signal(0);
  enabled = signal(true);
  showEmoji = signal(false);
  pickerPosition = signal({ top: '0', left: '0' });

  modules = {
    keyboard: {
      bindings: {
        enter: {
          key: 'Enter',
          'handler': () => this.sendMessage()
        },
        tab: {
          key: 'Tab',
          'handler': () => true
        }
      }
    },
    toolbar: '#my-toolbar',
  };

  @Output() changeColor = new EventEmitter<number>();
  @Output() newMessage = new EventEmitter<string>();

  @ViewChild('picker') picker: ElementRef;

  constructor() {
    document.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape' && this.showEmoji()) {
        this.showEmoji.set(false);
        event.preventDefault();
      }
    })
  }

  editorCreated(quill: Quill): void {
    this.quill = quill;
    this.updateColor(false);
  }

  setColor(color: number): void {
    this.color.set(color);
  }

  focus(color?: number): void {
    if (color != null)
      this.color.set(color);

    setTimeout(() => this.quill?.focus(), 250);
  }

  updateColor(emit = true): void {
    if (emit)
      this.changeColor.emit(this.color());

    this.quill.root.style.color = this.colors[this.color()];
    this.quill.root.style.backgroundColor = getTextBackground(this.colors[this.color()]);
  }

  sendMessage(): void {
    const message = quillOpsToBBCode(this.quill.getContents().ops);

    this.newMessage.emit(message);
  }

  sendEnabled(enabled: boolean): void {
    this.enabled.set(enabled);
  }

  reset(): void {
    this.sendEnabled(true);
    this.quill.setText('');
  }

  toggleEmoji(): void {
    this.showEmoji.set(!this.showEmoji());

    if (this.showEmoji() && this.picker) {
      const rectB = this.picker.nativeElement.getElementById('emoji-button')?.getBoundingClientRect();
      const rectP = this.picker.nativeElement.getBoundingClientRect();
    }
  }

  emojiClick(emoji: Emoji): void {
    const char = ((emoji.emoji instanceof String) ? emoji.emoji : (emoji.emoji as EmojiData)?.native)?.toString() || '';
    const range = this.quill.selection.savedRange;

    if (range.length > 0)
      this.quill.deleteText(range.index, range.length);

    this.quill.insertText(range.index, char);
  }
}
