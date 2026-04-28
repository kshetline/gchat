import { Component, ElementRef, input, OnInit, output, signal, WritableSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import Quill from 'quill';
import { QuillModule  } from 'ngx-quill';
import { forEach } from '@tubular/util';
import { colorByIndex, getTextBackground, notify, shouldIgnoreClick, startClickSuppress } from '../main';
import { PickerComponent } from '@ctrl/ngx-emoji-mart';
import { Emoji, EmojiData } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import { ColorSelector } from '../color-selector/color-selector';
import { allowedExtensions, Config, kaomoji, kaomojiRegex, MB, sizeMap } from '../../server/src/shared-types';
import { EditEvent } from '../message-list/message-list';
import { toObservable } from '@angular/core/rxjs-interop';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService } from 'primeng/api';
import { PreferencesService } from '../preferences.service';

// I don't want to persist this setting in localStorage -- per session in a better time frame.
let useExternalUploader = false;

export interface FileUploadEvent {
  external: boolean;
  file: File;
  finished?: () => void;
  interrupt?: () => void;
  quill: Quill;
  started?: () => void;
}

export interface MessageUpdateEvent {
  bbCode: string;
  callback: (success: boolean) => void;
  color: number;
  msgId: number;
}

const Size = Quill.import('attributors/style/size') as any;

Size.whitelist = Object.keys(sizeMap);
Quill.register(Size, true);

const tagMap: Record<string, string> = {
  bold: 'b', code: 'code', italic: 'i', size: '', strike: 's', underline: 'u'
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
const INPUT_LENGTH_LIMIT = 1000;
const INPUT_LENGTH_WARN = 950;

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

// Reverse of sizeMap: { s1: '0.625em', s2: '0.8125em', ... }
const bbSizeMap = Object.fromEntries(Object.entries(sizeMap).map(([k, v]) => [v, k]));

type QuillAttributes = Record<string, any>;
type QuillOp = { insert: string | { image: string }; attributes?: QuillAttributes };

export function bbCodeToQuillOps(bbCode: string): QuillOp[] {
  const ops: QuillOp[] = [];
  let pos = 0;

  function peekTag(): { closing: boolean; tag: string; href?: string; len: number } | null {
    const match = /^\[(\/?)(b|i|u|s|code|s[1-5]|url(?:=([^\]]*?))?|img)]/.exec(bbCode.slice(pos));

    if (!match)
      return null;

    const rawTag = match[2];
    const tag = rawTag.startsWith('url') ? 'url' : rawTag;

    return { closing: match[1] === '/', tag, href: match[3], len: match[0].length };
  }

  function parse(activeAttrs: QuillAttributes): void {
    while (pos < bbCode.length) {
      const tag = peekTag();

      if (!tag) {
        let text = '';
        while (pos < bbCode.length && bbCode[pos] !== '[') text += bbCode[pos++];

        if (text) {
          const op: QuillOp = { insert: text };

          if (Object.keys(activeAttrs).length)
            op.attributes = { ...activeAttrs };

          ops.push(op);
        }

        continue;
      }

      if (tag.closing)
        break;

      pos += tag.len;

      if (tag.tag === 'url') {
        const href = tag.href;
        if (!href) {
          let content = '';

          while (pos < bbCode.length) {
            const t = peekTag();
            if (t?.closing && t.tag === 'url') {
              pos += t.len;
              break;
            }

            content += bbCode[pos++];
          }

          ops.push({ insert: content, attributes: { ...activeAttrs, link: content } });
        }
        else {
          parse({ ...activeAttrs, link: href });
          const t = peekTag();
          if (t?.closing && t.tag === 'url')
            pos += t.len;
        }
      }
      else {
        const newAttrs: QuillAttributes = { ...activeAttrs };
        switch (tag.tag) {
          case 'b':    newAttrs['bold'] = true; break;
          case 'i':    newAttrs['italic'] = true; break;
          case 'u':    newAttrs['underline'] = true; break;
          case 's':    newAttrs['strike'] = true; break;
          case 'code': newAttrs['code'] = true; break;
          default:
            if (/s[1-5]/.test(tag.tag))
              newAttrs['size'] = bbSizeMap[tag.tag]; break; // s1–s5 → em values
        }

        parse(newAttrs);
        const t = peekTag();
        if (t?.closing && t.tag === tag.tag) pos += t.len;
      }
    }
  }

  parse({});
  return ops;
}

@Component({
  selector: 'chat-message-entry',
  imports: [ConfirmDialogModule, ColorSelector, FormsModule, PickerComponent, QuillModule],
  templateUrl: './message-entry.html',
  styleUrl: './message-entry.scss',
})
export class MessageEntry implements OnInit{
  protected kaomoji = kaomoji;

  private _color = 0;
  private currentUpload: FileUploadEvent;
  private editId = 0;
  private quill: Quill;
  private savedColor = 0;

  protected busy = signal(false);
  protected busyTimer: any;
  protected canCancelUpload = signal(false);
  protected editMode = signal(false);
  protected editTime = signal('');
  protected externalUploader = signal(useExternalUploader);
  protected externalUploaderName = signal('External Uploader');
  protected externalUploaderShortName = signal('Ext. Uploader');
  protected filePromptPosition = signal({ top: '0', left: '0' });
  protected kaomojiPosition = signal({ top: '0', left: '0' });
  protected lastSelectedFiles: File[];
  protected lengthWarning = signal(-1);
  protected maxExtFileSizeInMb = signal(200);
  protected maxFileSizeInMb = signal(15000);
  protected pickerPosition = signal({ top: '0', left: '0' });
  protected progress = signal(0);
  protected showEmoji = signal(false);
  protected showFilePrompt = signal(false);
  protected showKaomoji = signal(false);

  protected formats = formats;
  protected modules = {
    clipboard: {
      matchers: [
        [Node.ELEMENT_NODE, (_node: any, delta: any) => {
          delta.ops.forEach((op: any) => {
            forEach(op.attributes, (key, value) => {
              if ((key === 'font' && value !== 'ms-pgothic') || !formatSet.has(key))
                delete op.attributes[key];
            });
          });
          return delta;
        }]
      ]
    },
    keyboard: {
      bindings: {
        enter: {
          key: 'Enter',
          'handler': () => !this.disabled() && this.sendMessage() // eslint-disable-line @stylistic/quote-props
        },
        tab: {
          key: 'Tab',
          'handler': () => true // eslint-disable-line @stylistic/quote-props
        },
        escape: {
          key: 'Escape',
          'handler': () => this.cancelEdit() // eslint-disable-line @stylistic/quote-props
        }
      }
    },
    toolbar: '#my-toolbar',
  };

  darkMode = input(false);
  dmMode = input(false);
  disabled = input(false);
  changeColor = output<number>();
  newMessage = output<string>();
  updateMessage = output<MessageUpdateEvent>();
  uploadFile = output<FileUploadEvent>();

  get color(): number { return this._color; }
  set color(value: number) {
    if (this._color !== value) {
      this._color = value;
      this.updateColor(!this.editMode());
    }
  }

  constructor(private elementRef: ElementRef<HTMLElement>,
              private prefService: PreferencesService,
              private confirmationService: ConfirmationService) {
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
    });

    // Make sure direct user typing clears the kaomoji font.
    document.addEventListener('keydown', evt => {
      if ([...(evt.key || '')].length === 1) {
        const range = this.quill?.getSelection();

        if (range && (this.quill.getFormat(range) || {})['font'])
          this.quill?.format('font', undefined);
      }
    });

    toObservable(this.disabled).subscribe(state => this.quill?.enable(!state));
  }

  ngOnInit(): void {
    const configStr = localStorage.getItem('gchat-config');

    if (configStr) {
      try {
        const config = JSON.parse(configStr) as Config;

        this.externalUploaderName.set(config.externalUploaderName || 'External Uploader');
        this.externalUploaderShortName.set(config.externalUploaderShortName || 'Ext. Uploader');
        this.maxExtFileSizeInMb.set(config.fileSizeLimitExtInMb || 200);
        this.maxFileSizeInMb.set(config.fileSizeLimitInMb || 15000);
      }
      catch {}
    }
  }

  protected editorCreated(quill: Quill): void {
    this.quill = quill;
    quill.enable(!this.disabled());
    quill.setText('');
    this.updateColor(false);

    quill.root.addEventListener('paste', (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;

      if (!items)
        return;

      for (let i = 0; i < items.length; i++) {
        if (/\bimage\b/.test(items[i].type)) {
          e.preventDefault();
          const blob = items[i].getAsFile();
          const maxSize = this.externalUploader() ? this.maxExtFileSizeInMb() : this.maxFileSizeInMb();

          if (blob?.size > maxSize * MB)
            notify('error', `Image too big. Maximum size is ${maxSize} MB.`);
          else if (blob) {
            this.insertFile(blob);
            break;
          }
        }
      }
    });

    quill.root.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      this.processFiles(Array.from(e.dataTransfer?.files));
    });

    quill.on('text-change', () => {
      if (quill.getLength() > INPUT_LENGTH_LIMIT)
        quill.deleteText(INPUT_LENGTH_LIMIT, quill.getLength());

      if (quill.getLength() > INPUT_LENGTH_WARN)
        this.lengthWarning.set(INPUT_LENGTH_LIMIT - quill.getLength() + 1);
      else
        this.lengthWarning.set(-1);
    });
  }

  private processFiles(files: File[]): void {
    if (!files)
      return;

    const uploads: File[] = [];
    let tooBig = false;
    const maxSize = this.externalUploader() ? this.maxExtFileSizeInMb() : this.maxFileSizeInMb();

    for (let i = 0; i < files.length; i++) {
      if (files[i].size > maxSize * MB)
        tooBig = true;
      else if (allowedExtensions.test(files[i].name))
        uploads.push(files[i]);
    }

    if (tooBig)
      notify('error', `File too big. Maximum size is ${maxSize} MB.`);
    else if (uploads.length === 1 && !tooBig)
      this.insertFile(uploads[0]);
    else if (uploads.length > 1)
      notify('error', 'Only one file can be sent at a time.');
    else if (files.length > 0)
      notify('error', 'File type is not supported.');
  }

  private insertFile(file: File): void {
    this.canCancelUpload.set(false);
    this.currentUpload ={
      external: this.externalUploader(),
      file,
      finished: () => {
        if (this.busyTimer) {
          clearTimeout(this.busyTimer);
          this.busyTimer = undefined;
        }

        this.busy.set(false);
        this.canCancelUpload.set(false);
      },
      quill: this.quill,
      started: () => {
        this.busyTimer = setTimeout(() => {
          if (this.busyTimer) {
            clearTimeout(this.busyTimer);
            this.busyTimer = undefined;
          }

          if (this.currentUpload.interrupt)
            this.canCancelUpload.set(true);

          this.busy.set(true);
        }, 3000);
      }
    };

    this.uploadFile.emit(this.currentUpload);
  }

  protected cancelUpload(): void {
    this.confirmationService.confirm({
      key: 'messageEntry',
      message: 'Are you sure you want to cancel this upload?',
      header: 'Cancel Upload',
      icon: 'pi pi-info-circle',
      rejectLabel: 'No, keep uploading',
      rejectButtonProps: {
        label: 'No, keep uploading',
        severity: 'secondary',
        outlined: true
      },
      acceptButtonProps: {
        label: 'Cancel upload',
        severity: 'danger'
      },
      accept: () => {
        if (this.currentUpload.interrupt) {
          this.currentUpload.interrupt();
          this.canCancelUpload.set(false);
          this.busy.set(false);
          this.currentUpload = undefined;
        }
      },
      reject: () => {}
    })
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
      const savedSelection = this.quill.getSelection();
      const content = this.quill.getContents();

      this.quill.root.style.color = colorByIndex(this.color, this.darkMode());
      this.quill.root.style.backgroundColor = getTextBackground(this.quill.root.style.color);
      this.quill.setText('');
      this.quill.setContents(content);
      this.quill.setSelection(savedSelection);
    }
  }

  setProgress(progress: number): void {
    this.progress.set(progress);
  }

  sendMessage(): void {
    if (this.editMode())
      return;

    const message = quillOpsToBBCode(this.quill.getContents().ops);

    this.newMessage.emit(message.replace(/◀︎/g, '◁'));
  }

  reset(): void {
    this.quill.setText('');
    this.focus();
  }

  getText(): string {
    return this.quill?.getText() ?? '';
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

  protected toggleExternalUploader(): void {
    const prefs = this.prefService.get();

    if (!this.externalUploader() || prefs.suppressExternalUploadWarning) {
      useExternalUploader = this.externalUploader();
      return;
    }

    this.confirmationService.confirm({
      key: 'messageEntry',
      message: `This option sends your uploads to ${this.externalUploaderName()}.<br><br>\n` +
        'This provides greater privacy for your shared files, but a smaller maximum file ' +
        `size of ${this.maxExtFileSizeInMb()} MB. You also must abide by the ` +
        `${this.externalUploaderName()} terms of service.`,
          header: `Uploading to ${this.externalUploaderName()}`,
          icon: 'pi pi-info-circle',
          rejectLabel: 'Cancel',
          rejectButtonProps: {
            label: 'Cancel',
            severity: 'secondary',
            outlined: true
          },
          acceptButtonProps: {
            label: 'Continue',
            severity: 'success'
          },
          accept: () => {
            useExternalUploader = prefs.suppressExternalUploadWarning = true;
            this.prefService.set(prefs);
          },
          reject: () => this.externalUploader.set(false)
        })
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

    if (!this.dmMode()) {
      this.quill.insertText(index, name, { underline: true });
      index += name.length;
      this.quill.insertText(index, QUOTE_NAME_DELIM, { underline: false });
      index += QUOTE_NAME_DELIM.length;
    }

    const parts = quote.split(kaomojiRegex);

    for (let i = 0; i < parts.length; ++i) {
      const part = parts[i];

      if (!part)
        continue;

      this.quill.insertText(index, part, i % 2 === 0 ? { italic: true } : { font: 'ms-pgothic' });
      index += part.length;
    }

    this.quill.insertText(index, QUOTE_MARKER, { italic: false });
    index += QUOTE_MARKER.length;
    this.quill.setSelection(index);
  }

  editMessage(evt: EditEvent): void {
    this.editId = evt.msgId;
    this.savedColor = this.color;
    this.editMode.set(true);
    this.color = evt.color;
    this.editTime.set(evt.time);
    this.quill.setContents(bbCodeToQuillOps(evt.bbCode));
  }

  cancelEdit(): void {
    if (!this.editMode())
      return;

    this.editMode.set(false);
    this.editTime.set('');
    this.color = this.savedColor;
    this.quill.setText('');
  }

  protected saveEdit(): void {
    this.updateMessage.emit({
      bbCode: quillOpsToBBCode(this.quill.getContents().ops),
      color: this.color,
      msgId: this.editId,
      callback: (success) => {
        if (success)
          this.cancelEdit();
      }
    })
  }

  protected insertKaomoji(text: string): void {
    const range = this.quill.selection.savedRange;

    if (range.length > 0)
      this.quill.deleteText(range.index, range.length);

    text = '\u2000' + text + '\u2000';
    this.quill.insertText(range.index, text, { font: 'ms-pgothic' });
    this.quill.setSelection(range.index + text.length);
    this.quill.format('font', undefined);
    this.showKaomoji.set(false);
  }
}
