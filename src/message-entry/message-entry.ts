import { Component, ElementRef, input, output, signal, WritableSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import Quill from 'quill';
import { QuillModule  } from 'ngx-quill';
import { forEach } from '@tubular/util';
import { colorByIndex, getTextBackground, kaomoji, notify, shouldIgnoreClick, startClickSuppress } from '../main';
import { PickerComponent } from '@ctrl/ngx-emoji-mart';
import { Emoji, EmojiData } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import { ColorSelector } from '../color-selector/color-selector';
import { allowedExtensions, MB } from '../../server/src/shared-types';

export interface FileUploadEvent {
  file: File;
  quill: Quill;
}

const Size = Quill.import('attributors/style/size') as any;
const sizeMap : Record<string, string>= { '0.625em': 's1', '0.8125em': 's2', '1em': 's3', '1.125em': 's4', '1.5em': 's5' };

Size.whitelist = Object.keys(sizeMap);
Quill.register(Size, true);

const tagMap: Record<string, string> = {
  'bold': 'b', 'code': 'code', 'italic': 'i', 'size': '', 'strike': 's', 'underline': 'u'
};
const recognizedAttributes = new Set(Object.keys(tagMap));

const FontAttributor = Quill.import('attributors/class/font') as any;
FontAttributor.whitelist = ['ms-pgothic'];
Quill.register(FontAttributor, true);

if (!localStorage.getItem('emoji-mart.frequently'))
  localStorage.setItem('emoji-mart.frequently',
    '{"grinning":9,"laughing":8,"joy":7,"wink":6,"skull":5,"scream":4,"slightly_frowning_face":3,"+1":2,"-1":1}');

const QUOTE_NAME_DELIM = ': ';
const QUOTE_MARKER = '\u00A0◀︎ ';

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

    result += op.insert.replace(/\[/g, '[\u200B');
  }

  return result.replace(/[ \n\r]+$/, '');
}

const formats = ['bold', 'code', 'font', 'italic', 'underline', 'strike', 'size'];
const formatSet = new Set(formats);

@Component({
  selector: 'chat-message-entry',
  imports: [FormsModule, PickerComponent, QuillModule, ColorSelector],
  templateUrl: './message-entry.html',
  styleUrl: './message-entry.scss',
})
export class MessageEntry {
  protected kaomoji = kaomoji;

  private _color = 0;
  private quill: Quill;

  protected enabled = signal(true);
  protected filePromptPosition = signal({ top: '0', left: '0' });
  protected lastSelectedFiles: File[];
  protected showEmoji = signal(false);
  protected showFilePrompt = signal(false);
  protected showKaomoji = signal(false);
  protected kaomojiPosition = signal({ top: '0', left: '0' });
  protected pickerPosition = signal({ top: '0', left: '0' });

  protected formats = formats;
  protected modules = {
    clipboard: {
      matchers: [
        [Node.ELEMENT_NODE, (_node: any, delta: any) => {
          delta.ops.forEach((op: any) => {
            forEach(op.attributes, (key, value) => {
              if ((key === 'font' && value !== 'ms-pgothic') || !formatSet.has(key))
                delete op.attributes[key];
            })
          });
          return delta;
        }]
      ]
    },
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

  darkMode = input(false);
  maxFileSizeInMb = input(15000);
  changeColor = output<number>();
  newMessage = output<string>();
  uploadFile = output<FileUploadEvent>();

  get color(): number { return this._color; }
  set color(value: number) {
    if (this._color !== value) {
      this._color = value;
      this.updateColor();
    }
  }

  constructor(private elementRef: ElementRef<HTMLElement>) {
    document.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape' && this.showEmoji()) {
        this.showEmoji.set(false);
        event.preventDefault();
      }
    });

    document.addEventListener('mousedown', (evt: MouseEvent) => {
      if (!document.querySelector('#upload-panel')?.contains(evt.target as Node) && this.showFilePrompt()) {
        this.showFilePrompt.set(false);
        evt.preventDefault();
        startClickSuppress();
      }
      else if (!document.querySelector('emoji-mart')?.contains(evt.target as Node) && this.showEmoji()) {
        this.showEmoji.set(false);
        evt.preventDefault();
        startClickSuppress();
      }
      else if (!document.querySelector('#kaomoji-panel')?.contains(evt.target as Node) && this.showKaomoji()) {
        this.showKaomoji.set(false);
        evt.preventDefault();
        startClickSuppress();
      }
    })
  }

  protected editorCreated(quill: Quill): void {
    this.quill = quill;
    this.updateColor(false);

    this.quill.root.addEventListener('paste', (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;

      if (!items)
        return;

      for (let i = 0; i < items.length; i++) {
        if (/\bimage\b/.test(items[i].type)) {
          e.preventDefault();
          const blob = items[i].getAsFile();

          if (blob?.size > this.maxFileSizeInMb() * MB)
            notify('error', `Image too big. Maximum size is ${this.maxFileSizeInMb()} MB.`);
          else if (blob) {
            this.insertImage(blob);
            break;
          }
        }
      }
    });

    this.quill.root.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      this.processFiles(Array.from(e.dataTransfer?.files));
    });
  }

  private processFiles(files: File[]): void {
    if (!files)
      return;

    const uploads: File[] = [];
    let tooBig = false;

    for (let i = 0; i < files.length; i++) {
      if (files[i].size > this.maxFileSizeInMb() * MB)
        tooBig = true;
      else if (allowedExtensions.test(files[i].name))
        uploads.push(files[i]);
    }

    if (tooBig)
      notify('error', `File too big. Maximum size is ${this.maxFileSizeInMb()} MB.`);
    else if (uploads.length === 1 && !tooBig)
      this.insertImage(uploads[0]);
    else if (uploads.length > 1)
      notify('error', 'Only one file can be sent at a time.');
    else if (files.length > 0)
      notify('error', 'File type is not supported.');

  }

  private insertImage(file: File): void {
    this.uploadFile.emit({ file, quill: this.quill });
  }

  setColor(color: number): void {
    this.color = color;
  }

  focus(color?: number): void {
    if (color != null)
      this.color = color;

    setTimeout(() => this.quill?.focus(), 250);
  }

  updateColor(emit = true): void {
    if (emit)
      this.changeColor.emit(this.color);

    if (this.quill?.root) {
      this.quill.root.style.color = colorByIndex(this.color, this.darkMode());
      this.quill.root.style.backgroundColor = getTextBackground(this.quill.root.style.color);
    }
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

  private togglePanel(state: WritableSignal<any>, position: WritableSignal<any>, btn: string, panel: string): void {
    state.set(!state());

    if (state()) {
      setTimeout(() => {
        const button = this.elementRef.nativeElement.querySelector(btn);
        const picker = this.elementRef.nativeElement.querySelector(panel);
        const editor = this.elementRef.nativeElement.querySelector('quill-editor');

        if (!button || !picker || !editor) return;

        const buttonRect = button.getBoundingClientRect();
        const pickerRect = picker.getBoundingClientRect();
        const editorRect = editor.getBoundingClientRect();

        // Align left edge of picker to left edge of button
        let left = buttonRect.left;

        // Determine vertical position
        let top: number;
        const spaceAbove = buttonRect.top;
        const fitsAbove = spaceAbove >= pickerRect.height;

        if (fitsAbove)
          // Position picker above button
          top = buttonRect.top - pickerRect.height;
        else
          // Position picker below editor
          top = editorRect.bottom;

        // Ensure picker is not clipped off screen
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Adjust horizontal position if clipped on right
        if (left + pickerRect.width > viewportWidth)
          left = viewportWidth - pickerRect.width;

        // Adjust horizontal position if clipped on left
        if (left < 0)
          left = 0;

        // Adjust vertical position if clipped on bottom
        if (top + pickerRect.height > viewportHeight)
          top = viewportHeight - pickerRect.height;

        // Adjust vertical position if clipped on top
        if (top < 0)
          top = 0;

        position.set({ top: `${top}px`, left: `${left}px` });
      });
    }
  }

  protected toggleEmoji(): void {
    if (shouldIgnoreClick())
      return;

    this.togglePanel(this.showEmoji, this.pickerPosition, '#emoji-button', 'emoji-mart');
  }

  protected toggleKaomoji(): void {
    if (shouldIgnoreClick())
      return;

    this.togglePanel(this.showKaomoji, this.kaomojiPosition, '#kaomoji-button', '#kaomoji-panel');
  }

  protected toggleFileUpload(): void {
    if (shouldIgnoreClick())
      return;

    if (!this.showFilePrompt())
      this.lastSelectedFiles = undefined;

    this.togglePanel(this.showFilePrompt, this.filePromptPosition, '#upload-button', '#upload-panel');
  }

  protected onFileSelected(evt: Event): void {
    this.lastSelectedFiles = Array.from((evt.target as HTMLInputElement).files);
  }

  protected uploadSelectedFile(): void {
    this.showFilePrompt.set(false);
    this.processFiles(this.lastSelectedFiles);
  }

  protected emojiClick(emoji: Emoji): void {
    const char = ((emoji.emoji instanceof String) ? emoji.emoji : (emoji.emoji as EmojiData)?.native)?.toString() || '';
    const range = this.quill.selection.savedRange;

    if (range.length > 0)
      this.quill.deleteText(range.index, range.length);

    this.quill.insertText(range.index, char);
    this.quill.setSelection(range.index + char.length);
  }

  insertQuote(name: string, quote: string): void {
    let index = 0;

    this.quill.insertText(index, name, { underline: true });
    index += name.length;
    this.quill.insertText(index, QUOTE_NAME_DELIM, { underline: false });
    index += QUOTE_NAME_DELIM.length;
    this.quill.insertText(index, quote, { italic: true });
    index += quote.length;
    this.quill.insertText(index, QUOTE_MARKER, { italic: false });
    index += QUOTE_MARKER.length;
    this.quill.setSelection(index);
  }

  protected insertKaomoji(text: string): void {
    const range = this.quill.selection.savedRange;

    if (range.length > 0)
      this.quill.deleteText(range.index, range.length);

    text = '\u2000' + text + '\u2000'
    this.quill.insertText(range.index, text, { font: 'ms-pgothic' });
    this.quill.setSelection(range.index + text.length);
    this.quill.format('font', undefined);
    this.showKaomoji.set(false);
  }
}
